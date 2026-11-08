import { StartExecutionCommand, type SFNClient } from '@aws-sdk/client-sfn';
import {
  customIdBlocklistKey,
  deletionCounterDecrements,
  NO_AGENCY_SCOPE_ID,
  systemClock,
  type Clock,
  type DeletionWorkflowStarter,
  type DuplicateDataPurge,
  type ListingHistoryStore,
} from '@open-estate/core';
import type { AuditLog } from '../audit-log';
import type { DeletionBlocklistBatch, DeletionBlocklistStore } from './deletion-blocklist-store';
import type {
  CustomIdKey,
  DeletionListingState,
  ListingRemoval,
  VersionedDeletionListingStore,
} from './deletion-listing-store';
import {
  DeletionRequestNotFoundError,
  type DeletionBlocklistEntry,
  type DeletionRequestRecord,
  type DeletionTarget,
  type TargetPage,
} from './deletion-model';
import type { DeletionCompletionTracker, DeletionRequestStore } from './deletion-request-store';

/** Default number of targets per `resolveTargets` page (one Step Functions Map iteration). */
export const DELETION_TARGET_PAGE_SIZE = 100;

/** `action` of the `deletion` audit entry written when a request is executed (Req 18.8). */
export const DELETION_EXECUTED_ACTION = 'deletion.executed';

export interface DeletionWorkflowDeps {
  requests: DeletionRequestStore & DeletionCompletionTracker;
  listings: VersionedDeletionListingStore;
  blocklist: DeletionBlocklistStore & DeletionBlocklistBatch;
  /** `ListingVersions` and the snapshot prefix of each listing (Req 9.2). */
  history: ListingHistoryStore;
  /**
   * Duplikat_Index and Idempotenzschlüssel of each listing (duplicate-detection Req 12.3). Every
   * production wiring sets it; a listing only counts as removed once this data is gone, too.
   */
  duplicates?: DuplicateDataPurge;
  audit: AuditLog;
  clock?: Clock;
  pageSize?: number;
}

export interface ResolveTargetsInput {
  requestId: string;
  cursor?: string;
}

export interface DeleteListingInput extends DeletionTarget {
  requestId: string;
}

export interface DeleteListingOutput {
  /** `false` if the listing was already gone (e.g. re-run); then it is not counted again. */
  removed: boolean;
  /** No version and no snapshot of the listing remains; otherwise the request stays `OPEN`. */
  complete: boolean;
}

export interface FinalizeInput {
  requestId: string;
}

/**
 * Steps of the deletion workflow (design: "Admin-API und Löschprozess", steps 3–4, and
 * "Löschprozess-Erweiterung"). Each step is idempotent, so Step Functions retries and re-runs are
 * safe. Run order per request: `resolveTargets` (paged) → `deleteListing` per target → `finalize`.
 */
export interface DeletionWorkflow {
  /** One page of affected listings for the request's criterion. */
  resolveTargets(input: ResolveTargetsInput): Promise<TargetPage>;
  /**
   * Blocks id and Custom_Id (Req 18.6, 4.9), removes listing, Custom_Id key and counters
   * (Req 18.4, 9.3), then all versions and snapshots (Req 9.2) and checks that none remains.
   */
  deleteListing(input: DeleteListingInput): Promise<DeleteListingOutput>;
  /**
   * Retries the removal of incomplete histories once; then `EXECUTED` + audit
   * `{requestedAt, executedAt, requestedBy, criterion, removedCount}` — or, if a history is still
   * incomplete, the request stays `OPEN` for the overdue notification (Req 9.5, 18.10).
   */
  finalize(input: FinalizeInput): Promise<DeletionRequestRecord>;
}

/** Audit details of an executed request: ids and counts only, never listing content (Req 18.8). */
export function deletionAuditDetails(record: DeletionRequestRecord): Record<string, unknown> {
  return {
    requestId: record.requestId,
    requestedAt: record.requestedAt,
    executedAt: record.executedAt,
    requestedBy: record.requestedBy,
    criterion: { ...record.criterion },
    removedCount: record.removedCount,
  };
}

/** Custom_Id key as the writer stores it: listings without agency share the `_none` owner. */
function customKeyOf(state: DeletionListingState | null): CustomIdKey | undefined {
  if (state?.customId === undefined) return undefined;
  return { owner: state.agencyId ?? NO_AGENCY_SCOPE_ID, customId: state.customId };
}

const blocklistKeyOf = ({ owner, customId }: CustomIdKey) => customIdBlocklistKey(owner, customId);

const sameKey = (a: CustomIdKey, b: CustomIdKey | undefined) =>
  b !== undefined && a.owner === b.owner && a.customId === b.customId;

