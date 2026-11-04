// Framework-free Search_API client (design: Frontend → ApiClient; Req 7.7, 13.10).
// Kept free of Angular imports so it can be unit-tested with plain Jest.
import {
  ERROR_CODES,
  type ApiError,
  type ErrorCode,
  type LocalizedListing,
  type OfferType,
  type Result,
} from '@open-estate/shared';

/** Abort the request if Search_API has not answered (incl. body) within this time (Req 7.7). */
export const API_TIMEOUT_MS = 10_000;

/** Minimal response surface used by the client; the browser `Response` satisfies it. */
export interface FetchResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Minimal `fetch` signature; `globalThis.fetch` satisfies it. */
export type FetchFn = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal },
) => Promise<FetchResponse>;

/**
 * Filters of `GET /listings` in their API representation (design: Search_API). Decimal values are
 * strings so no float rounding happens on the way; `lang` is never passed here — the client always
 * sets it from the active locale (Req 13.10).
 */
export interface SearchParams {
  offerType?: OfferType;
  priceMin?: string;
  priceMax?: string;
  currency?: string;
  roomsMin?: string;
  roomsMax?: string;
  areaMin?: string;
  areaMax?: string;
  city?: string;
  postalCode?: string;
  group?: string;
  types?: readonly string[];
  hasTour?: boolean;
  pageSize?: number;
  pageToken?: string;
}

/** Response of `GET /listings`. */
export interface SearchPage {
  items: LocalizedListing[];
  nextPageToken?: string;
}

/** Structured failure; the client never throws to its callers. */
export type ClientError =
  /** Search_API answered with a non-2xx status; `errors` from the `ErrorResponse` body (may be empty). */
  | { kind: 'api'; status: number; errors: ApiError[]; retryAfterSeconds?: number }
  /** No complete answer within `timeoutMs` (Req 7.7). */
  | { kind: 'timeout'; timeoutMs: number }
  /** Request could not be sent or the body could not be read (offline, DNS, CORS, …). */
  | { kind: 'network'; message: string }
  /** 2xx answer whose body is not valid JSON or not of the expected shape. */
  | { kind: 'invalid-response'; status: number; message: string }
  /** Cancelled by the caller's `AbortSignal` (e.g. a newer search replaced this one). */
  | { kind: 'aborted' };

export type ApiResult<T> = Result<T, ClientError>;

export interface RequestOptions {
  /** Aborting it cancels the request; the result is then `{ kind: 'aborted' }`. */
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  /** `apiBaseUrl` from `runtime-config.json`. */
  baseUrl: string;
  fetch: FetchFn;
  /** Active locale at call time; sent as `lang` on every request (Req 13.10). */
  getLocale: () => string;
  timeoutMs?: number;
}

export interface ApiClient {
  searchListings(params: SearchParams, options?: RequestOptions): Promise<ApiResult<SearchPage>>;
  getListing(id: string, options?: RequestOptions): Promise<ApiResult<LocalizedListing>>;
  /** Raw `/meta` (taxonomy, locales, tour providers); validated by its consumers. */
  getMeta(options?: RequestOptions): Promise<ApiResult<unknown>>;
}

type QueryValue = string | number | boolean | readonly string[] | undefined;

const SEARCH_PARAM_ORDER = [
  'offerType',
  'priceMin',
  'priceMax',
  'currency',
  'roomsMin',
  'roomsMax',
  'areaMin',
  'areaMax',
  'city',
  'postalCode',
  'group',
  'types',
  'hasTour',
  'pageSize',
  'pageToken',
] as const satisfies readonly (keyof SearchParams)[];

/**
 * Query string with `%20`-style encoding (no `+`, which gateways may not decode as space).
 * Arrays become repeated parameters; `undefined` and empty strings are omitted.
 */
export function buildQuery(entries: readonly (readonly [string, QueryValue])[]): string {
  const parts: string[] = [];
  for (const [key, value] of entries) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === undefined || item === '') continue;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
    }
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Catalog entries of an `ErrorResponse`; malformed entries and unknown codes are dropped. */
function parseApiErrors(body: unknown): ApiError[] {
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

/** `retryAfterSeconds` from the body, else the `Retry-After` header (delta-seconds). */
function parseRetryAfter(body: unknown, header: string | null): number | undefined {
  const fromBody = isRecord(body) ? body['retryAfterSeconds'] : undefined;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0) return fromBody;
  if (header !== null && /^\d+$/.test(header.trim())) return Number(header.trim());
  return undefined;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Shallow shape checks — enough to render safely; full validation is the API's job. */
function isListing(value: unknown): value is LocalizedListing {
  return isRecord(value) && typeof value['id'] === 'string';
}

function isSearchPage(value: unknown): value is SearchPage {
  return (
    isRecord(value) &&
    Array.isArray(value['items']) &&
    value['items'].every(isListing) &&
    (value['nextPageToken'] === undefined || typeof value['nextPageToken'] === 'string')
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const { fetch, getLocale, timeoutMs = API_TIMEOUT_MS } = options;
  const base = options.baseUrl.replace(/\/+$/, '');

  async function request<T>(
    path: string,
    query: readonly (readonly [string, QueryValue])[],
    isValid: (value: unknown) => value is T,
    { signal }: RequestOptions = {},
  ): Promise<ApiResult<T>> {
    if (signal?.aborted) return { ok: false, error: { kind: 'aborted' } };

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });

    // Classifies a rejection of fetch() or of reading the body.
    const failure = (error: unknown): ApiResult<T> => {
      if (timedOut) return { ok: false, error: { kind: 'timeout', timeoutMs } };
      if (signal?.aborted) return { ok: false, error: { kind: 'aborted' } };
      return { ok: false, error: { kind: 'network', message: errorText(error) } };
    };

    try {
      let status: number;
      let retryAfterHeader: string | null;
      let text: string;
      try {
        const url = `${base}${path}${buildQuery([...query, ['lang', getLocale()]])}`;
        const response = await fetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        status = response.status;
        retryAfterHeader = response.headers.get('Retry-After');
        text = await response.text(); // still covered by the timeout
      } catch (error) {
        return failure(error);
      }

      const body = parseJson(text);
      if (status < 200 || status > 299) {
        const value = body.ok ? body.value : undefined;
        const retryAfterSeconds =
          status === 429 ? parseRetryAfter(value, retryAfterHeader) : undefined;
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
      if (!body.ok) {
        return {
          ok: false,
          error: { kind: 'invalid-response', status, message: 'Response body is not valid JSON' },
        };
      }
      if (!isValid(body.value)) {
        return {
          ok: false,
          error: { kind: 'invalid-response', status, message: 'Unexpected response shape' },
        };
      }
      return { ok: true, value: body.value };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  const anyJson = (value: unknown): value is unknown => value !== undefined;

  return {
    searchListings: (params, opts) =>
      request(
        '/listings',
        SEARCH_PARAM_ORDER.map((key) => [key, params[key]] as const),
        isSearchPage,
        opts,
      ),
    getListing: (id, opts) => request(`/listings/${encodeURIComponent(id)}`, [], isListing, opts),
    getMeta: (opts) => request('/meta', [], anyJson, opts),
  };
}
