import { randomBytes, randomUUID } from 'node:crypto';
import type { APIGatewayProxyResult } from 'aws-lambda';
import { z } from 'zod';
import {
  ACCESS_MODES,
  hashApiKey,
  RATE_LIMIT_REQUESTS_MAX,
  RATE_LIMIT_REQUESTS_MIN,
  RATE_LIMIT_WINDOW_SECONDS_MAX,
  RATE_LIMIT_WINDOW_SECONDS_MIN,
  rateLimitSchema,
  systemClock,
  type AccessConfigWriter,
  type AccessMode,
  type ApiKeyAdminStore,
  type ApiKeyRecord,
  type Clock,
  type RateLimit,
} from '@open-estate/core';
import { err, ok, toApiErrors, type ApiError, type Result } from '@open-estate/shared';
import {
  badRequest,
  errorResponse,
  json,
  notFound,
  type Route,
  type RouteContext,
} from './admin-http';
import type { AuditLog } from './audit-log';
import { createDeletionRoutes, type DeletionAdminDeps } from './deletion-routes';

/**
 * Fields the handler reads from an API Gateway REST proxy event (`AWS_IAM` authorization).
 * Any `APIGatewayProxyEvent` satisfies this.
 */
export interface AdminRequest {
  httpMethod: string;
  path: string;
  body: string | null;
  isBase64Encoded?: boolean;
  requestContext: { identity: { userArn: string | null } };
}

export type AdminHandler = (event: AdminRequest) => Promise<APIGatewayProxyResult>;

export interface GeneratedApiKey {
  keyId: string;
  /** Plain key; returned exactly once in the create response and never stored. */
  apiKey: string;
}

/** Bytes of entropy per API key (256 bit). */
export const API_KEY_BYTES = 32;

/** Cryptographically secure key (base64url, 43 chars) with a random UUID as id. */
export function generateApiKey(): GeneratedApiKey {
  return { keyId: randomUUID(), apiKey: randomBytes(API_KEY_BYTES).toString('base64url') };
}

export interface AdminHandlerDeps {
  apiKeys: ApiKeyAdminStore;
  accessConfig: AccessConfigWriter;
  audit: AuditLog;
  /** Deletion requests and blocklist (Req 18.4–18.9). */
  deletions: DeletionAdminDeps;
  clock?: Clock;
  generateKey?: () => GeneratedApiKey;
}

/** `action` values of `access-config` audit entries. */
export type AccessConfigAction =
  | 'api-key.created'
  | 'api-key.revoked'
  | 'api-key.rate-limit-set'
  | 'rate-limit.set'
  | 'access-mode.set';

/** Key record as returned by the Admin-API: never the hash. */
export type PublicApiKey = Omit<ApiKeyRecord, 'keyHash'>;

const KEY_ID = '([A-Za-z0-9_-]{1,128})';

const RATE_LIMIT_RANGES = {
  requests: [RATE_LIMIT_REQUESTS_MIN, RATE_LIMIT_REQUESTS_MAX],
  windowSeconds: [RATE_LIMIT_WINDOW_SECONDS_MIN, RATE_LIMIT_WINDOW_SECONDS_MAX],
} as const;

const strictRateLimitSchema = z.strictObject(rateLimitSchema.shape);
const createKeySchema = z.strictObject({
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  rateLimit: z.unknown().optional(),
});
const accessModeSchema = z.strictObject({ mode: z.enum(ACCESS_MODES) });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const describeValue = (value: unknown): string =>
  value === undefined ? 'missing' : JSON.stringify(value);

/**
 * Validates a rate limit with `rateLimitSchema` (Req 17.1, 17.6). Every invalid value yields
 * `INVALID_RATE_LIMIT` naming the field and the rejected value (Req 17.8); unknown fields yield
 * `INVALID_PARAMETER`.
 */
