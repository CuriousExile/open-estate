import {
  err,
  ok,
  toApiErrors,
  type ApiError,
  type Principal,
  type Result,
} from '@open-estate/shared';
import type { ZodType } from 'zod';
import { failure, type Reply } from './http';

// Router of the Management_API (design: "Management_API"). One Lambda serves all routes; a route
// is method + path template (`/listings/{id}`). Path parameters, query and body are parsed with
// the route's Zod schemas before the handler runs, so handlers only see validated input; schema
// violations become catalog errors via the shared `toApiErrors` (Req 16.3).

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Validated input of an authenticated route. */
export interface RouteContext<P, Q, B> {
  principal: Principal;
  params: P;
  query: Q;
  body: B;
  /** Aborted when the request deadline (4.5 s) is exceeded; pass it to downstream calls. */
  signal: AbortSignal;
}

/** Validated input of a public route (no authentication, e.g. `/openapi.json`). */
export type PublicRouteContext<P, Q, B> = Omit<RouteContext<P, Q, B>, 'principal'>;

interface RouteSchemas<P, Q, B> {
  /** Path parameters by template name; strings as matched (URL-decoded). */
  params?: ZodType<P>;
  /** Query string parameters (single values). */
  query?: ZodType<Q>;
  /** JSON body; a missing or empty body is parsed as `undefined`. */
  body?: ZodType<B>;
}

export interface RouteSpec<P, Q, B> extends RouteSchemas<P, Q, B> {
  method: HttpMethod;
  /** Path template without stage, e.g. `/agencies/{agencyId}/members/{userId}`. */
  path: string;
  handle(ctx: RouteContext<P, Q, B>): Promise<Reply>;
}

export interface PublicRouteSpec<P, Q, B> extends RouteSchemas<P, Q, B> {
  method: HttpMethod;
  path: string;
  handle(ctx: PublicRouteContext<P, Q, B>): Promise<Reply>;
}

/** Raw input after matching, before validation. */
export interface RawRouteInput {
  params: Record<string, string>;
  query: Record<string, string>;
  /** Body text (already base64-decoded); `''` if absent. */
  body: string;
  signal: AbortSignal;
}

/** Type-erased route as registered in the router. */
export interface Route {
  method: HttpMethod;
  path: string;
  /** `true`: served without authentication and without actor rate limit. */
  public: boolean;
  /** Validates the input and runs the handler; `principal` is `undefined` only for public routes. */
  run(input: RawRouteInput, principal: Principal | undefined): Promise<Reply>;
}

const isEmpty = (value: string) => value.trim() === '';

function parseJsonBody(raw: string): Result<unknown, ApiError[]> {
  if (isEmpty(raw)) return ok(undefined);
  try {
    return ok(JSON.parse(raw) as unknown);
  } catch {
    return err([{ code: 'INVALID_PARAMETER', message: 'Body must be valid JSON', field: 'body' }]);
  }
}

function parsePart<T>(schema: ZodType<T> | undefined, value: unknown): Result<T, ApiError[]> {
  if (schema === undefined) return ok(value as T);
  const parsed = schema.safeParse(value);
  return parsed.success ? ok(parsed.data) : err(toApiErrors(parsed.error.issues));
}

/** Validates params, query and body; all violations at once (params, then query, then body). */
function parseInput<P, Q, B>(
  schemas: RouteSchemas<P, Q, B>,
  input: RawRouteInput,
): Result<{ params: P; query: Q; body: B }, ApiError[]> {
  const params = parsePart(schemas.params, input.params);
  const query = parsePart(schemas.query, input.query);
  const json = parseJsonBody(input.body);
  const body = json.ok ? parsePart(schemas.body, json.value) : json;
  const errors = [params, query, body].flatMap((part) => (part.ok ? [] : part.error));
  if (!params.ok || !query.ok || !body.ok) return err(errors);
  return ok({ params: params.value, query: query.value, body: body.value });
}

