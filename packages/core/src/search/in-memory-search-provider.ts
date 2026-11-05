import type { Listing } from '@open-estate/shared';
import type { ListingVisibility } from './listings-table';
import { toSearchDocument, type SearchDocument } from './search-document';
import {
  compareById,
  matchesQuery,
  paginate,
  type ResolvedQuery,
  type SearchProvider,
  type SearchResult,
  type StoredListing,
  withOwners,
} from './search-provider';

interface Entry {
  listing: Listing;
  visibility: ListingVisibility;
  doc: SearchDocument;
}

/**
 * In-memory reference provider for tests and local development: evaluates every primitive
 * condition of the `ResolvedQuery` on the flat search document, orders by `id ASC` and
 * paginates with `pageSize + 1` lookahead. Like the sparse `byId` GSI, only `ACTIVE` listings
 * are searched; `getById` returns every stored listing with its visibility.
 */
export class InMemorySearchProvider implements SearchProvider {
  private readonly entries = new Map<string, Entry>();

  constructor(listings: readonly Listing[] = []) {
    for (const listing of listings) this.put(listing);
  }

  /**
   * Inserts or replaces a listing (keyed by `id`); the search document is derived on write.
   * Without `visibility` the listing is `ACTIVE` without agency (like a seeded listing).
   */
  put(listing: Listing, visibility: ListingVisibility = { status: 'ACTIVE' }): void {
    this.entries.set(listing.id, {
      listing,
      visibility,
      doc: toSearchDocument(listing, visibility.agencyId),
    });
  }

  async search(q: ResolvedQuery): Promise<SearchResult> {
    const matches = [...this.entries.values()]
      .filter(({ visibility, doc }) => visibility.status === 'ACTIVE' && matchesQuery(doc, q))
      .map(({ listing }) => listing)
      .sort(compareById);
    return withOwners(paginate(matches, q), (id) => this.entries.get(id)?.visibility.agencyId);
  }

  async getById(id: string): Promise<StoredListing | null> {
    const entry = this.entries.get(id);
    return entry === undefined ? null : { listing: entry.listing, visibility: entry.visibility };
  }
}
