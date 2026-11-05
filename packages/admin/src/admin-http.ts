// HTTP helpers shared by the admin route modules; internal (not re-exported by the package).
import type { APIGatewayProxyResult } from 'aws-lambda';
import type { AdminActor, AdminResult } from '@open-estate/core';
import { ERROR_HTTP_STATUS, type ApiError, type ErrorResponse } from '@open-estate/shared';

export type HttpErrorCode = keyof typeof ERROR_HTTP_STATUS;

export interface RouteContext {
  actor: AdminActor;
  params: string[];
  body: unknown;
}

export interface Route {
  method: string;
  pattern: RegExp;
  handle: (ctx: RouteContext) => Promise<APIGatewayProxyResult>;
}

export function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    // Responses may contain a freshly created key; nothing here may be cached.
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

export function errorResponse(code: HttpErrorCode, errors: ApiError[]): APIGatewayProxyResult {
  const body: ErrorResponse = { errors };
  return json(ERROR_HTTP_STATUS[code], body);
}

export const badRequest = (errors: ApiError[]) => errorResponse('INVALID_PARAMETER', errors);

export const notFound = (message: string) =>
  errorResponse('NOT_FOUND', [{ code: 'NOT_FOUND', message }]);

/** Maps a use-case result: `statusCode` with the value on success, the error response otherwise. */
export function fromResult<T>(statusCode: number, result: AdminResult<T>): APIGatewayProxyResult {
  return result.ok
    ? json(statusCode, result.value)
    : errorResponse(result.error.code, result.error.errors);
}
