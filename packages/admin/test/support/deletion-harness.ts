// In-memory deletion setup shared by the deletion unit tests and the property tests 14.4–14.6.
import {
  createDeletionWorkflow,
  InMemoryAuditLog,
  InMemoryDeletionBlocklistStore,
  InMemoryDeletionListingStore,
  InMemoryDeletionRequestStore,
  InProcessDeletionWorkflowStarter,
  type BlocklistIdMirror,
  type DeletionAdminDeps,
  type StoredListingKey,
} from '@open-estate/admin';
import type { Clock } from '@open-estate/core';

export interface DeletionHarnessOptions {
  clock?: Clock;
  /** Backing map of the listing store; share it with other fakes to observe removals. */
  listings?: Map<string, StoredListingKey>;
  /** E.g. ingestion's `InMemoryDeletionBlocklist`, so the import pipeline sees the blocks. */
  blocklistMirror?: BlocklistIdMirror;
  audit?: InMemoryAuditLog;
  pageSize?: number;
}

export function createDeletionHarness(options: DeletionHarnessOptions = {}) {
  const audit = options.audit ?? new InMemoryAuditLog();
  const requests = new InMemoryDeletionRequestStore();
  const listings = new InMemoryDeletionListingStore({
    requests,
    ...(options.listings !== undefined && { listings: options.listings }),
  });
  const blocklist = new InMemoryDeletionBlocklistStore(options.blocklistMirror);
  const workflow = createDeletionWorkflow({
    requests,
    listings,
    blocklist,
    audit,
    ...(options.clock !== undefined && { clock: options.clock }),
    ...(options.pageSize !== undefined && { pageSize: options.pageSize }),
  });
  const starter = new InProcessDeletionWorkflowStarter(workflow);
  const deletions: DeletionAdminDeps = { requests, listings, blocklist, starter };
  return { audit, requests, listings, blocklist, workflow, starter, deletions };
}
