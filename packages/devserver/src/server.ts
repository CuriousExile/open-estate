import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import {
  fromProxyResult,
  stripPathPrefix,
  toProxyEvent,
  type ProxyResult,
  type RawHttpRequest,
} from './http/proxy-event';
import { isLoopbackUrl } from './oidc/provider';
import type { DevPlatform } from './platform';

// DEV ONLY: HTTP front of the local demo. Path prefixes stand in for the separate API Gateway
// APIs of a deployment:
//   /api/*         Search_API (stage-less paths `/listings`, `/listings/{id}`, `/openapi.json`, `/meta`)
//   /mcp, /api/mcp MCP_Server (Streamable HTTP, `POST`)
//   /management/*  Management_API (paths without the `/v1` stage)
//   /oidc/*        local OIDC provider (insecure, replaces Cognito)

export const PREFIX = {
  api: '/api',
  mcp: '/mcp',
  management: '/management',
  oidc: '/oidc',
} as const;

/** Resource templates of the Search_API (API Gateway routes by template, not by path). */
export const SEARCH_RESOURCES = ['/listings', '/listings/{id}', '/openapi.json', '/meta'] as const;

const MAX_BODY_BYTES = 1_048_576;

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** CORS for browser clients on loopback origins only (the SPA normally uses the ng proxy). */
function corsHeaders(origin: string | undefined): Record<string, string> {
  if (origin === undefined || !isLoopbackUrl(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'Retry-After, Mcp-Session-Id',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function send(
  res: ServerResponse,
  status: number,
  headers: Record<string, string | string[]>,
  body: Buffer | string,
): void {
  res.writeHead(status, headers);
  res.end(body);
}

const jsonBody = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

export interface RequestListenerOptions {
  platform: DevPlatform;
  /** Shown by `GET /` (URLs, demo users). */
  info: () => unknown;
  log?: (line: string) => void;
}

/** Node request listener dispatching to the real Lambda handlers of the platform. */
export function createRequestListener({
  platform,
  info,
  log,
}: RequestListenerOptions): RequestListener {
  const { search, mcp, management } = platform.handlers;

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const cors = corsHeaders(req.headers.origin);

    if (method === 'OPTIONS') {
      send(res, 204, cors, '');
      return;
    }
    if (path === '/' || path === '/health') {
      send(
        res,
        200,
        { 'Content-Type': 'application/json', ...cors },
        jsonBody(path === '/' ? info() : { status: 'ok' }),
      );
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        send(res, 413, { 'Content-Type': 'text/plain', ...cors }, 'Request body too large\n');
        return;
      }
      throw error;
    }
    const raw: RawHttpRequest = {
      method,
      url: req.url ?? '/',
      headers: req.headers,
      body,
      ...(req.socket.remoteAddress !== undefined && { remoteAddress: req.socket.remoteAddress }),
    };
    const reply = (result: ProxyResult) => {
      const out = fromProxyResult(result);
      send(res, out.status, { ...out.headers, ...cors }, out.body);
    };

    if (path === PREFIX.mcp || path === `${PREFIX.api}${PREFIX.mcp}`) {
      reply(await mcp(toProxyEvent(raw)));
      return;
    }
    if (under(path, PREFIX.api)) {
      reply(
        await search(toProxyEvent(raw, { stripPrefix: PREFIX.api, resources: SEARCH_RESOURCES })),
      );
      return;
    }
    if (under(path, PREFIX.management)) {
      reply(await management(toProxyEvent(raw, { stripPrefix: PREFIX.management })));
      return;
    }
    if (under(path, PREFIX.oidc)) {
      const isForm = (req.headers['content-type'] ?? '').startsWith(
        'application/x-www-form-urlencoded',
      );
      const out = await platform.oidc.handle({
        method,
        path: stripPathPrefix(path, PREFIX.oidc),
        query: url.searchParams,
        ...(method === 'POST' && {
          form: new URLSearchParams(isForm ? body.toString('utf8') : ''),
        }),
      });
      send(res, out.status, { ...out.headers, ...cors }, out.body);
      return;
    }
    send(
      res,
      404,
      { 'Content-Type': 'application/json', ...cors },
      jsonBody({ error: `No route ${method} ${path}` }),
    );
  }

  return (req, res) => {
    const started = Date.now();
    res.on('finish', () =>
      log?.(
        `${req.method ?? '-'} ${req.url ?? '-'} → ${res.statusCode} (${Date.now() - started} ms)`,
      ),
    );
    dispatch(req, res).catch((error: unknown) => {
      log?.(
        `request failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      if (!res.headersSent) send(res, 500, { 'Content-Type': 'text/plain' }, 'Internal error\n');
      else res.end();
    });
  };
}
