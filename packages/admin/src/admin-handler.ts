import type { APIGatewayProxyResult } from 'aws-lambda';
import {
  createAdminOperations,
  type AccessConfigWriter,
  type AdminActor,
  type ApiKeyAdminStore,
  type Clock,
  type GeneratedApiKey,
} from '@open-estate/core';
import { err, ok, type ApiError, type Result } from '@open-estate/shared';
import { badRequest, errorResponse, fromResult, notFound, type Route } from './admin-http';
import type { AuditLog } from './audit-log';
import { deletionRoutes, type DeletionAdminDeps } from './deletion-routes';

// The use cases live in core (`AdminOperations`); re-exported under the Admin_API's names.
export {
  API_KEY_BYTES,
  generateApiKey,
  validateRateLimit,
  type AccessConfigAction,
  type GeneratedApiKey,
  type PublicApiKey,
} from '@open-estate/core';

/**
 * Fields the handler reads from an API Gateway REST proxy event (`AWS_IAM` authorization).
 * Any `APIGatewayProxyEvent` satisfies this.
 */
export interface AdminRequest {
  httpMethod: string;
  path: string;
  body: string | null;
  isBase64Encoded?: boolean;
  requestContext: { identity: { userArn: string | null } };
}

export type AdminHandler = (event: AdminRequest) => Promise<APIGatewayProxyResult>;

export interface AdminHandlerDeps {
  apiKeys: ApiKeyAdminStore;
  accessConfig: AccessConfigWriter;
  audit: AuditLog;
  /** Deletion requests and blocklist (Req 18.4–18.9). */
  deletions: DeletionAdminDeps;
  clock?: Clock;
  generateKey?: () => GeneratedApiKey;
}

const KEY_ID = '([A-Za-z0-9_-]{1,128})';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Missing/empty body → `{}`; anything but a JSON object → `INVALID_PARAMETER` on `body`. */
function parseBody(event: AdminRequest): Result<unknown, ApiError[]> {
  const raw =
    event.body === null
      ? ''
      : event.isBase64Encoded === true
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;
  if (raw.trim() === '') return ok({});
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isObject(parsed)) return ok(parsed);
  } catch {
    // fall through
  }
  return err([{ code: 'INVALID_PARAMETER', message: 'Body must be a JSON object', field: 'body' }]);
}

function matchRoute(
  routes: readonly Route[],
  method: string,
  path: string,
): { route: Route; params: string[] } | undefined {
  for (const route of routes) {
    const match = route.method === method ? route.pattern.exec(path) : null;
    if (match !== null) return { route, params: match.slice(1) };
  }
  return undefined;
}

const normalizePath = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/**
 * Admin-API for API keys, rate limits and access mode (Req 17.4, 17.6, 17.8, 17.9) and for
 * deletion requests and the deletion blocklist (Req 18.4–18.9, see `deletion-routes`). The
 * use cases are core's `AdminOperations` (also behind the Management_API's `/platform/*`).
 *
 * - Identity is the IAM `userArn`; without it every request is rejected with 403 `FORBIDDEN`
 *   (defense in depth behind the gateway's `AWS_IAM` authorization), before routing.
 * - Unknown path or method → 404 `NOT_FOUND` (the catalog has no 405 code; a route is
 *   method + path).
 * - Invalid input is rejected before anything is written, so the previous configuration stays.
 * - Changes reach API/MCP within the AccessGuard's 60-s cache TTL (Req 17.9).
 * - Each successful change is recorded as `access-config` audit entry without secrets.
 */
export function createAdminHandler(deps: AdminHandlerDeps): AdminHandler {
  const ops = createAdminOperations(deps);

  const routes: Route[] = [
    {
      method: 'POST',
      pattern: /^\/admin\/api-keys$/,
      handle: async ({ actor, body }) => fromResult(201, await ops.createApiKey(actor, body)),
    },
    {
      method: 'DELETE',
      pattern: new RegExp(`^/admin/api-keys/${KEY_ID}$`),
      handle: async ({ actor, params: [keyId = ''] }) =>
        fromResult(200, await ops.revokeApiKey(actor, keyId)),
    },
    {
      method: 'PUT',
      pattern: new RegExp(`^/admin/api-keys/${KEY_ID}/rate-limit$`),
      handle: async ({ actor, params: [keyId = ''], body }) =>
        fromResult(200, await ops.setApiKeyRateLimit(actor, keyId, body)),
    },
    {
      method: 'PUT',
      pattern: /^\/admin\/rate-limit$/,
      handle: async ({ actor, body }) => fromResult(200, await ops.setRateLimit(actor, body)),
    },
    {
      method: 'PUT',
      pattern: /^\/admin\/access-mode$/,
      handle: async ({ actor, body }) => fromResult(200, await ops.setAccessMode(actor, body)),
    },
    ...deletionRoutes(ops),
  ];

  return async (event) => {
    const userArn = event.requestContext.identity.userArn?.trim();
    if (userArn === undefined || userArn === '') {
      return errorResponse('FORBIDDEN', [
        { code: 'FORBIDDEN', message: 'Admin endpoints require IAM authorization' },
      ]);
    }
    const actor: AdminActor = { kind: 'iam', userArn };

    const path = normalizePath(event.path);
    const method = event.httpMethod.toUpperCase();
    const found = matchRoute(routes, method, path);
    if (found === undefined) return notFound(`No route ${method} ${path}`);
    const { route, params } = found;

    const body = parseBody(event);
    if (!body.ok) return badRequest(body.error);

    try {
      return await route.handle({ actor, params, body: body.value });
    } catch (cause) {
      // Only the error class: neither request bodies nor keys end up in the log.
      console.error(`${method} ${route.pattern.source}: admin operation failed`, {
        errorName: cause instanceof Error ? cause.name : typeof cause,
      });
      return errorResponse('SERVICE_UNAVAILABLE', [
        {
          code: 'SERVICE_UNAVAILABLE',
          message: 'The admin service is temporarily unavailable. Please retry later.',
        },
      ]);
    }
  };
}
