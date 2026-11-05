import type { AdminActor, AdminResult } from '@open-estate/core';
import {
  authorize,
  DryRunQuery,
  type ApiError,
  type Principal,
  type Result,
} from '@open-estate/shared';
import { z } from 'zod';
import { failure, fromResult, success, type Reply } from '../http';
import { defineRoute, type Route, type RouteContext } from '../router';
import { previewDeletion } from './platform/deletion-preview';
import type { PlatformDeps } from './platform/platform-deps';
import { platformDepsFromEnv, type PlatformClients } from './platform/platform-env';
import type { RouteGroup } from './route-group';

export type { PlatformDeps } from './platform/platform-deps';
export {
  parseFunctionNames,
  PLATFORM_ENV,
  platformDepsFromEnv,
  withSignal,
  type PlatformClients,
} from './platform/platform-env';
export { DELETION_PREVIEW_PAGE_SIZE, previewDeletion } from './platform/deletion-preview';

// Platform operations of the Management_API (design: "Management_API", Req 10.7): the Admin_API's
// functions on the same `AdminOperations` use cases — same validation, error codes, statuses and
// audit entries as `/admin/*`; only the actor is the Plattform_Admin instead of an IAM identity.
// Every route requires `platform:operate`, held only by Plattform_Admins; any other principal gets
// 403 `FORBIDDEN`, which the handler records as `access-denied` (Req 2.8).

const PERMISSION = 'platform:operate';

/** Ids the Admin_API accepts in paths; anything else is a 404 there, so it is one here too. */
const ADMIN_ID = /^[A-Za-z0-9_-]{1,128}$/;

const keyIdParams = z.object({ keyId: z.string() });
const requestIdParams = z.object({ requestId: z.string() });
const listingIdParams = z.object({ listingId: z.string() });

const forbidden = (): ApiError => ({
  code: 'FORBIDDEN',
  message: `Missing permission ${PERMISSION}`,
});

/** The Plattform_Admin as admin actor, or `FORBIDDEN` for every other principal. */
function platformActor(principal: Principal): Result<AdminActor, ApiError> {
  if (authorize(principal, PERMISSION, undefined) !== 'ALLOW' || principal.kind !== 'user') {
    return { ok: false, error: forbidden() };
  }
  return {
    ok: true,
    value: { kind: 'user', userId: principal.userId, displayName: principal.displayName },
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Like the Admin_API: missing body → `{}`; anything but a JSON object → `INVALID_PARAMETER`. */
function objectBody(body: unknown): Result<unknown, ApiError> {
  if (body === undefined) return { ok: true, value: {} };
  if (isObject(body)) return { ok: true, value: body };
  return {
    ok: false,
    error: { code: 'INVALID_PARAMETER', message: 'Body must be a JSON object', field: 'body' },
  };
}

/** `AdminResult` → reply; the status follows the operation's error code like `/admin/*`. */
const fromAdmin = <T>(status: number, result: AdminResult<T>): Reply =>
  result.ok ? success(status, result.value) : failure(result.error.errors);

const notFound = (message: string): Reply => failure({ code: 'NOT_FOUND', message });

interface PlatformContext<P, Q> extends RouteContext<P, Q, unknown> {
  actor: AdminActor;
  body: unknown;
}

/** Authorizes the Plattform_Admin and normalizes the body before `handle` runs. */
function platformRoute<P, Q = Record<string, string>>(spec: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  params?: z.ZodType<P>;
  query?: z.ZodType<Q>;
  handle(ctx: PlatformContext<P, Q>): Promise<Reply>;
}): Route {
  return defineRoute<P, Q, unknown>({
    ...spec,
    async handle(ctx) {
      const actor = platformActor(ctx.principal);
      if (!actor.ok) return failure(actor.error);
      const body = objectBody(ctx.body);
      if (!body.ok) return failure(body.error);
      return spec.handle({ ...ctx, actor: actor.value, body: body.value });
    },
  });
}

/** Routes of `/platform/*` on the given use cases. */
export function createPlatformRoutes(deps: PlatformDeps): Route[] {
  const ops = (signal: AbortSignal) => deps.operations(signal);

  return [
    platformRoute({
      method: 'POST',
      path: '/platform/deletions',
      query: DryRunQuery,
      async handle({ actor, body, query, signal }) {
        if (query.dryRun) {
          return fromResult(200, await previewDeletion(deps.deletionTargets(signal), body, signal));
        }
        return fromAdmin(202, await ops(signal).requestDeletion(actor, body));
      },
    }),
    platformRoute({
      method: 'GET',
      path: '/platform/deletions/{requestId}',
      params: requestIdParams,
      async handle({ params: { requestId }, signal }) {
        if (!ADMIN_ID.test(requestId)) return notFound(`Deletion request ${requestId} not found`);
        return fromAdmin(200, await ops(signal).getDeletionRequest(requestId));
      },
    }),
    platformRoute({
      method: 'DELETE',
      path: '/platform/deletion-blocklist/{listingId}',
      params: listingIdParams,
      async handle({ actor, params: { listingId }, signal }) {
        return fromAdmin(200, await ops(signal).removeBlocklistEntry(actor, listingId));
      },
    }),
    platformRoute({
      method: 'POST',
      path: '/platform/api-keys',
      async handle({ actor, body, signal }) {
        return fromAdmin(201, await ops(signal).createApiKey(actor, body));
      },
    }),
    platformRoute({
      method: 'DELETE',
      path: '/platform/api-keys/{keyId}',
      params: keyIdParams,
      async handle({ actor, params: { keyId }, signal }) {
        if (!ADMIN_ID.test(keyId)) return notFound(`API key ${keyId} not found`);
        return fromAdmin(200, await ops(signal).revokeApiKey(actor, keyId));
      },
    }),
    platformRoute({
      method: 'PUT',
      path: '/platform/api-keys/{keyId}/rate-limit',
      params: keyIdParams,
      async handle({ actor, params: { keyId }, body, signal }) {
        if (!ADMIN_ID.test(keyId)) return notFound(`API key ${keyId} not found`);
        return fromAdmin(200, await ops(signal).setApiKeyRateLimit(actor, keyId, body));
      },
    }),
    platformRoute({
      method: 'PUT',
      path: '/platform/rate-limit',
      async handle({ actor, body, signal }) {
        return fromAdmin(200, await ops(signal).setRateLimit(actor, body));
      },
    }),
    platformRoute({
      method: 'PUT',
      path: '/platform/access-mode',
      async handle({ actor, body, signal }) {
        return fromAdmin(200, await ops(signal).setAccessMode(actor, body));
      },
    }),
    platformRoute({
      method: 'POST',
      path: '/platform/reload',
      async handle({ signal }) {
        // Failed targets are reported per function; the others are still restarted.
        return success(200, { functions: await deps.reload(signal) });
      },
    }),
  ];
}

/** Route group reading its configuration from the environment (`PLATFORM_ENV`). */
export function createPlatformRouteGroup(clients: PlatformClients = {}): RouteGroup {
  return {
    name: 'platform',
    create: (context) => createPlatformRoutes(platformDepsFromEnv(context, clients)),
  };
}

export const platformRoutes: RouteGroup = createPlatformRouteGroup();
