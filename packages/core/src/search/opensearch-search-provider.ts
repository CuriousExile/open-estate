import type { Listing } from '@open-estate/shared';
import { DOWNSTREAM_DEADLINE_MS } from '../deadlines';
import { toSearchDocument, type SearchDocument } from './search-document';
import {
  effectivePageSize,
  type IntRange,
  type ResolvedQuery,
  type SearchProvider,
  type SearchResult,
  type StoredListing,
  withOwners,
} from './search-provider';
import { ServiceUnavailableError } from './service-unavailable-error';

// OpenSearch provider (design: "Indexierungs-Strategie und Ordnung", production recommendation
// OpenSearch Serverless). The index holds the flat search document plus the listing itself as a
// non-indexed object; queries are `bool.filter` over the flat fields, ordered by `id ASC` and
// paginated with `search_after` (Serverless has no point-in-time; `id` is unique, so the order is
// total and stable without one).

/** Downstream budget per request (Req 9.1, 9.6); the shared `DOWNSTREAM_DEADLINE_MS`. */
export const OPENSEARCH_REQUEST_DEADLINE_MS = DOWNSTREAM_DEADLINE_MS;

/** Index mapping; the indexer (Task 18.2) creates the index with it. */
export const OPENSEARCH_INDEX_MAPPING = {
  dynamic: 'strict',
  properties: {
    id: { type: 'keyword' },
    cityNorm: { type: 'keyword' },
    postalCode: { type: 'keyword' },
    country: { type: 'keyword' },
    listingType: { type: 'keyword' },
    saleAmountMinor: { type: 'long' },
    saleCurrency: { type: 'keyword' },
    rentAmountMinor: { type: 'long' },
    rentCurrency: { type: 'keyword' },
    roomsHalf: { type: 'integer' },
    areaMinor: { type: 'long' },
    tourHosts: { type: 'keyword' },
    agencyId: { type: 'keyword' },
    // Stored in `_source` only; returned as-is so that no second lookup is needed.
    listing: { type: 'object', enabled: false },
  },
} as const;

/** Indexed document: flat search fields + the internal listing (not indexed). */
export type OpenSearchDocument = SearchDocument & { listing: Listing };

/** Single source for the document layout in the OpenSearch index (indexer, provider). */
export function toOpenSearchDocument(listing: Listing, agencyId?: string): OpenSearchDocument {
  return { ...toSearchDocument(listing, agencyId), listing };
}

/** Inverse of {@link toOpenSearchDocument}; not re-validated (see `fromListingItem`). */
export function fromOpenSearchDocument(source: Pick<OpenSearchDocument, 'listing'>): Listing {
  return source.listing;
}

type Field = keyof SearchDocument;

export type OpenSearchFilterClause =
  | { term: Partial<Record<Field, string>> }
  | { terms: Partial<Record<Field, string[]>> }
  | { range: Partial<Record<Field, { gte?: number; lte?: number }>> }
  | { exists: { field: Field } };

export interface OpenSearchSearchBody {
  size: number;
  query: { bool: { filter: OpenSearchFilterClause[]; must_not?: OpenSearchFilterClause[] } };
  sort: [{ id: 'asc' }];
  search_after?: [string];
  track_total_hits: false;
  // `agencyId` for usage counting (`SearchResult.owners`, Req 13.4).
  _source: ['listing', 'agencyId'];
}

function range(field: Field, r: IntRange | undefined, out: OpenSearchFilterClause[]): void {
  if (r === undefined || (r.min === undefined && r.max === undefined)) return;
  out.push({
    range: {
      [field]: {
        ...(r.min !== undefined ? { gte: r.min } : {}),
        ...(r.max !== undefined ? { lte: r.max } : {}),
      },
    },
  });
}

/** Filter clauses over the flat search fields; semantics of `matchesQuery` (pure). */
export function buildOpenSearchFilter(q: ResolvedQuery): OpenSearchFilterClause[] {
  const filter: OpenSearchFilterClause[] = [];
  if (q.offerType !== undefined) {
    const [amount, currency]: [Field, Field] =
      q.offerType === 'SALE'
        ? ['saleAmountMinor', 'saleCurrency']
        : ['rentAmountMinor', 'rentCurrency'];
    filter.push({ exists: { field: amount } });
    if (q.price !== undefined) {
      filter.push({ term: { [currency]: q.price.currency } });
      range(amount, q.price, filter);
    }
  }
  range('roomsHalf', q.roomsHalf, filter);
  range('areaMinor', q.areaMinor, filter);
  if (q.cityNorm !== undefined) filter.push({ term: { cityNorm: q.cityNorm } });
  if (q.postalCode !== undefined) filter.push({ term: { postalCode: q.postalCode } });
  if (q.listingTypes !== undefined) filter.push({ terms: { listingType: [...q.listingTypes] } });
  // `terms` on the multi-valued keyword field: at least one host in the current allow-list.
  if (q.tourHosts !== undefined) filter.push({ terms: { tourHosts: [...q.tourHosts] } });
  return filter;
}

/**
 * Search body for one page (pure): `pageSize + 1` hits as lookahead for `next`, `id ASC`,
 * exclusive start via `search_after`. `null` when an empty type or host set can match nothing,
 * so no request is necessary.
 */
