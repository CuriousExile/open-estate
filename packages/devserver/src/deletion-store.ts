import type {
  DeletionListingState,
  DeletionTarget,
  InMemoryDeletionRequestStore,
  ListingRemoval,
  TargetPage,
  TargetPageRequest,
  VersionedDeletionListingStore,
} from '@open-estate/admin';
import {
  fromManagedListingItem,
  type InMemoryListingKeyStore,
  type InMemoryManagedListingStore,
  type InMemoryMetricCounterStore,
  type InMemoryOp,
} from '@open-estate/core';
import { flagCodes } from '@open-estate/shared';

// DEV ONLY: deletion side of the in-memory `Listings` table. The admin package's
// `InMemoryDeletionListingStore` keeps its own map; this adapter works on the managed listing
// store shared with the Management_API and the search projection, so a deletion request run
// in-process really removes the listing everywhere (like the DynamoDB store's transaction).

export interface ManagedDeletionListingStoreDeps {
  listings: InMemoryManagedListingStore;
  requests: InMemoryDeletionRequestStore;
  keys: InMemoryListingKeyStore;
  counters: InMemoryMetricCounterStore;
}

export class ManagedDeletionListingStore implements VersionedDeletionListingStore {
  constructor(private readonly deps: ManagedDeletionListingStoreDeps) {}

  async find(listingId: string): Promise<DeletionTarget | null> {
    const managed = await this.deps.listings.get(listingId);
    return managed === null ? null : { listingId, source: managed.listing.source };
  }

  async listBySource(source: string, { limit, cursor }: TargetPageRequest): Promise<TargetPage> {
    const ids = this.deps.listings
      .all()
      .filter((item) => item.source === source && (cursor === undefined || item.id > cursor))
      .map((item) => item.id)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const page = ids.slice(0, limit);
    const last = page.at(-1);
    return {
      targets: page.map((listingId) => ({ listingId, source })),
      ...(ids.length > limit && last !== undefined && { nextCursor: last }),
    };
  }

  async inspect(listingId: string): Promise<DeletionListingState | null> {
    const item = this.deps.listings.all().find((candidate) => candidate.id === listingId);
    if (item === undefined) return null;
    const { listing, management } = fromManagedListingItem(item);
    return {
      listingId,
      source: listing.source,
      status: management.status,
      ...(management.agencyId !== undefined && { agencyId: management.agencyId }),
      ...(management.customId !== undefined && { customId: management.customId }),
      ...(management.flags !== undefined && { flagCodes: flagCodes(management.flags) }),
    };
  }

  async removeForRequest(
    listingId: string,
    requestId: string,
    { customKey, counters = [] }: ListingRemoval = {},
  ): Promise<boolean> {
    const { listings, requests, keys } = this.deps;
    if (!requests.has(requestId)) throw new Error(`Deletion request ${requestId} not found`);
    if ((await listings.get(listingId)) === null) return false;
    const ops: InMemoryOp[] = [
      ...(customKey === undefined
        ? []
        : [keys.releaseOp(customKey.owner, customKey.customId, listingId)]),
      ...counters.map((increment) => this.deps.counters.addOp(increment)),
    ];
    const failed = ops.filter((op) => !op.check()).map((op) => op.label);
    if (failed.length > 0) {
      throw new Error(`Inconsistent removal of listing ${listingId}: ${failed.join(', ')}`);
    }
    listings.remove(listingId);
    for (const op of ops) op.apply();
    requests.incrementRemoved(requestId);
    return true;
  }
}
