import type { Listing } from '@open-estate/shared';
import { toSearchDocument, type SearchDocument } from './search-document';
import {
  compareById,
  matchesQuery,
  paginate,
  type ResolvedQuery,
  type SearchProvider,
  type SearchResult,
} from './search-provider';

/**
 * In-memory reference provider for tests and local development: evaluates every primitive
 * condition of the `ResolvedQuery` on the flat search document, orders by `id ASC` and
 * paginates with `pageSize + 1` lookahead.
 */
export class InMemorySearchProvider implements SearchProvider {
  private readonly entries = new Map<string, { listing: Listing; doc: SearchDocument }>();

  constructor(listings: readonly Listing[] = []) {
    for (const listing of listings) this.put(listing);
  }

  /** Inserts or replaces a listing (keyed by `id`); the search document is derived on write. */
  put(listing: Listing): void {
    this.entries.set(listing.id, { listing, doc: toSearchDocument(listing) });
  }

  async search(q: ResolvedQuery): Promise<SearchResult> {
    const matches = [...this.entries.values()]
      .filter(({ doc }) => matchesQuery(doc, q))
      .map(({ listing }) => listing)
      .sort(compareById);
    return paginate(matches, q);
  }

  async getById(id: string): Promise<Listing | null> {
    return this.entries.get(id)?.listing ?? null;
  }
}
