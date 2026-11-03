import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { AccessGuard, SearchService } from '@open-estate/core';
import {
  ERROR_HTTP_STATUS,
  parseSearchQuery,
  resolvePreferences,
  type ApiError,
  type ErrorCode,
  type ErrorResponse,
  type Schemas,
} from '@open-estate/shared';
import { logger } from './observability';

// `GET /listings` (design: "Search_API", "Request-Pfade"): AccessGuard → parseSearchQuery →
// language preferences → SearchService (serializes per listing) → `{ items, nextPageToken? }`.
// Also hosts the helpers shared by all Search_API routes (errors, query/header access, guard).

/** The parts of an API Gateway REST proxy event the handler reads. */
export interface ListingsRequest {
  /** `GET`, or `OPTIONS` for a CORS preflight (answered by `withCors`). */
  httpMethod?: string;
  queryStringParameters?: APIGatewayProxyEvent['queryStringParameters'];
  multiValueQueryStringParameters?: APIGatewayProxyEvent['multiValueQueryStringParameters'];
  headers?: APIGatewayProxyEvent['headers'];
  multiValueHeaders?: APIGatewayProxyEvent['multiValueHeaders'];
  /** API Gateway resource template (e.g. `/listings/{id}`); selects the route. */
  resource?: string;
  pathParameters?: APIGatewayProxyEvent['pathParameters'];
  requestContext: { identity: { sourceIp: string } };
}

export type ListingsHandler = (event: ListingsRequest) => Promise<APIGatewayProxyResult>;

export interface ListingsHandlerDeps {
  guard: AccessGuard;
  /** Built once at init from the loaded taxonomy and locales. */
  schemas: Schemas;
  search: SearchService;
}

const CONTENT_TYPE = 'application/json; charset=utf-8';

const SERVICE_UNAVAILABLE: ApiError = {
  code: 'SERVICE_UNAVAILABLE',
  message: 'The search service is temporarily unavailable. Please retry later.',
};

/** HTTP status of a catalog code; `UNKNOWN_TOOL` (JSON-RPC only) never reaches this adapter. */
function httpStatus(code: ErrorCode): number {
  return code in ERROR_HTTP_STATUS
    ? ERROR_HTTP_STATUS[code as keyof typeof ERROR_HTTP_STATUS]
    : 503;
}

/**
 * Status of an error list: 400 as soon as one validation error is present (all request-validation
 * codes map to 400), otherwise the status of the first error. Guard and service errors are single.
 */
export function errorStatus(errors: readonly ApiError[]): number {
  const statuses = errors.map((e) => httpStatus(e.code));
  return statuses.includes(400) ? 400 : (statuses[0] ?? 503);
}

function json(statusCode: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    statusCode,
    headers: { 'Content-Type': CONTENT_TYPE, ...headers },
    body: JSON.stringify(body),
  };
}

/** Error response (Req 3.4); 429 adds `Retry-After` and `retryAfterSeconds` (Req 17.2). */
export function errorResponse(errors: readonly ApiError[]): APIGatewayProxyResult {
  const retryAfter = errors.find((e) => e.code === 'RATE_LIMITED')?.details?.['retryAfterSeconds'];
  const body: ErrorResponse = {
    errors: [...errors],
    ...(typeof retryAfter === 'number' && { retryAfterSeconds: retryAfter }),
  };
  return json(errorStatus(errors), body, {
    'Cache-Control': 'no-store',
    ...(typeof retryAfter === 'number' && { 'Retry-After': String(retryAfter) }),
  });
}

/** 503 without internal details (Req 9.5, 9.6; also used while the init failed, Req 15.4). */
export function serviceUnavailableResponse(): APIGatewayProxyResult {
  return errorResponse([SERVICE_UNAVAILABLE]);
}

/**
 * Raw query: single values as string, repeated parameters (e.g. `types`) as list. The schema
 * accepts both for code lists and rejects a list for scalar fields (Req 1.9).
 * `Object.fromEntries` defines own properties, so keys like `__proto__` stay plain data.
 */
export function collectQuery(event: ListingsRequest): Record<string, string | string[]> {
  const raw = new Map<string, string | string[]>();
  for (const [key, value] of Object.entries(event.queryStringParameters ?? {})) {
    if (value !== undefined) raw.set(key, value);
  }
  for (const [key, values] of Object.entries(event.multiValueQueryStringParameters ?? {})) {
    if (values === undefined || values.length === 0) continue;
    raw.set(key, values.length === 1 ? (values[0] as string) : [...values]);
  }
  return Object.fromEntries(raw);
}

/** Case-insensitive header lookup; repeated headers are joined with `, ` (RFC 9110 5.3). */
export function headerValue(event: ListingsRequest, name: string): string | undefined {
  const lower = name.toLowerCase();
  const matches = <T>(entries: Record<string, T | undefined> | null | undefined) =>
    Object.entries(entries ?? {}).find(([key]) => key.toLowerCase() === lower)?.[1];
  const multi = matches(event.multiValueHeaders);
  if (multi !== undefined && multi.length > 0) return multi.join(', ');
  return matches(event.headers);
}

/**
 * Common frame of all public Search_API routes: AccessGuard first (401/429 with `Retry-After`,
 * Req 17.2, 17.5), then the route logic. Any exception (guard stores, access config, provider:
 * ServiceUnavailableError or otherwise) becomes 503 without details; the log carries only the
 * route and the error class, never request values (Req 9.5, 9.6, 18.2).
 */
export function guardedRoute(
  route: string,
  guard: AccessGuard,
  /** Route logic after admission; may throw on downstream failure. */
  handle: ListingsHandler,
): ListingsHandler {
  return async (event) => {
    try {
      const admission = await guard.admit({
        sourceIp: event.requestContext.identity.sourceIp,
        authorization: headerValue(event, 'Authorization'),
      });
      if (!admission.ok) return errorResponse([admission.error]);
      return await handle(event);
    } catch (cause) {
      logger.error(`${route}: request failed`, {
        errorName: cause instanceof Error ? cause.name : typeof cause,
      });
      return serviceUnavailableResponse();
    }
  };
}

/** Success response of the listing routes. */
export function okResponse(body: unknown): APIGatewayProxyResult {
  return json(200, body);
}

/** `GET /listings`. */
export function createListingsHandler({
  guard,
  schemas,
  search,
}: ListingsHandlerDeps): ListingsHandler {
  return guardedRoute('GET /listings', guard, async (event) => {
    const query = parseSearchQuery(collectQuery(event), schemas);
    if (!query.ok) return errorResponse(query.error);

    // `lang` was validated by the schema and overrides the header; the header never fails.
    const prefs = resolvePreferences({
      lang: query.value.lang,
      acceptLanguage: headerValue(event, 'Accept-Language'),
    });
    if (!prefs.ok) return errorResponse([prefs.error]);

    const page = await search.search(query.value, prefs.value);
    if (!page.ok) return errorResponse(page.error);
    return okResponse(page.value);
  });
}