export function validateRateLimit(input: unknown, fieldPrefix = ''): Result<RateLimit, ApiError[]> {
  const result = strictRateLimitSchema.safeParse(input);
  if (result.success) return ok(result.data);

  const fieldOf = (name: string) => (fieldPrefix === '' ? name : `${fieldPrefix}.${name}`);
  const errors = new Map<string, ApiError>();
  for (const issue of result.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const field = fieldOf(key);
        errors.set(field, { code: 'INVALID_PARAMETER', message: `Unknown field ${field}`, field });
      }
      continue;
    }
    const name = issue.path[0];
    if ((name === 'requests' || name === 'windowSeconds') && isObject(input)) {
      const [min, max] = RATE_LIMIT_RANGES[name];
      const field = fieldOf(name);
      const value = input[name];
      errors.set(field, {
        code: 'INVALID_RATE_LIMIT',
        message: `${field} must be an integer between ${min} and ${max}; got ${describeValue(value)}`,
        field,
        ...(value !== undefined && { details: { value } }),
      });
    } else {
      errors.set(fieldPrefix, {
        code: 'INVALID_RATE_LIMIT',
        message: `${fieldPrefix || 'Rate limit'} must be an object {requests, windowSeconds}; got ${describeValue(input)}`,
        ...(fieldPrefix !== '' && { field: fieldPrefix }),
        details: { value: input },
      });
    }
  }
  return err([...errors.values()]);
}

/** Missing/empty body → `{}`; anything but a JSON object → `INVALID_PARAMETER` on `body`. */
function parseBody(event: AdminRequest): Result<unknown, ApiError[]> {
  const raw =
    event.body === null
      ? ''
      : event.isBase64Encoded === true
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;
  if (raw.trim() === '') return ok({});
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isObject(parsed)) return ok(parsed);
  } catch {
    // fall through
  }
  return err([{ code: 'INVALID_PARAMETER', message: 'Body must be a JSON object', field: 'body' }]);
}

function toPublicKey(record: ApiKeyRecord): PublicApiKey {
  const { keyId, status, expiresAt, rateLimit } = record;
  return {
    keyId,
    status,
    ...(expiresAt !== undefined && { expiresAt }),
    ...(rateLimit !== undefined && { rateLimit }),
  };
}

function matchRoute(
  routes: readonly Route[],
  method: string,
  path: string,
): { route: Route; params: string[] } | undefined {
  for (const route of routes) {
    const match = route.method === method ? route.pattern.exec(path) : null;
    if (match !== null) return { route, params: match.slice(1) };
  }
  return undefined;
}

const normalizePath = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/**
 * Admin-API for API keys, rate limits and access mode (Req 17.4, 17.6, 17.8, 17.9) and for
 * deletion requests and the deletion blocklist (Req 18.4–18.9, see `deletion-routes`).
 *
 * - Identity is the IAM `userArn`; without it every request is rejected with 403 `FORBIDDEN`
 *   (defense in depth behind the gateway's `AWS_IAM` authorization), before routing.
 * - Unknown path or method → 404 `NOT_FOUND` (the catalog has no 405 code; a route is
 *   method + path).
 * - Invalid input is rejected before anything is written, so the previous configuration stays.
 * - Changes reach API/MCP within the AccessGuard's 60-s cache TTL (Req 17.9).
 * - Each successful change is recorded as `access-config` audit entry without secrets.
 */
