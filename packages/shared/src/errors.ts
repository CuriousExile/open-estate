import type { z } from 'zod';

/**
 * Single error catalog for Search_API, MCP_Server and Admin-API (Req 3.4).
 * Codes and HTTP status follow the "Fehlerkatalog" in design.md.
 */
export const ERROR_CODES = [
  'INVALID_PARAMETER',
  'INVALID_RANGE',
  'INVALID_PAGE_SIZE',
  'INVALID_PAGE_TOKEN',
  'INVALID_OFFER_TYPE',
  'OFFER_TYPE_REQUIRED',
  'CONFLICTING_FILTERS',
  'UNKNOWN_TAXONOMY_CODE',
  'INVALID_FILTER_COUNT',
  'INVALID_LOCALE',
  'INVALID_ID',
  'NOT_FOUND',
  'API_KEY_MISSING',
  'API_KEY_INVALID',
  'FORBIDDEN',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'UNKNOWN_TOOL',
  'DELETION_TARGET_NOT_FOUND',
  'INVALID_RATE_LIMIT',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** HTTP status per code. `UNKNOWN_TOOL` is reported as a JSON-RPC error, not via HTTP status. */
export const ERROR_HTTP_STATUS = {
  INVALID_PARAMETER: 400,
  INVALID_RANGE: 400,
  INVALID_PAGE_SIZE: 400,
  INVALID_PAGE_TOKEN: 400,
  INVALID_OFFER_TYPE: 400,
  OFFER_TYPE_REQUIRED: 400,
  CONFLICTING_FILTERS: 400,
  UNKNOWN_TAXONOMY_CODE: 400,
  INVALID_FILTER_COUNT: 400,
  INVALID_LOCALE: 400,
  INVALID_ID: 400,
  NOT_FOUND: 404,
  API_KEY_MISSING: 401,
  API_KEY_INVALID: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  DELETION_TARGET_NOT_FOUND: 404,
  INVALID_RATE_LIMIT: 400,
} as const satisfies Record<Exclude<ErrorCode, 'UNKNOWN_TOOL'>, number>;

export interface ApiError {
  code: ErrorCode;
  /** Human-readable description of the cause. */
  message: string;
  /** Affected request field, if any. */
  field?: string;
  details?: Record<string, unknown>;
}

export interface ErrorResponse {
  errors: ApiError[];
  retryAfterSeconds?: number;
}

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value);
}

/**
 * Default code for issues of a top-level request field without an explicit code: every
 * violation of these fields maps to the field-specific code, all other fields to
 * `INVALID_PARAMETER` (Req 1.9, 1.11, 2.3, 3.5, 12.12, 14.9).
 */
const FIELD_ERROR_CODES: Readonly<Record<string, ErrorCode>> = {
  pageSize: 'INVALID_PAGE_SIZE',
  pageToken: 'INVALID_PAGE_TOKEN',
  offerType: 'INVALID_OFFER_TYPE',
  lang: 'INVALID_LOCALE',
  id: 'INVALID_ID',
};

/**
 * Parameters a schema can attach to a custom issue (`ctx.addIssue({ code: 'custom', params })`)
 * to determine the resulting {@link ApiError}.
 */
export interface ApiIssueParams {
  code: ErrorCode;
  /** Overrides the field derived from the issue path. */
  field?: string;
  details?: Record<string, unknown>;
}

function toApiError(issue: z.core.$ZodIssue): ApiError {
  const params =
    issue.code === 'custom' ? (issue.params as Partial<ApiIssueParams> | undefined) : undefined;
  const pathField = issue.path.map(String).join('.');
  const field = params?.field ?? pathField;
  const top = issue.path[0];
  const code = isErrorCode(params?.code)
    ? params.code
    : ((typeof top === 'string' ? FIELD_ERROR_CODES[top] : undefined) ?? 'INVALID_PARAMETER');
  return {
    code,
    message: issue.message,
    ...(field !== '' && { field }),
    ...(params?.details !== undefined && { details: params.details }),
  };
}

/**
 * Maps Zod issues to catalog errors — the single mapping used by Search_API and MCP_Server
 * (Req 3.4, 19.7). Keeps the order of the issues and drops exact duplicates (same code, field and
 * details, e.g. two range checks failing on one value).
 */
export function toApiErrors(issues: readonly z.core.$ZodIssue[]): ApiError[] {
  const seen = new Set<string>();
  const errors: ApiError[] = [];
  for (const issue of issues) {
    const error = toApiError(issue);
    const key = JSON.stringify([error.code, error.field, error.details]);
    if (!seen.has(key)) {
      seen.add(key);
      errors.push(error);
    }
  }
  return errors;
}
