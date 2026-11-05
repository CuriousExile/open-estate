import type { APIGatewayProxyResult } from 'aws-lambda';
import {
  ERROR_HTTP_STATUS,
  type ApiError,
  type ErrorResponse,
  type Result,
} from '@open-estate/shared';

// HTTP shapes of the Management_API Lambda (API Gateway REST proxy integration). Every error
// leaves the Lambda in the shared `ErrorResponse` format with catalog codes (Req 16.3).

/**
 * Fields the adapter reads from an API Gateway REST proxy event; any `APIGatewayProxyEvent`
 * satisfies this. `path` excludes the stage (`/v1` is the stage of the ManagementApi).
 */
export interface ManagementRequest {
  httpMethod: string;
  path: string;
  headers?: Readonly<Record<string, string | undefined>> | null;
  queryStringParameters?: Readonly<Record<string, string | undefined>> | null;
  body: string | null;
  isBase64Encoded?: boolean;
  requestContext: { identity: { sourceIp: string } };
}

export type ManagementResponse = APIGatewayProxyResult;
export type ManagementHandler = (event: ManagementRequest) => Promise<ManagementResponse>;

/** Successful outcome of a route: status and JSON body (`undefined` → empty body, e.g. 204). */
export interface SuccessReply {
  kind: 'success';
  status: number;
  body?: unknown;
}

/** Rejected outcome: catalog errors; the HTTP status follows the first error's code. */
export interface FailureReply {
  kind: 'failure';
  errors: ApiError[];
}

export type Reply = SuccessReply | FailureReply;

export const success = (status: number, body?: unknown): SuccessReply =>
  body === undefined ? { kind: 'success', status } : { kind: 'success', status, body };

export const failure = (errors: ApiError | readonly ApiError[]): FailureReply => ({
  kind: 'failure',
  errors: Array.isArray(errors) ? [...errors] : [errors as ApiError],
});

/** Maps a use-case result: `status` with the value on success, the error(s) otherwise. */
export function fromResult<T>(
  status: number,
  result: Result<T, ApiError | readonly ApiError[]>,
): Reply {
  return result.ok ? success(status, result.value) : failure(result.error);
}

/** HTTP status of a failure: the catalog status of the first error (500 without catalog status). */
export function failureStatus(reply: FailureReply): number {
  const code = reply.errors[0]?.code;
  if (code === undefined || code === 'UNKNOWN_TOOL') return 500;
  return ERROR_HTTP_STATUS[code];
}

export const replyStatus = (reply: Reply): number =>
  reply.kind === 'success' ? reply.status : failureStatus(reply);

/** `details.retryAfterSeconds` of a `RATE_LIMITED` error, if any. */
function retryAfter(errors: readonly ApiError[]): number | undefined {
  for (const error of errors) {
    const value = error.details?.['retryAfterSeconds'];
    if (error.code === 'RATE_LIMITED' && typeof value === 'number') return value;
  }
  return undefined;
}

// Responses may contain a freshly issued machine-access secret: nothing may be cached.
const BASE_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

/** Serializes a reply; 429 carries `retryAfterSeconds` and `Retry-After` (Req 2.9). */
export function toProxyResult(reply: Reply): ManagementResponse {
  if (reply.kind === 'success') {
    return reply.body === undefined
      ? { statusCode: reply.status, headers: { 'Cache-Control': 'no-store' }, body: '' }
      : { statusCode: reply.status, headers: BASE_HEADERS, body: JSON.stringify(reply.body) };
  }
  const seconds = retryAfter(reply.errors);
  const body: ErrorResponse = {
    errors: reply.errors,
    ...(seconds !== undefined && { retryAfterSeconds: seconds }),
  };
  return {
    statusCode: failureStatus(reply),
    headers: { ...BASE_HEADERS, ...(seconds !== undefined && { 'Retry-After': String(seconds) }) },
    body: JSON.stringify(body),
  };
}

/** Case-insensitive header lookup (API Gateway keeps the client's spelling). */
export function headerValue(event: ManagementRequest, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

export const serviceUnavailable = (): FailureReply =>
  failure({
    code: 'SERVICE_UNAVAILABLE',
    message: 'The management service is temporarily unavailable. Please retry later.',
  });
