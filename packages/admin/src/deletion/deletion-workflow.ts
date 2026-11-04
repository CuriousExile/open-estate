import { StartExecutionCommand, type SFNClient } from '@aws-sdk/client-sfn';
import { systemClock, type Clock } from '@open-estate/core';
import type { AuditLog } from '../audit-log';
import type { DeletionBlocklistStore } from './deletion-blocklist-store';
import type { DeletionListingStore } from './deletion-listing-store';
import {
  DeletionRequestNotFoundError,
  type DeletionRequestRecord,
  type DeletionTarget,
  type TargetPage,
} from './deletion-model';
import type { DeletionRequestStore } from './deletion-request-store';

/** Default number of targets per `resolveTargets` page (one Step Functions Map iteration). */
export const DELETION_TARGET_PAGE_SIZE = 100;

/** `action` of the `deletion` audit entry written when a request is executed (Req 18.8). */
export const DELETION_EXECUTED_ACTION = 'deletion.executed';

export interface DeletionWorkflowDeps {
  requests: DeletionRequestStore;
  listings: DeletionListingStore;
  blocklist: DeletionBlocklistStore;
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
}

export interface FinalizeInput {
  requestId: string;
}

/**
 * Steps of the deletion workflow (design: "Admin-API und Löschprozess", steps 3–4). Each step is
 * idempotent, so Step Functions retries and re-runs are safe. Run order per request:
 * `resolveTargets` (paged) → `deleteListing` per target → `finalize`.
 */
export interface DeletionWorkflow {
  /** One page of affected listings for the request's criterion. */
  resolveTargets(input: ResolveTargetsInput): Promise<TargetPage>;
  /** First blocks the id (Req 18.6), then removes the listing (Req 18.4). */
  deleteListing(input: DeleteListingInput): Promise<DeleteListingOutput>;
  /** `EXECUTED` + audit `{requestedAt, executedAt, requestedBy, criterion, removedCount}`. */
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

export function createDeletionWorkflow(deps: DeletionWorkflowDeps): DeletionWorkflow {
  const clock = deps.clock ?? systemClock;
  const pageSize = deps.pageSize ?? DELETION_TARGET_PAGE_SIZE;
  const now = () => new Date(clock()).toISOString();

  async function load(requestId: string): Promise<DeletionRequestRecord> {
    const record = await deps.requests.get(requestId);
    if (record === null) throw new DeletionRequestNotFoundError(requestId);
    return record;
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
      // Order matters: once blocked, no import can re-create the listing (the writer's
      // transaction checks the blocklist), so the subsequent removal is final.
      await deps.blocklist.block({ listingId, source, requestId, deletedAt: now() });
      const removed = await deps.listings.removeForRequest(listingId, requestId);
      return { removed };
    },

    async finalize({ requestId }) {
      const current = await load(requestId);
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

/** Starts the deletion workflow for a created `OPEN` request (design step 2). */
export interface DeletionWorkflowStarter {
  start(requestId: string): Promise<void>;
}

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
