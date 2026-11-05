// Framework-free Management_API client (design: Agentur_Portal → ManagementApiClient; Req 2.3,
// 5.9). Kept free of Angular imports so it can be unit-tested with plain Jest; the Angular facade
// supplies a transport over HttpClient, so the bearer interceptor applies to every call.
import { ERROR_CODES, type ApiError, type ErrorCode, type Result } from '@open-estate/shared';

/** Abort a call if the Management_API has not answered (incl. body) within this time (Req 5.9). */
export const MANAGEMENT_TIMEOUT_MS = 10_000;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface TransportRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  /** Serialized JSON body, if any. */
  body?: string;
  signal: AbortSignal;
}

/** Status, headers and raw body — for 2xx and error statuses alike. */
export interface TransportResponse {
  status: number;
  headers: { get(name: string): string | null };
  text: string;
}

/** Sends a request; rejects only if no HTTP answer arrived (offline, CORS, aborted). */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

/** Structured failure; the client never throws to its callers. */
export type ManagementError =
  /** Non-2xx answer; `errors` from the `ErrorResponse` body (may be empty). */
  | { kind: 'api'; status: number; errors: ApiError[]; retryAfterSeconds?: number }
  /** No complete answer within `timeoutMs` (Req 5.9). */
  | { kind: 'timeout'; timeoutMs: number }
  | { kind: 'network'; message: string }
  /** 2xx answer whose body is not JSON or not of the expected shape. */
  | { kind: 'invalid-response'; status: number; message: string }
  /** Cancelled by the caller's `AbortSignal`. */
  | { kind: 'aborted' }
  /** `runtime-config.json` has no valid `portal` block. */
  | { kind: 'not-configured' };

export type ManagementResult<T> = Result<T, ManagementError>;

type QueryValue = string | number | boolean | readonly string[] | undefined;

export interface ManagementRequestOptions<T> {
  query?: Readonly<Record<string, QueryValue>>;
  /** JSON-serialized request body. */
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  /**
   * Validates/parses the 2xx body (e.g. `(v) => Schema.parse(v)`); a throw yields
   * `invalid-response`. Without it the body is returned as is (`undefined` for an empty body).
   */
  parse?: (value: unknown) => T;
}

export interface ManagementClientOptions {
  /** `portal.managementApiUrl` from `runtime-config.json`. */
  baseUrl: string;
  transport: Transport;
  timeoutMs?: number;
}

export interface ManagementClient {
  request<T = unknown>(
    method: HttpMethod,
    path: string,
    options?: ManagementRequestOptions<T>,
  ): Promise<ManagementResult<T>>;
}

/** Query string with `%20`-style encoding; arrays repeat the parameter, `undefined`/`''` are omitted. */
export function buildQuery(query: Readonly<Record<string, QueryValue>> = {}): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    const values: readonly (string | number | boolean | undefined)[] = Array.isArray(value)
      ? (value as readonly string[])
      : [value as string | number | boolean | undefined];
    for (const item of values) {
      if (item === undefined || item === '') continue;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
    }
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/** Joins base URL and path without duplicate slashes. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Catalog entries of an `ErrorResponse`; malformed entries and unknown codes are dropped. */
export function parseApiErrors(body: unknown): ApiError[] {
  if (!isRecord(body) || !Array.isArray(body['errors'])) return [];
  return body['errors'].flatMap((entry: unknown): ApiError[] => {
    if (!isRecord(entry)) return [];
    const { code, message, field, details } = entry;
    if (typeof code !== 'string' || !ERROR_CODE_SET.has(code) || typeof message !== 'string') {
      return [];
    }
    return [
      {
        code: code as ErrorCode,
        message,
        ...(typeof field === 'string' && { field }),
        ...(isRecord(details) && { details }),
      },
    ];
  });
}

