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
import {
  InMemoryListingHistoryStore,
  InMemoryListingKeyStore,
  InMemoryListingVersionStore,
  InMemoryMetricCounterStore,
  InMemorySnapshotStore,
  type Clock,
  type ListingHistoryStore,
} from '@open-estate/core';

export interface DeletionHarnessOptions {
  clock?: Clock;
  /** Backing map of the listing store; share it with other fakes to observe removals. */
  listings?: Map<string, StoredListingKey>;
  /** E.g. ingestion's `InMemoryDeletionBlocklist`, so the import pipeline sees the blocks. */
  blocklistMirror?: BlocklistIdMirror;
  audit?: InMemoryAuditLog;
  pageSize?: number;
  /** Stores of the versioned write path; share them with a `VersionedListingWriter`. */
  versions?: InMemoryListingVersionStore;
  snapshots?: InMemorySnapshotStore;
  keys?: InMemoryListingKeyStore;
  counters?: InMemoryMetricCounterStore;
  /** Replaces the history store built from `versions` and `snapshots` (e.g. a failing one). */
  history?: ListingHistoryStore;
}

export function createDeletionHarness(options: DeletionHarnessOptions = {}) {
  const audit = options.audit ?? new InMemoryAuditLog();
  const requests = new InMemoryDeletionRequestStore();
  const versions = options.versions ?? new InMemoryListingVersionStore();
  const snapshots = options.snapshots ?? new InMemorySnapshotStore();
  const keys = options.keys ?? new InMemoryListingKeyStore();
  const counters = options.counters ?? new InMemoryMetricCounterStore();
  const history = options.history ?? new InMemoryListingHistoryStore({ versions, snapshots });
  const listings = new InMemoryDeletionListingStore({
    requests,
    keys,
    counters,
    ...(options.listings !== undefined && { listings: options.listings }),
  });
  const blocklist = new InMemoryDeletionBlocklistStore(options.blocklistMirror);
  const workflow = createDeletionWorkflow({
    requests,
    listings,
    blocklist,
    history,
    audit,
    ...(options.clock !== undefined && { clock: options.clock }),
    ...(options.pageSize !== undefined && { pageSize: options.pageSize }),
  });
  const starter = new InProcessDeletionWorkflowStarter(workflow);
  const deletions: DeletionAdminDeps = { requests, listings, blocklist, starter };
  return {
    audit,
    requests,
    listings,
    blocklist,
    versions,
    snapshots,
    keys,
    counters,
    history,
    workflow,
    starter,
    deletions,
  };
}