/** Authenticated route (Bearer JWT or machine access). */
export function defineRoute<P = Record<string, string>, Q = Record<string, string>, B = unknown>(
  spec: RouteSpec<P, Q, B>,
): Route {
  return {
    method: spec.method,
    path: spec.path,
    public: false,
    async run(input, principal) {
      if (principal === undefined) throw new Error(`${spec.method} ${spec.path}: no principal`);
      const parsed = parseInput(spec, input);
      if (!parsed.ok) return failure(parsed.error);
      return spec.handle({ ...parsed.value, principal, signal: input.signal });
    },
  };
}

/** Public route: no authentication, only the per-IP limit applies. */
export function definePublicRoute<
  P = Record<string, string>,
  Q = Record<string, string>,
  B = unknown,
>(spec: PublicRouteSpec<P, Q, B>): Route {
  return {
    method: spec.method,
    path: spec.path,
    public: true,
    async run(input) {
      const parsed = parseInput(spec, input);
      if (!parsed.ok) return failure(parsed.error);
      return spec.handle({ ...parsed.value, signal: input.signal });
    },
  };
}

export interface RouteMatch {
  route: Route;
  params: Record<string, string>;
}

export interface Router {
  readonly routes: readonly Route[];
  /** Route for method and path (trailing slashes ignored), or `undefined`. */
  match(method: string, path: string): RouteMatch | undefined;
}

const TEMPLATE_PARAM = /^\{([A-Za-z][A-Za-z0-9]*)\}$/;
// One path segment: no `/`, at least one character.
const SEGMENT = '([^/]+)';

interface CompiledRoute {
  route: Route;
  pattern: RegExp;
  names: string[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(route: Route): CompiledRoute {
  if (!route.path.startsWith('/')) throw new Error(`Route path must start with '/': ${route.path}`);
  const names: string[] = [];
  const source = route.path
    .split('/')
    .slice(1)
    .map((segment) => {
      const name = TEMPLATE_PARAM.exec(segment)?.[1];
      if (name === undefined) return escapeRegExp(segment);
      if (names.includes(name)) throw new Error(`Duplicate parameter {${name}} in ${route.path}`);
      names.push(name);
      return SEGMENT;
    })
    .join('/');
  return { route, pattern: new RegExp(`^/${source}$`), names };
}

const normalizePath = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** Template shape for conflict detection: `/listings/{}/versions`. */
const shapeOf = (path: string) =>
  path
    .split('/')
    .map((segment) => (TEMPLATE_PARAM.test(segment) ? '{}' : segment))
    .join('/');

/** At the first segment where one template has a literal and the other a parameter, the literal wins. */
function bySpecificity(a: string, b: string): number {
  const sa = a.split('/');
  const sb = b.split('/');
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    const pa = TEMPLATE_PARAM.test(sa[i] ?? '');
    const pb = TEMPLATE_PARAM.test(sb[i] ?? '');
    if (pa !== pb) return pa ? 1 : -1;
  }
  return 0;
}

/**
 * Builds the router. Literal segments take precedence over parameters (`/listings/by-custom-id/x`
 * never reaches `/listings/{id}/{…}`) because more specific routes are tried first. Two routes with the
 * same method and template shape are a programming error and throw at init.
 */
export function createRouter(routes: readonly Route[]): Router {
  const seen = new Set<string>();
  for (const route of routes) {
    const key = `${route.method} ${shapeOf(route.path)}`;
    if (seen.has(key)) throw new Error(`Duplicate route ${key}`);
    seen.add(key);
  }
  const compiled = routes.map(compile).sort((a, b) => bySpecificity(a.route.path, b.route.path));

  return {
    routes,
    match(method, path) {
      const normalized = normalizePath(path);
      const upper = method.toUpperCase();
      for (const { route, pattern, names } of compiled) {
        if (route.method !== upper) continue;
        const found = pattern.exec(normalized);
        if (found === null) continue;
        const params: Record<string, string> = {};
        let valid = true;
        names.forEach((name, index) => {
          const value = decode(found[index + 1] ?? '');
          if (value === undefined) valid = false;
          else params[name] = value;
        });
        if (valid) return { route, params };
      }
      return undefined;
    },
  };
}
