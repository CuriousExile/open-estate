import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { AccessGuard } from '@open-estate/core';
import { ERROR_HTTP_STATUS, type ApiError, type ErrorResponse } from '@open-estate/shared';
import { logger } from './observability';
import { createMcpServer, MCP_DEADLINE_MS, toolDefinitions, type ToolDeps } from './tools';

// `POST /mcp` (design: "MCP_Server", "Request-Pfade"): AccessGuard (same counters as the API)
// → JSON-RPC batches rejected (-32600) → stateless Streamable HTTP transport with JSON responses,
// new per request → tool dispatch.

/** The parts of an API Gateway REST proxy event the handler reads. */
export interface McpRequest {
  httpMethod: string;
  headers?: APIGatewayProxyEvent['headers'];
  multiValueHeaders?: APIGatewayProxyEvent['multiValueHeaders'];
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext: { identity: { sourceIp: string } };
}

export type McpHandler = (event: McpRequest) => Promise<APIGatewayProxyResult>;

export interface McpHandlerDeps extends ToolDeps {
  guard: AccessGuard;
  /** Overall deadline per request; default 10 s (Req 19.10). */
  deadlineMs?: number;
}

const CONTENT_TYPE = 'application/json; charset=utf-8';

const SERVICE_UNAVAILABLE: ApiError = {
  code: 'SERVICE_UNAVAILABLE',
  message: 'The MCP server is temporarily unavailable. Please retry later.',
};

/**
 * HTTP error with the Search_API error body; 429 adds `Retry-After` and `retryAfterSeconds`
 * (Req 17.3, 17.7). Only guard, init and deadline errors before the transport use this.
 */
export function httpErrorResponse(error: ApiError): APIGatewayProxyResult {
  const status =
    error.code in ERROR_HTTP_STATUS
      ? ERROR_HTTP_STATUS[error.code as keyof typeof ERROR_HTTP_STATUS]
      : 503;
  const retryAfter = error.details?.['retryAfterSeconds'];
  const body: ErrorResponse = {
    errors: [error],
    ...(typeof retryAfter === 'number' && { retryAfterSeconds: retryAfter }),
  };
  return {
    statusCode: status,
    headers: {
      'Content-Type': CONTENT_TYPE,
      'Cache-Control': 'no-store',
      ...(typeof retryAfter === 'number' && { 'Retry-After': String(retryAfter) }),
    },
    body: JSON.stringify(body),
  };
}

export function serviceUnavailableResponse(): APIGatewayProxyResult {
  return httpErrorResponse(SERVICE_UNAVAILABLE);
}

/** Headers of the event; repeated headers are joined with `, ` (RFC 9110 5.3). */
function toHeaders(event: McpRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(name, value);
  }
  for (const [name, values] of Object.entries(event.multiValueHeaders ?? {})) {
    if (values !== undefined && values.length > 0) headers.set(name, values.join(', '));
  }
  return headers;
}

function decodeBody(event: McpRequest): string | Buffer | undefined {
  if (event.body === undefined || event.body === null) return undefined;
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
}

/**
 * True if the body parses as a JSON array (a JSON-RPC batch). Unparsable bodies return false, so
 * they keep reaching the transport and get its -32700 parse error.
 */
function isBatch(body: string | Buffer | undefined): boolean {
  if (body === undefined) return false;
  try {
    return Array.isArray(JSON.parse(body.toString('utf8')));
  } catch {
    return false;
  }
}

/** JSON-RPC batches were removed in MCP 2025-06-18; answered as an invalid request. */
const BATCH_REJECTED: APIGatewayProxyResult = {
  statusCode: 400,
  headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'no-store' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32600, message: 'Batch requests are not supported' },
    id: null,
  }),
};

function toRequest(event: McpRequest, body: string | Buffer | undefined): Request {
  return new Request('https://mcp.invalid/mcp', {
    method: event.httpMethod,
    headers: toHeaders(event),
    ...(body !== undefined && { body }),
  });
}

async function toResult(response: Response): Promise<APIGatewayProxyResult> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return { statusCode: response.status, headers, body: await response.text() };
}

/** Rejects once `signal` aborts. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

export function createMcpHandler(deps: McpHandlerDeps): McpHandler {
  const { guard } = deps;
  const tools = toolDefinitions(deps.schemas);
  const deadlineMs = deps.deadlineMs ?? MCP_DEADLINE_MS;

  return async (event) => {
    // Stateless JSON mode has no SSE stream (GET) and no session (DELETE).
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { Allow: 'POST', 'Content-Type': CONTENT_TYPE },
        body: JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed' },
          id: null,
        }),
      };
    }

    const signal = AbortSignal.timeout(deadlineMs);
    const headers = toHeaders(event);
    try {
      const admission = await Promise.race([
        guard.admit({
          sourceIp: event.requestContext.identity.sourceIp,
          authorization: headers.get('Authorization') ?? undefined,
        }),
        aborted(signal),
      ]);
      if (!admission.ok) return httpErrorResponse(admission.error);
    } catch (cause) {
      // Guard stores or access config failed or the deadline passed: 503 without details.
      logger.error('POST /mcp: access check failed', {
        errorName: cause instanceof Error ? cause.name : typeof cause,
      });
      return serviceUnavailableResponse();
    }

    // Batches are rejected after admission: one guard admission must never run more than one
    // JSON-RPC request (Req 17.1), and checking after the guard keeps batch floods counted against
    // the client's rate limit. The transport still parses the raw body itself, so its size limit
    // and -32700 parse error for malformed JSON stay unchanged.
    const body = decodeBody(event);
    if (isBatch(body)) return BATCH_REJECTED;

    const server = createMcpServer(deps, tools, signal);
    // No `sessionIdGenerator` ⇒ stateless mode (no session id, no session storage).
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    try {
      await server.connect(transport);
      return await toResult(await transport.handleRequest(toRequest(event, body)));
    } catch (cause) {
      logger.error('POST /mcp: request failed', {
        errorName: cause instanceof Error ? cause.name : typeof cause,
      });
      return serviceUnavailableResponse();
    } finally {
      await server.close();
    }
  };
}
