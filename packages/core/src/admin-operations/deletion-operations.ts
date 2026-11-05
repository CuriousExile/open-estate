import { randomUUID } from 'node:crypto';
import { err, LISTING_BOUNDS, ok, type ApiError, type Result } from '@open-estate/shared';
import type { Clock } from '../access/ttl-cache';
import type { AdminAuditLog } from './admin-audit-log';
import {
  adminActorId,
  invalidInput,
  notFoundError,
  type AdminActor,
  type AdminResult,
} from './admin-operation';
import {
  describeCriterion,
  type DeletionCriterion,
  type DeletionRequestRecord,
} from './deletion-model';
import type {
  DeletionBlocklistStore,
  DeletionListingStore,
  DeletionRequestStore,
  DeletionWorkflowStarter,
} from './deletion-ports';

export interface DeletionOperationsDeps {
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
export function parseDeletionCriterion(body: unknown): Result<DeletionCriterion, ApiError[]> {
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

/**
 * GDPR deletion process (design: "Admin-API und Löschprozess", Req 18.4–18.9):
 *
 * - `requestDeletion` checks that the criterion matches at least one listing — otherwise
 *   `DELETION_TARGET_NOT_FOUND` naming the criterion and nothing is written (18.9) — then stores
 *   the request as `OPEN` and starts the workflow. If the start fails, the request stays `OPEN`
 *   (the overdue check reports it, 18.10) and the error propagates.
 * - `getDeletionRequest` returns the request (status, `removedCount`, times).
 * - `removeBlocklistEntry` lifts a block explicitly (18.6); audited.
 */
export interface DeletionOperations {
  requestDeletion(actor: AdminActor, input: unknown): Promise<AdminResult<DeletionRequestRecord>>;
  getDeletionRequest(requestId: string): Promise<AdminResult<DeletionRequestRecord>>;
  removeBlocklistEntry(
    actor: AdminActor,
    listingId: string,
  ): Promise<AdminResult<{ listingId: string }>>;
}

export function createDeletionOperations(
  deps: DeletionOperationsDeps & { audit: AdminAuditLog; clock: Clock },
): DeletionOperations {
  const newRequestId = deps.newRequestId ?? randomUUID;

  async function hasTarget(criterion: DeletionCriterion): Promise<boolean> {
    if ('listingId' in criterion) return (await deps.listings.find(criterion.listingId)) !== null;
    const page = await deps.listings.listBySource(criterion.source, { limit: 1 });
    return page.targets.length > 0;
  }

  return {
    async requestDeletion(actor, input) {
      const parsed = parseDeletionCriterion(input);
      if (!parsed.ok) return err(invalidInput(parsed.error));
      const criterion = parsed.value;

      if (!(await hasTarget(criterion))) {
        const field = 'listingId' in criterion ? 'listingId' : 'source';
        return err({
          code: 'DELETION_TARGET_NOT_FOUND',
          errors: [
            {
              code: 'DELETION_TARGET_NOT_FOUND',
              message: `No listing found for ${describeCriterion(criterion)}`,
              field,
              details: { criterion },
            },
          ],
        });
      }

      const record: DeletionRequestRecord = {
        requestId: newRequestId(),
        criterion,
        status: 'OPEN',
        requestedBy: adminActorId(actor),
        requestedAt: new Date(deps.clock()).toISOString(),
        removedCount: 0,
      };
      await deps.requests.create(record);
      await deps.starter.start(record.requestId);
      return ok(record);
    },

    async getDeletionRequest(requestId) {
      const record = await deps.requests.get(requestId);
      return record === null
        ? err(notFoundError(`Deletion request ${requestId} not found`))
        : ok(record);
    },

    async removeBlocklistEntry(actor, rawListingId) {
      const listingId = validString(rawListingId, 'listingId');
      if (!listingId.ok) return err(invalidInput(listingId.error));
      if (!(await deps.blocklist.unblock(listingId.value))) {
        return err(notFoundError(`Listing ${listingId.value} is not on the deletion blocklist`));
      }
      await deps.audit.append({
        type: 'deletion',
        action: BLOCKLIST_ENTRY_REMOVED_ACTION,
        actor: adminActorId(actor),
        at: new Date(deps.clock()).toISOString(),
        details: { listingId: listingId.value },
      });
      return ok({ listingId: listingId.value });
    },
  };
}
