import type { APIGatewayProxyResult } from 'aws-lambda';
import { ConfigError, loadConfig, type ConfigSources } from '@open-estate/core';
import { headerValue, type ListingsHandler, type ListingsRequest } from './listings-handler';

// CORS of the Search_API for the SPA on its own origin (design: "Search_API", CORS). Only exact,
// configured origins get `Access-Control-Allow-Origin`; never `*`, never credentials. The SPA
// sends simple GETs (`Accept` only); a preflight only occurs with `Authorization` (API keys).

/** Comma-separated origins from the CDK context `corsAllowedOrigins`, normalized at synth. */
export const CORS_ENV = { allowedOrigins: 'CORS_ALLOWED_ORIGINS' } as const;
/** Resolved by the ConfigProvider (`FRONTEND_ORIGIN_SSM_PARAMETER`, written by the FrontendStack). */
export const CORS_CONFIG_VALUES = { frontendOrigin: 'FRONTEND_ORIGIN' } as const;

/** Request headers a browser may send cross-origin besides the CORS-safelisted ones. */
export const CORS_ALLOWED_HEADERS = ['Authorization', 'Accept-Language'] as const;
export const CORS_ALLOWED_METHODS = ['GET'] as const;
/** Response headers the SPA reads besides the safelisted ones (429 wait time, Req 17.2). */
export const CORS_EXPOSED_HEADERS = ['Retry-After'] as const;
/** Browsers cap this (Chromium: 2 h); one hour keeps preflights rare. */
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 3600;

// `scheme://host[:port]`: no path (not even `/`), query, fragment or userinfo.
const ORIGIN_PATTERN = /^https?:\/\/[^/?#@\s]+$/i;
// Serialized result: DNS name or IPv4 (punycode for IDNs), so it is safe as a header literal.
const SERIALIZED_ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/;

/**
 * Serialized origin (`https://example.com`, lower-case scheme/host, default port dropped) of an
 * `http(s)` origin string, or `undefined` if it is not one (e.g. trailing slash, path, `null`).
 */
export function normalizeOrigin(value: string): string | undefined {
  const raw = value.trim();
  if (!ORIGIN_PATTERN.test(raw)) return undefined;
  try {
    const { origin } = new URL(raw);
    return SERIALIZED_ORIGIN.test(origin) ? origin : undefined;
  } catch {
    return undefined;
  }
}

/** Parses a comma-separated origin list; empty entries are skipped, invalid ones reported. */
export function parseOriginList(raw: string): { origins: string[]; invalid: string[] } {
  const origins: string[] = [];
  const invalid: string[] = [];
  for (const entry of raw.split(',').map((e) => e.trim())) {
    if (entry === '') continue;
    const origin = normalizeOrigin(entry);
    if (origin === undefined) invalid.push(entry);
    else if (!origins.includes(origin)) origins.push(origin);
  }
  return { origins, invalid };
}

/** Allowed browser origins (normalized). Empty: no browser client may read responses. */
export interface CorsPolicy {
  readonly allowedOrigins: ReadonlySet<string>;
}

export const NO_CORS: CorsPolicy = { allowedOrigins: new Set() };

export function createCorsPolicy(origins: Iterable<string>): CorsPolicy {
  return { allowedOrigins: new Set(origins) };
}

/** The request's origin if it is allowed (exact after normalization), else `undefined`. */
export function allowedOrigin(policy: CorsPolicy, event: ListingsRequest): string | undefined {
  const header = headerValue(event, 'Origin');
  const origin = header === undefined ? undefined : normalizeOrigin(header);
  return origin !== undefined && policy.allowedOrigins.has(origin) ? origin : undefined;
}

/** `Vary: Origin` always (responses differ per origin); allow/expose only for allowed origins. */
export function corsHeaders(policy: CorsPolicy, event: ListingsRequest): Record<string, string> {
  const origin = allowedOrigin(policy, event);
  return {
    Vary: 'Origin',
    ...(origin !== undefined && {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Expose-Headers': CORS_EXPOSED_HEADERS.join(', '),
    }),
  };
}

/** Preflight answer: 204; allow headers only for allowed origins (else the browser blocks). */
export function preflightResponse(
  policy: CorsPolicy,
  event: ListingsRequest,
): APIGatewayProxyResult {
  const origin = allowedOrigin(policy, event);
  return {
    statusCode: 204,
    headers: {
      Vary: 'Origin',
      ...(origin !== undefined && {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': CORS_ALLOWED_METHODS.join(', '),
        'Access-Control-Allow-Headers': CORS_ALLOWED_HEADERS.join(', '),
        'Access-Control-Max-Age': String(CORS_PREFLIGHT_MAX_AGE_SECONDS),
      }),
    },
    body: '',
  };
}

/**
 * Outermost frame of the Search_API: answers `OPTIONS` (preflight) without calling `handler` and
 * adds {@link corsHeaders} to every other response (200, 4xx, 429, 503, also while the init
 * failed). `policy` resolves to {@link NO_CORS} if the allowed origins could not be loaded.
 */
export function withCors(
  policy: () => Promise<CorsPolicy>,
  handler: ListingsHandler,
): ListingsHandler {
  return async (event) => {
    const current = await policy();
    if (event.httpMethod === 'OPTIONS') return preflightResponse(current, event);
    const response = await handler(event);
    return { ...response, headers: { ...response.headers, ...corsHeaders(current, event) } };
  };
}

// Names the variable only; the value stays out of the init log.
function invalidOrigins(name: string, invalid: readonly string[]): ConfigError {
  return new ConfigError(
    'CONFIG_INVALID',
    [name],
    // config-check-ignore: format placeholder in an error message, not an endpoint
    [{ path: '', message: `${invalid.length} invalid origin(s), expected https://host[:port]` }],
  );
}

/**
 * Loads the allowed origins: `CORS_ALLOWED_ORIGINS` (optional) plus the frontend origin from
 * `FRONTEND_ORIGIN` (optional: missing until the FrontendStack is deployed). An invalid value
 * throws `ConfigError{CONFIG_INVALID}` naming the variable, never the value; AWS errors propagate.
 */
export async function loadCorsPolicy(
  env: Readonly<Record<string, string | undefined>>,
  sources: ConfigSources = {},
): Promise<CorsPolicy> {
  const extra = parseOriginList(env[CORS_ENV.allowedOrigins] ?? '');
  if (extra.invalid.length > 0) throw invalidOrigins(CORS_ENV.allowedOrigins, extra.invalid);

  const name = CORS_CONFIG_VALUES.frontendOrigin;
  let frontend: string[] = [];
  try {
    const config = await loadConfig({ values: [name] }, { ...sources, env });
    const parsed = parseOriginList(config.requireAll([name])[name] ?? '');
    if (parsed.invalid.length > 0) throw invalidOrigins(name, parsed.invalid);
    frontend = parsed.origins;
  } catch (error) {
    const missing =
      error instanceof ConfigError &&
      error.code === 'CONFIG_MISSING' &&
      error.names.length === 1 &&
      error.names[0] === name;
    if (!missing) throw error;
  }
  return createCorsPolicy([...frontend, ...extra.origins]);
}
