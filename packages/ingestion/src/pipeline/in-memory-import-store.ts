import {
  DuplicateDetector,
  fromManagedListingItem,
  InMemoryDuplicateIndexStore,
  InMemoryListingKeyStore,
  InMemoryListingVersionStore,
  InMemoryManagedListingStore,
  InMemoryMetricCounterStore,
  InMemorySnapshotStore,
  InMemoryTransactor,
  systemClock,
  VersionedListingWriter,
  type Clock,
  type InMemoryOp,
  type ManagedListing,
} from '@open-estate/core';
import {
  DEFAULT_DUPLICATE_CONFIG,
  type DuplicateConfig,
  type Listing,
  type Taxonomy,
} from '@open-estate/shared';
import { InMemoryDeletionBlocklist } from './deletion-blocklist';
import type { ImportTargetReader } from './import-target';

export interface InMemoryImportStoreOptions {
  /** Shared with a deletion workflow in tests; checked by identity resolution and writer. */
  readonly blocklist?: InMemoryDeletionBlocklist;
  /** Time of versions and provenance (`lastImportedAt`). */
  readonly clock?: Clock;
  /**
   * Duplikat-Erkennung (duplicate-detection Req 5, 6): with it, the writer keeps an in-memory
   * Duplikat_Index and `detector` checks like the production wiring.
   */
  readonly duplicates?: { readonly taxonomy: Taxonomy; readonly config?: DuplicateConfig };
}

/**
 * In-memory listing stores and `VersionedListingWriter` for tests and local runs: `reader` and
 * `writer` are the import pipeline's dependencies, the rest is exposed for assertions.
 */
export class InMemoryImportStore {
  readonly listings = new InMemoryManagedListingStore();
  readonly keys = new InMemoryListingKeyStore();
  readonly versions = new InMemoryListingVersionStore();
  readonly counters = new InMemoryMetricCounterStore();
  readonly snapshots = new InMemorySnapshotStore();
  readonly blocklist: InMemoryDeletionBlocklist;
  readonly writer: VersionedListingWriter<InMemoryOp>;
  readonly reader: ImportTargetReader;
  readonly duplicateIndex = new InMemoryDuplicateIndexStore();
  /** Duplikat_Prüfung for the pipeline; `undefined` without the `duplicates` option. */
  readonly detector: DuplicateDetector | undefined;

  constructor({
    blocklist = new InMemoryDeletionBlocklist(),
    clock = systemClock,
    duplicates,
  }: InMemoryImportStoreOptions = {}) {
    this.blocklist = blocklist;
    this.detector =
      duplicates === undefined
        ? undefined
        : new DuplicateDetector({
            index: this.duplicateIndex,
            taxonomy: duplicates.taxonomy,
            config: duplicates.config ?? DEFAULT_DUPLICATE_CONFIG,
          });
    this.writer = new VersionedListingWriter({
      listings: this.listings,
      versions: this.versions,
      keys: this.keys,
      blocklist,
      counters: this.counters,
      snapshots: this.snapshots,
      transactor: new InMemoryTransactor(),
      clock,
      ...(this.detector !== undefined && {
        duplicates: { index: this.duplicateIndex, detector: this.detector },
      }),
    });
    this.reader = { listings: this.listings, keys: this.keys, blocklist };
  }

  /**
   * Writes `listing` as an import of connector `listing.source` in run `listing.lastRunId`
   * (status `ACTIVE`, no agency); `lastImportedAt` is the clock's time. Seeds tests with a state.
   */
  async seed(listing: Listing): Promise<ManagedListing> {
    const current = await this.listings.get(listing.id);
    const result = await this.writer.write({
      listingId: listing.id,
      expectedVersion: current?.management.version ?? null,
      next: { content: listing, status: 'ACTIVE' },
      changeType: 'IMPORT',
      channel: 'IMPORT',
      actor: { kind: 'connector', connectorId: listing.source, runId: listing.lastRunId },
    });
    if (!result.ok) throw new Error(`Seeding ${listing.id} failed: ${result.error.code}`);
    return result.value.listing;
  }

  /** Stored listing with management attributes, or `undefined`. */
  managed(id: string): ManagedListing | undefined {
    const item = this.listings.all().find((stored) => stored.id === id);
    return item === undefined ? undefined : fromManagedListingItem(item);
  }

  /** Stored public listing (content and provenance), or `undefined`. */
  get(id: string): Listing | undefined {
    return this.managed(id)?.listing;
  }

  get size(): number {
    return this.listings.all().length;
  }
}