function parseRetryAfter(body: unknown, header: string | null): number | undefined {
  const fromBody = isRecord(body) ? body['retryAfterSeconds'] : undefined;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0) return fromBody;
  if (header !== null && /^\d+$/.test(header.trim())) return Number(header.trim());
  return undefined;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createManagementClient(options: ManagementClientOptions): ManagementClient {
  const { transport, timeoutMs = MANAGEMENT_TIMEOUT_MS } = options;

  async function request<T>(
    method: HttpMethod,
    path: string,
    { query, body, headers, signal, parse }: ManagementRequestOptions<T> = {},
  ): Promise<ManagementResult<T>> {
    if (signal?.aborted) return { ok: false, error: { kind: 'aborted' } };

    const controller = new AbortController();
    let timedOut = false;
    let rejectTimeout: (() => void) | undefined;
    // Rejects even if a transport ignores the abort signal.
    const deadline = new Promise<never>((_, reject) => {
      rejectTimeout = () => reject(new Error('timeout'));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectTimeout?.();
    }, timeoutMs);
    const onCallerAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });

    try {
      let response: TransportResponse;
      try {
        const requestHeaders: Record<string, string> = { Accept: 'application/json', ...headers };
        if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
        response = await Promise.race([
          transport({
            method,
            url: `${joinUrl(options.baseUrl, path)}${buildQuery(query)}`,
            headers: requestHeaders,
            ...(body !== undefined && { body: JSON.stringify(body) }),
            signal: controller.signal,
          }),
          deadline,
        ]);
      } catch (error) {
        if (timedOut) return { ok: false, error: { kind: 'timeout', timeoutMs } };
        if (signal?.aborted) return { ok: false, error: { kind: 'aborted' } };
        return { ok: false, error: { kind: 'network', message: errorText(error) } };
      }

      const { status } = response;
      const json = parseJson(response.text);
      if (status < 200 || status > 299) {
        const value = json.ok ? json.value : undefined;
        const retryAfterSeconds =
          status === 429 ? parseRetryAfter(value, response.headers.get('Retry-After')) : undefined;
        return {
          ok: false,
          error: {
            kind: 'api',
            status,
            errors: parseApiErrors(value),
            ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
          },
        };
      }
      if (!json.ok) {
        return {
          ok: false,
          error: { kind: 'invalid-response', status, message: 'Response body is not valid JSON' },
        };
      }
      if (!parse) return { ok: true, value: json.value as T };
      try {
        return { ok: true, value: parse(json.value) };
      } catch (error) {
        return {
          ok: false,
          error: { kind: 'invalid-response', status, message: errorText(error) },
        };
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  return { request };
}

/** Translation key and parameters of a human-readable message (Req 5.7, 5.9). */
export interface TranslatableMessage {
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

/** Catalog codes with their own portal message; all others fall back to the HTTP status. */
export const MESSAGE_CODES = [
  'AUTH_MISSING',
  'AUTH_INVALID',
  'MACHINE_ACCESS_EXPIRED',
  'AGENCY_SUSPENDED',
  'FORBIDDEN',
  'NOT_FOUND',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'VERSION_CONFLICT',
  'CUSTOM_ID_TAKEN',
  'DELETION_BLOCKED',
  'LAST_AGENCY_ADMIN',
  'LAST_PLATFORM_ADMIN',
  'USER_ALREADY_ASSIGNED',
  'INVALID_PERMISSION',
  'METRIC_NOT_ALLOWED',
  'UNKNOWN_METRIC',
] as const satisfies readonly ErrorCode[];

const MESSAGE_CODE_SET: ReadonlySet<string> = new Set(MESSAGE_CODES);

/** HTTP statuses with their own message; other 4xx → `client`, 5xx → `server`. */
export const MESSAGE_STATUSES = [400, 401, 403, 404, 409, 429] as const;

function statusMessage(status: number, retryAfterSeconds: number | undefined): TranslatableMessage {
  if (status === 429 && retryAfterSeconds !== undefined) {
    return { key: 'portal.error.rateLimitedWait', params: { seconds: retryAfterSeconds } };
  }
  if ((MESSAGE_STATUSES as readonly number[]).includes(status)) {
    return { key: `portal.error.status.${status}` };
  }
  return { key: status >= 500 ? 'portal.error.server' : 'portal.error.client' };
}

/**
 * Human-readable summary of a failed call (Req 5.9); `undefined` for a call the caller cancelled
 * itself. Field-level details stay in `error.errors` for forms.
 */
export function managementErrorMessage(error: ManagementError): TranslatableMessage | undefined {
  switch (error.kind) {
    case 'aborted':
      return undefined;
    case 'timeout':
      return {
        key: 'portal.error.timeout',
        params: { seconds: Math.round(error.timeoutMs / 1000) },
      };
    case 'network':
      return { key: 'portal.error.network' };
    case 'invalid-response':
      return { key: 'portal.error.invalidResponse' };
    case 'not-configured':
      return { key: 'portal.error.notConfigured' };
    case 'api': {
      const code = error.errors[0]?.code;
      if (code === 'RATE_LIMITED' || (code === undefined && error.status === 429)) {
        return statusMessage(429, error.retryAfterSeconds);
      }
      if (code !== undefined && MESSAGE_CODE_SET.has(code))
        return { key: `portal.error.code.${code}` };
      return statusMessage(error.status, error.retryAfterSeconds);
    }
  }
}
