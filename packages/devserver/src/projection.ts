import {
  fromManagedListingItem,
  InMemorySearchProvider,
  type InMemoryManagedListingStore,
  type ResolvedQuery,
  type SearchProvider,
  type SearchResult,
  type StoredListing,
} from '@open-estate/core';

// DEV ONLY: the search index of the local demo. In AWS the `Listings` table is mirrored into the
// index by the stream indexer (asynchronously, via DynamoDB Streams). Locally every read
// projects the current in-memory listings into a fresh `InMemorySearchProvider`, so a listing
// written through the Management_API is searchable immediately. Visibility rules are the
// provider's (only `ACTIVE` listings are searched) plus the SearchService's agency suspension.

export class ManagedListingProjection implements SearchProvider {
  constructor(private readonly store: Pick<InMemoryManagedListingStore, 'all'>) {}

  /** Index over the current state of the store. */
  snapshot(): InMemorySearchProvider {
    const provider = new InMemorySearchProvider();
    for (const item of this.store.all()) {
      const { listing, management } = fromManagedListingItem(item);
      provider.put(listing, {
        status: management.status,
        ...(management.agencyId !== undefined && { agencyId: management.agencyId }),
      });
    }
    return provider;
  }

  search(query: ResolvedQuery): Promise<SearchResult> {
    return this.snapshot().search(query);
  }

  getById(id: string): Promise<StoredListing | null> {
    return this.snapshot().getById(id);
  }
}