export function createAdminHandler(deps: AdminHandlerDeps): AdminHandler {
  const clock = deps.clock ?? systemClock;
  const generateKey = deps.generateKey ?? generateApiKey;

  const audit = (actor: string, action: AccessConfigAction, details: Record<string, unknown>) =>
    deps.audit.append({
      type: 'access-config',
      action,
      actor,
      at: new Date(clock()).toISOString(),
      details,
    });

  async function createKey({ actor, body }: RouteContext) {
    const parsed = createKeySchema.safeParse(body);
    if (!parsed.success) return badRequest(toApiErrors(parsed.error.issues));
    const { expiresAt, rateLimit: rawLimit } = parsed.data;

    let rateLimit: RateLimit | undefined;
    if (rawLimit !== undefined) {
      const limit = validateRateLimit(rawLimit, 'rateLimit');
      if (!limit.ok) return badRequest(limit.error);
      rateLimit = limit.value;
    }
    const expiry = expiresAt === undefined ? undefined : Date.parse(expiresAt);
    if (expiry !== undefined && expiry <= clock()) {
      return badRequest([
        {
          code: 'INVALID_PARAMETER',
          message: 'expiresAt must be in the future',
          field: 'expiresAt',
        },
      ]);
    }

    const { keyId, apiKey } = generateKey();
    const record: ApiKeyRecord = {
      keyId,
      keyHash: hashApiKey(apiKey),
      status: 'active',
      ...(expiry !== undefined && { expiresAt: new Date(expiry).toISOString() }),
      ...(rateLimit !== undefined && { rateLimit }),
    };
    await deps.apiKeys.create(record);
    const key = toPublicKey(record);
    await audit(actor, 'api-key.created', { ...key });
    return json(201, { ...key, apiKey });
  }

  async function revokeKey({ actor, params: [keyId = ''] }: RouteContext) {
    const record = await deps.apiKeys.revoke(keyId);
    if (record === null) return notFound(`API key ${keyId} not found`);
    await audit(actor, 'api-key.revoked', { keyId });
    return json(200, toPublicKey(record));
  }

  async function setKeyRateLimit({ actor, params: [keyId = ''], body }: RouteContext) {
    const limit = validateRateLimit(body);
    if (!limit.ok) return badRequest(limit.error);
    const record = await deps.apiKeys.setRateLimit(keyId, limit.value);
    if (record === null) return notFound(`API key ${keyId} not found`);
    await audit(actor, 'api-key.rate-limit-set', { keyId, rateLimit: limit.value });
    return json(200, toPublicKey(record));
  }

  async function setGlobalRateLimit({ actor, body }: RouteContext) {
    const limit = validateRateLimit(body);
    if (!limit.ok) return badRequest(limit.error);
    await deps.accessConfig.setRateLimit(limit.value);
    await audit(actor, 'rate-limit.set', { rateLimit: limit.value });
    return json(200, { rateLimit: limit.value });
  }

  async function setAccessMode({ actor, body }: RouteContext) {
    const parsed = accessModeSchema.safeParse(body);
    if (!parsed.success) return badRequest(toApiErrors(parsed.error.issues));
    const mode: AccessMode = parsed.data.mode;
    await deps.accessConfig.setAccessMode(mode);
    await audit(actor, 'access-mode.set', { mode });
    return json(200, { mode });
  }

  const routes: Route[] = [
    { method: 'POST', pattern: /^\/admin\/api-keys$/, handle: createKey },
    { method: 'DELETE', pattern: new RegExp(`^/admin/api-keys/${KEY_ID}$`), handle: revokeKey },
    {
      method: 'PUT',
      pattern: new RegExp(`^/admin/api-keys/${KEY_ID}/rate-limit$`),
      handle: setKeyRateLimit,
    },
    { method: 'PUT', pattern: /^\/admin\/rate-limit$/, handle: setGlobalRateLimit },
    { method: 'PUT', pattern: /^\/admin\/access-mode$/, handle: setAccessMode },
    ...createDeletionRoutes({ ...deps.deletions, audit: deps.audit, clock }),
  ];

  return async (event) => {
    const actor = event.requestContext.identity.userArn?.trim();
    if (actor === undefined || actor === '') {
      return errorResponse('FORBIDDEN', [
        { code: 'FORBIDDEN', message: 'Admin endpoints require IAM authorization' },
      ]);
    }

    const path = normalizePath(event.path);
    const method = event.httpMethod.toUpperCase();
    const found = matchRoute(routes, method, path);
    if (found === undefined) return notFound(`No route ${method} ${path}`);
    const { route, params } = found;

    const body = parseBody(event);
    if (!body.ok) return badRequest(body.error);

    try {
      return await route.handle({ actor, params, body: body.value });
    } catch (cause) {
      // Only the error class: neither request bodies nor keys end up in the log.
      console.error(`${method} ${route.pattern.source}: admin operation failed`, {
        errorName: cause instanceof Error ? cause.name : typeof cause,
      });
      return errorResponse('SERVICE_UNAVAILABLE', [
        {
          code: 'SERVICE_UNAVAILABLE',
          message: 'The admin service is temporarily unavailable. Please retry later.',
        },
      ]);
    }
  };
}