export function buildOpenSearchSearchBody(q: ResolvedQuery): OpenSearchSearchBody | null {
  if (q.listingTypes?.length === 0 || q.tourHosts?.length === 0) return null;
  const excluded = q.excludeAgencies ?? [];
  return {
    size: effectivePageSize(q.pageSize) + 1,
    query: {
      bool: {
        filter: buildOpenSearchFilter(q),
        // Suspended owners (Req 1.9); documents without `agencyId` never match `terms`.
        ...(excluded.length > 0 ? { must_not: [{ terms: { agencyId: [...excluded] } }] } : {}),
      },
    },
    sort: [{ id: 'asc' }],
    ...(q.after !== undefined ? { search_after: [q.after] as [string] } : {}),
    track_total_hits: false,
    _source: ['listing', 'agencyId'],
  };
}

/** Request promise of the OpenSearch client (`TransportRequestPromise`). */
export type OpenSearchRequest<T> = Promise<T> & { abort?: () => void };

export interface OpenSearchRequestOptions {
  requestTimeout: number;
  maxRetries: number;
}

/** The part of `@opensearch-project/opensearch`'s `Client` the provider uses. */
export interface OpenSearchClientLike {
  search(
    params: { index: string; body: Record<string, unknown> },
    options: OpenSearchRequestOptions,
  ): OpenSearchRequest<{ body: unknown }>;
}

export interface OpenSearchSearchProviderOptions {
  client: OpenSearchClientLike;
  index: string;
  /** Deadline for one `search`/`getById` call. */
  deadlineMs?: number;
  /** Creates the deadline signal; injectable for tests. Defaults to `AbortSignal.timeout`. */
  deadlineSignal?: (ms: number) => AbortSignal;
}

interface Hit {
  _source?: { listing?: Listing; agencyId?: unknown };
}

/**
 * Hits as stored listings. The index only holds `ACTIVE` listings (the indexer removes inactive
 * ones), so every hit is `ACTIVE`; the owner comes from the document's `agencyId`.
 */
function storedListingsOf(body: unknown): StoredListing[] {
  const hits = (body as { hits?: { hits?: unknown } } | undefined)?.hits?.hits;
  if (!Array.isArray(hits)) throw new Error('OpenSearch response without hits');
  return hits.map((hit: Hit) => {
    if (hit._source?.listing === undefined) throw new Error('OpenSearch hit without listing');
    const { agencyId } = hit._source;
    return {
      listing: fromOpenSearchDocument({ listing: hit._source.listing }),
      visibility:
        typeof agencyId === 'string' ? { status: 'ACTIVE', agencyId } : { status: 'ACTIVE' },
    };
  });
}

/**
 * Production provider. Every failure, malformed response or deadline overrun surfaces as
 * {@link ServiceUnavailableError} without a partial result (Req 9.5, 9.6).
 */
export class OpenSearchSearchProvider implements SearchProvider {
  private readonly client: OpenSearchClientLike;
  private readonly index: string;
  private readonly deadlineMs: number;
  private readonly deadlineSignal: (ms: number) => AbortSignal;

  constructor({
    client,
    index,
    deadlineMs = OPENSEARCH_REQUEST_DEADLINE_MS,
    deadlineSignal = (ms) => AbortSignal.timeout(ms),
  }: OpenSearchSearchProviderOptions) {
    this.client = client;
    this.index = index;
    this.deadlineMs = deadlineMs;
    this.deadlineSignal = deadlineSignal;
  }

  async search(q: ResolvedQuery): Promise<SearchResult> {
    const body = buildOpenSearchSearchBody(q);
    if (body === null) return { items: [] };
    const pageSize = effectivePageSize(q.pageSize);
    const found = await this.query({ ...body });
    const owners = new Map(found.map((m) => [m.listing.id, m.visibility.agencyId]));
    const matches = found.map(({ listing }) => listing);
    if (matches.length <= pageSize) {
      return withOwners({ items: matches }, (id) => owners.get(id));
    }
    const items = matches.slice(0, pageSize);
    return withOwners({ items, next: { lastId: (items[pageSize - 1] as Listing).id } }, (id) =>
      owners.get(id),
    );
  }

  async getById(id: string): Promise<StoredListing | null> {
    const [found] = await this.query({
      size: 1,
      query: { bool: { filter: [{ term: { id } }] } },
      track_total_hits: false,
      _source: ['listing', 'agencyId'],
    });
    return found ?? null;
  }

  private async query(body: Record<string, unknown>): Promise<StoredListing[]> {
    const signal = this.deadlineSignal(this.deadlineMs);
    try {
      signal.throwIfAborted();
      const request = this.client.search(
        { index: this.index, body },
        // Retries would exceed the budget; the client timeout backs up the deadline signal.
        { requestTimeout: this.deadlineMs, maxRetries: 0 },
      );
      const response = await new Promise<{ body: unknown }>((resolve, reject) => {
        const onAbort = () => {
          request.abort?.();
          reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        request.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
      });
      return storedListingsOf(response.body);
    } catch (cause) {
      const message = signal.aborted
        ? `OpenSearch deadline of ${this.deadlineMs} ms exceeded`
        : 'OpenSearch request failed';
      throw new ServiceUnavailableError(message, { cause });
    }
  }
}
