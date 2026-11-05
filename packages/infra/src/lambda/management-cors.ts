import type { ManagementHandler, ManagementRequest } from '@open-estate/management';

// CORS of the Management_API (design: "Management-Zugang": CORS with `Authorization`). A REST API
// with Lambda proxy integration cannot add headers to the function's responses, so the Lambda
// entry of the ManagementStack wraps the management handler: preflights of allowed origins are
// answered without touching the handler (no authentication, no audit), every other response of an
// allowed origin gets `Access-Control-Allow-Origin`. The allowlist is static per deployment (the
// CloudFront origin of the SPA plus `corsAllowedOrigins`), so it needs no SSM lookup.

/** Environment variable with the comma-separated allowed origins (set by the ManagementStack). */
export const MANAGEMENT_CORS_ENV = 'MANAGEMENT_CORS_ALLOWED_ORIGINS';

/** Methods of the router (`HTTP_METHODS` of the management package) plus the preflight. */
export const MANAGEMENT_CORS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
/** Request headers the portal sends: the bearer token and JSON bodies. */
export const MANAGEMENT_CORS_REQUEST_HEADERS = ['Authorization', 'Content-Type'];
/** Response headers the portal may read besides the CORS-safelisted ones (429 handling). */
export const MANAGEMENT_CORS_EXPOSED_HEADERS = ['Retry-After'];
/** Browsers cache a preflight at most this long (Chromium caps at 7200 s). */
export const MANAGEMENT_CORS_MAX_AGE_SECONDS = 600;

/** Comma-separated origins → trimmed list without empty entries and trailing slashes. */
export function parseAllowedOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin !== '');
}

/** Case-insensitive header lookup (API Gateway passes the client's spelling). */
function header(request: ManagementRequest, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * Wraps `handler` with the CORS policy of `allowedOrigins`. Origins are compared exactly (the
 * browser sends the serialized origin); a request without an allowed `Origin` passes through
 * unchanged (machine clients, other sites — the browser then blocks the response).
 */
export function withManagementCors(
  handler: ManagementHandler,
  allowedOrigins: readonly string[],
): ManagementHandler {
  const allowed = new Set(allowedOrigins);
  return async (request) => {
    const origin = header(request, 'Origin');
    const corsOrigin = origin !== undefined && allowed.has(origin) ? origin : undefined;
    if (request.httpMethod === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: {
          Vary: 'Origin',
          'Cache-Control': 'no-store',
          ...(corsOrigin !== undefined && {
            'Access-Control-Allow-Origin': corsOrigin,
            'Access-Control-Allow-Methods': MANAGEMENT_CORS_METHODS.join(', '),
            'Access-Control-Allow-Headers': MANAGEMENT_CORS_REQUEST_HEADERS.join(', '),
            'Access-Control-Max-Age': String(MANAGEMENT_CORS_MAX_AGE_SECONDS),
          }),
        },
        body: '',
      };
    }
    const response = await handler(request);
    return {
      ...response,
      headers: {
        ...response.headers,
        Vary: 'Origin',
        ...(corsOrigin !== undefined && {
          'Access-Control-Allow-Origin': corsOrigin,
          'Access-Control-Expose-Headers': MANAGEMENT_CORS_EXPOSED_HEADERS.join(', '),
        }),
      },
    };
  };
}
