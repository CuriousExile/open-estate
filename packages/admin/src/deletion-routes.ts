import {
  createDeletionOperations,
  type Clock,
  type DeletionOperations,
  type DeletionOperationsDeps,
} from '@open-estate/core';
import { err, ok, type ApiError, type Result } from '@open-estate/shared';
import { badRequest, fromResult, type Route, type RouteContext } from './admin-http';
import type { AuditLog } from './audit-log';

export { BLOCKLIST_ENTRY_REMOVED_ACTION } from '@open-estate/core';

export type DeletionAdminDeps = DeletionOperationsDeps;

const REQUEST_ID = '([A-Za-z0-9_-]{1,128})';
const PATH_SEGMENT = '([^/]+)';

function decodePathSegment(raw: string): Result<string, ApiError[]> {
  try {
    return ok(decodeURIComponent(raw));
  } catch {
    return err([
      {
        code: 'INVALID_PARAMETER',
        message: 'listingId is not a valid URL path segment',
        field: 'listingId',
      },
    ]);
  }
}

/**
 * Routes of the GDPR deletion process (design: "Admin-API und Löschprozess", Req 18.4–18.9);
 * the logic is core's `DeletionOperations`:
 *
 * - `POST /admin/deletions` → 202 with the `OPEN` request, 404 `DELETION_TARGET_NOT_FOUND` if
 *   the criterion matches nothing (18.9), 503 if the workflow start fails (request stays `OPEN`).
 * - `GET /admin/deletions/{requestId}` returns the request (status, `removedCount`, times).
 * - `DELETE /admin/deletion-blocklist/{listingId}` lifts a block explicitly (18.6); audited.
 */
export function createDeletionRoutes(
  deps: DeletionAdminDeps & { audit: AuditLog; clock: Clock },
): Route[] {
  return deletionRoutes(createDeletionOperations(deps));
}

/** Deletion routes on top of existing operations. */
export function deletionRoutes(ops: DeletionOperations): Route[] {
  return [
    {
      method: 'POST',
      pattern: /^\/admin\/deletions$/,
      handle: async ({ actor, body }: RouteContext) =>
        fromResult(202, await ops.requestDeletion(actor, body)),
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/admin/deletions/${REQUEST_ID}$`),
      handle: async ({ params: [requestId = ''] }: RouteContext) =>
        fromResult(200, await ops.getDeletionRequest(requestId)),
    },
    {
      method: 'DELETE',
      pattern: new RegExp(`^/admin/deletion-blocklist/${PATH_SEGMENT}$`),
      handle: async ({ actor, params: [raw = ''] }: RouteContext) => {
        const listingId = decodePathSegment(raw);
        if (!listingId.ok) return badRequest(listingId.error);
        return fromResult(200, await ops.removeBlocklistEntry(actor, listingId.value));
      },
    },
  ];
}
