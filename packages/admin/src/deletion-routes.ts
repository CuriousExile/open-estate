import { randomUUID } from 'node:crypto';
import type { Clock } from '@open-estate/core';
import { err, LISTING_BOUNDS, ok, type ApiError, type Result } from '@open-estate/shared';
import {
  badRequest,
  errorResponse,
  json,
  notFound,
  type Route,
  type RouteContext,
} from './admin-http';
import type { AuditLog } from './audit-log';
import {
  describeCriterion,
  type DeletionBlocklistStore,
  type DeletionCriterion,
  type DeletionListingStore,
  type DeletionRequestRecord,
  type DeletionRequestStore,
  type DeletionWorkflowStarter,
} from './deletion';

export interface DeletionAdminDeps {
  requests: DeletionRequestStore;
  listings: DeletionListingStore;
  blocklist: DeletionBlocklistStore;
  /** Step Functions in production, in-process in tests. */
  starter: DeletionWorkflowStarter;
  newRequestId?: () => string;
}

/** `action` of the `deletion` audit entry when an administrator lifts a block (Req 18.6). */
export const BLOCKLIST_ENTRY_REMOVED_ACTION = 'deletion-blocklist.entry-removed';

const CRITERION_FIELDS = ['listingId', 'source'] as const;
type CriterionField = (typeof CRITERION_FIELDS)[number];

const FIELD_BOUNDS: Record<CriterionField, { min: number; max: number }> = {
  listingId: LISTING_BOUNDS.id,
  source: LISTING_BOUNDS.source,
};

const REQUEST_ID = '([A-Za-z0-9_-]{1,128})';
const PATH_SEGMENT = '([^/]+)';

function invalid(message: string, field: string): ApiError {
  return { code: 'INVALID_PARAMETER', message, field };
}

function validString(value: unknown, field: CriterionField): Result<string, ApiError[]> {
  const { min, max } = FIELD_BOUNDS[field];
  return typeof value === 'string' && value.length >= min && value.length <= max
    ? ok(value)
    : err([invalid(`${field} must be a string of ${min} to ${max} characters`, field)]);
}

/** Body `{listingId}` or `{source}`: exactly one, no other fields. */
function parseCriterion(body: unknown): Result<DeletionCriterion, ApiError[]> {
  const fields = body as Record<string, unknown>;
  const unknown = Object.keys(fields).filter(
    (key) => !(CRITERION_FIELDS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) return err(unknown.map((key) => invalid(`Unknown field ${key}`, key)));
  const present = CRITERION_FIELDS.filter((key) => fields[key] !== undefined);
  const [field] = present;
  if (present.length !== 1 || field === undefined) {
    return err([invalid('Specify exactly one of listingId or source', 'body')]);
  }
  const value = validString(fields[field], field);
  if (!value.ok) return value;
  return ok(field === 'listingId' ? { listingId: value.value } : { source: value.value });
}

function decodeListingId(raw: string): Result<string, ApiError[]> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return err([invalid('listingId is not a valid URL path segment', 'listingId')]);
  }
  return validString(decoded, 'listingId');
}

/**
 * Routes of the GDPR deletion process (design: "Admin-API und Löschprozess", Req 18.4–18.9):
 *
 * - `POST /admin/deletions` checks that the criterion matches at least one listing — otherwise
 *   404 `DELETION_TARGET_NOT_FOUND` naming the criterion and nothing is written (18.9) — then
 *   stores the request as `OPEN` and starts the workflow. 202 with the request. If the start
 *   fails, the request stays `OPEN` (the overdue check reports it, 18.10) and the caller gets 503.
 * - `GET /admin/deletions/{requestId}` returns the request (status, `removedCount`, times).
 * - `DELETE /admin/deletion-blocklist/{listingId}` lifts a block explicitly (18.6); audited.
 */
export function createDeletionRoutes(
  deps: DeletionAdminDeps & { audit: AuditLog; clock: Clock },
): Route[] {
  const newRequestId = deps.newRequestId ?? randomUUID;

  async function hasTarget(criterion: DeletionCriterion): Promise<boolean> {
    if ('listingId' in criterion) return (await deps.listings.find(criterion.listingId)) !== null;
    const page = await deps.listings.listBySource(criterion.source, { limit: 1 });
    return page.targets.length > 0;
  }

  async function createDeletion({ actor, body }: RouteContext) {
    const parsed = parseCriterion(body);
    if (!parsed.ok) return badRequest(parsed.error);
    const criterion = parsed.value;

    if (!(await hasTarget(criterion))) {
      const field = 'listingId' in criterion ? 'listingId' : 'source';
      return errorResponse('DELETION_TARGET_NOT_FOUND', [
        {
          code: 'DELETION_TARGET_NOT_FOUND',
          message: `No listing found for ${describeCriterion(criterion)}`,
          field,
          details: { criterion },
        },
      ]);
    }

    const record: DeletionRequestRecord = {
      requestId: newRequestId(),
      criterion,
      status: 'OPEN',
      requestedBy: actor,
      requestedAt: new Date(deps.clock()).toISOString(),
      removedCount: 0,
    };
    await deps.requests.create(record);
    await deps.starter.start(record.requestId);
    return json(202, record);
  }

  async function getDeletion({ params: [requestId = ''] }: RouteContext) {
    const record = await deps.requests.get(requestId);
    return record === null
      ? notFound(`Deletion request ${requestId} not found`)
      : json(200, record);
  }

  async function removeBlocklistEntry({ actor, params: [raw = ''] }: RouteContext) {
    const listingId = decodeListingId(raw);
    if (!listingId.ok) return badRequest(listingId.error);
    if (!(await deps.blocklist.unblock(listingId.value))) {
      return notFound(`Listing ${listingId.value} is not on the deletion blocklist`);
    }
    await deps.audit.append({
      type: 'deletion',
      action: BLOCKLIST_ENTRY_REMOVED_ACTION,
      actor,
      at: new Date(deps.clock()).toISOString(),
      details: { listingId: listingId.value },
    });
    return json(200, { listingId: listingId.value });
  }

  return [
    { method: 'POST', pattern: /^\/admin\/deletions$/, handle: createDeletion },
    { method: 'GET', pattern: new RegExp(`^/admin/deletions/${REQUEST_ID}$`), handle: getDeletion },
    {
      method: 'DELETE',
      pattern: new RegExp(`^/admin/deletion-blocklist/${PATH_SEGMENT}$`),
      handle: removeBlocklistEntry,
    },
  ];
}