export function createDeletionWorkflow(deps: DeletionWorkflowDeps): DeletionWorkflow {
  const clock = deps.clock ?? systemClock;
  const pageSize = deps.pageSize ?? DELETION_TARGET_PAGE_SIZE;
  const now = () => new Date(clock()).toISOString();

  async function load(requestId: string): Promise<DeletionRequestRecord> {
    const record = await deps.requests.get(requestId);
    if (record === null) throw new DeletionRequestNotFoundError(requestId);
    return record;
  }

  /** Version history and duplicate data of a listing; complete only if both are gone. */
  async function purgeListingData(listingId: string): Promise<{ complete: boolean }> {
    const history = await deps.history.purge(listingId);
    const duplicates = (await deps.duplicates?.purge(listingId)) ?? { complete: true };
    return { complete: history.complete && duplicates.complete };
  }

  /** One more attempt for every incomplete history; `true` if none remains incomplete. */
  async function purgeIncomplete(requestId: string): Promise<boolean> {
    let remaining = 0;
    for (const listingId of await deps.requests.incompleteListings(requestId)) {
      if ((await purgeListingData(listingId)).complete) {
        await deps.requests.markComplete(requestId, listingId);
      } else {
        remaining += 1;
      }
    }
    return remaining === 0;
  }

  return {
    async resolveTargets({ requestId, cursor }) {
      const { criterion } = await load(requestId);
      if ('source' in criterion) {
        return deps.listings.listBySource(criterion.source, {
          limit: pageSize,
          ...(cursor !== undefined && { cursor }),
        });
      }
      const target = await deps.listings.find(criterion.listingId);
      return { targets: target === null ? [] : [target] };
    },

    async deleteListing({ requestId, listingId, source }) {
      // Order matters: once blocked, no import or edit can re-create the listing, change its
      // Custom_Id or add a version (the writer's transaction checks both keys), so what is read
      // afterwards is final and the subsequent removal is complete.
      const deletedAt = now();
      const entry = (key: string): DeletionBlocklistEntry => ({
        listingId: key,
        source,
        requestId,
        deletedAt,
      });
      const before = await deps.listings.inspect(listingId);
      const blockedCustomKey = customKeyOf(before);
      await deps.blocklist.blockAll([
        entry(listingId),
        ...(blockedCustomKey === undefined ? [] : [entry(blocklistKeyOf(blockedCustomKey))]),
      ]);
      const state = before === null ? null : await deps.listings.inspect(listingId);
      const customKey = customKeyOf(state);
      if (customKey !== undefined && !sameKey(customKey, blockedCustomKey)) {
        // The Custom_Id changed between the first read and the block.
        await deps.blocklist.blockAll([entry(blocklistKeyOf(customKey))]);
      }

      let removed = false;
      if (state !== null) {
        const removal: ListingRemoval = {
          counters: deletionCounterDecrements(state, await deps.history.usage(listingId)),
          ...(customKey !== undefined && { customKey }),
        };
        removed = await deps.listings.removeForRequest(listingId, requestId, removal);
      }
      // Marked before the purge, so a crash or exhausted retries leave the request OPEN.
      await deps.requests.markIncomplete(requestId, listingId);
      const { complete } = await purgeListingData(listingId);
      if (complete) await deps.requests.markComplete(requestId, listingId);
      return { removed, complete };
    },

    async finalize({ requestId }) {
      const current = await load(requestId);
      if (current.status !== 'EXECUTED' && !(await purgeIncomplete(requestId))) return current;
      const record =
        current.status === 'EXECUTED'
          ? current
          : await deps.requests.markExecuted(requestId, now());
      if (record === null) throw new DeletionRequestNotFoundError(requestId);
      // Stable id + the stored `executedAt`: a re-run rewrites the same audit entry.
      await deps.audit.append({
        type: 'deletion',
        action: DELETION_EXECUTED_ACTION,
        actor: record.requestedBy,
        at: record.executedAt ?? now(),
        id: record.requestId,
        details: deletionAuditDetails(record),
      });
      return record;
    },
  };
}

/** Runs all steps of one request in-process, in workflow order (tests, local runs). */
export async function runDeletionWorkflow(
  workflow: DeletionWorkflow,
  requestId: string,
): Promise<DeletionRequestRecord> {
  let cursor: string | undefined;
  do {
    const page = await workflow.resolveTargets({
      requestId,
      ...(cursor !== undefined && { cursor }),
    });
    for (const target of page.targets) await workflow.deleteListing({ requestId, ...target });
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return workflow.finalize({ requestId });
}

export type { DeletionWorkflowStarter };

/** Runs the workflow to completion inside `start`; `started` records the request ids. */
export class InProcessDeletionWorkflowStarter implements DeletionWorkflowStarter {
  readonly started: string[] = [];

  constructor(private readonly workflow: DeletionWorkflow) {}

  async start(requestId: string): Promise<void> {
    this.started.push(requestId);
    await runDeletionWorkflow(this.workflow, requestId);
  }
}

/** Input of a deletion workflow execution. */
export interface DeletionExecutionInput {
  requestId: string;
}

export interface StepFunctionsDeletionWorkflowStarterOptions {
  client: SFNClient;
  stateMachineArn: string;
}

/**
 * `StartExecution` named after the request id: a repeated start with the same input returns
 * the running execution instead of starting a second one (standard workflows).
 */
export class StepFunctionsDeletionWorkflowStarter implements DeletionWorkflowStarter {
  private readonly client: SFNClient;
  private readonly stateMachineArn: string;

  constructor({ client, stateMachineArn }: StepFunctionsDeletionWorkflowStarterOptions) {
    this.client = client;
    this.stateMachineArn = stateMachineArn;
  }

  async start(requestId: string): Promise<void> {
    const input: DeletionExecutionInput = { requestId };
    await this.client.send(
      new StartExecutionCommand({
        stateMachineArn: this.stateMachineArn,
        name: requestId,
        input: JSON.stringify(input),
      }),
    );
  }
}
