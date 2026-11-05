import type { CityFacet, Cursor, Listing, LocationsDocument, OfferType } from '@open-estate/shared';
import type { ListingVisibility } from './listings-table';
import { normalizeCity, type SearchDocument } from './search-document';

// SearchProvider contract (design: "Domänenkern", "Indexierungs-Strategie und Ordnung").
// The SearchService (Task 6.4) resolves a validated `SearchQuery` into primitive conditions:
// group → type codes, hasTour → currently allowed tour hosts, price → minor units, missing
// currency → default currency, city → `normalizeCity`, pageToken → `after` (decoded cursor).
// The provider never sees taxonomy, tour allow-list or cursor hashing.

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/** Inclusive integer range; an omitted bound is unbounded. */
export interface IntRange {
  min?: number;
  max?: number;
}

/** Price condition on the offer of the selected offer type (Req 12.7, 12.9). */
export interface PriceCondition extends IntRange {
  /** Amounts in minor units (SALE: price, RENT: cold rent). */
  currency: string;
}

/**
 * Price conditions, OR-combined: one per currency. Without currency conversion there is exactly
 * one (the requested currency); with `convertCurrency=true` the SearchService adds the converted
 * bounds of every currency with an exchange rate.
 */
export type PriceConditions = readonly [PriceCondition, ...PriceCondition[]];

/** A price condition only exists together with an offer type (Req 12.8). */
export type OfferCondition =
  | { offerType?: undefined; price?: undefined }
  | {
      /** Listing must have an offer of this type (Req 12.6). */
      offerType: OfferType;
      price?: PriceConditions;
    };

/** Query as seen by a provider: validated and resolved; all conditions are AND-combined. */
export type ResolvedQuery = OfferCondition & {
  /** Rooms × 2, inclusive. */
  roomsHalf?: IntRange;
  /** Area in hundredths of m², inclusive. */
  areaMinor?: IntRange;
  /** Already normalized with `normalizeCity` (Req 1.3). */
  cityNorm?: string;
  /** Exact match (Req 1.4). */
  postalCode?: string;
  /** `address.country`, ISO 3166-1 alpha-2, exact match. */
  country?: string;
  /** Listing type must be one of these codes (from `group` or `types`, Req 15.5, 15.6). */
  listingTypes?: readonly string[];
  /** `hasTour=true`: at least one tour host must be in this lowercase set (Req 16.9). */
  tourHosts?: readonly string[];
  /**
   * Suspended agencies (non-empty when set): listings owned by one of them are excluded; listings
   * without agency are unaffected (Req 1.9, design: "Öffentliche Sichtbarkeit").
   */
  excludeAgencies?: readonly string[];
  /** 1–50; defaults to 20 when omitted (Req 1.5, 1.6). */
  pageSize?: number;
  /** Exclusive start: only ids greater than this (`lastId` of the decoded cursor, Req 1.7). */
  after?: string;
};

/** Position of the next page; the SearchService adds `queryHash` and encodes the token. */
export type NextPage = Pick<Cursor, 'lastId'>;

export interface SearchResult {
  /** Matching listings in global `id ASC` order, at most `pageSize` items. */
  items: Listing[];
  /** Set iff more matching listings follow (Req 1.7). */
  next?: NextPage;
  /**
   * Owning agency per listing id of `items`, only for listings with agency; omitted when no item
   * has one. Not part of any response: used for usage counting (Req 13.4).
   */
  owners?: Readonly<Record<string, string>>;
}

/** `owners` of a result page from its stored listings ({@link SearchResult.owners}). */
export function withOwners(
  result: SearchResult,
  agencyOf: (id: string) => string | undefined,
): SearchResult {
  const owners: Record<string, string> = {};
  for (const { id } of result.items) {
    const agencyId = agencyOf(id);
    if (agencyId !== undefined) owners[id] = agencyId;
  }
  return Object.keys(owners).length === 0 ? result : { ...result, owners };
}

/**
 * A stored listing with the management data that decides its public visibility. Listings without
 * management data (seeded, legacy imports) are `ACTIVE` without agency.
 */
export interface StoredListing {
  listing: Listing;
  visibility: ListingVisibility;
}

export interface SearchProvider {
  /** Only `ACTIVE` listings are searched; `excludeAgencies` removes suspended owners. */
  search(q: ResolvedQuery): Promise<SearchResult>;
  /** The stored listing regardless of visibility; the ListingService applies `isPublic`. */
  getById(id: string): Promise<StoredListing | null>;
  /**
   * Countries and cities of the `ACTIVE` listings with their counts (`GET /locations`); same
   * visibility as {@link search} without any other filter.
   */
  locations(q: LocationQuery): Promise<LocationsDocument>;
}

/** Visibility conditions of {@link SearchProvider.locations}. */
export interface LocationQuery {
  /** Suspended agencies (non-empty when set), as in {@link ResolvedQuery.excludeAgencies}. */
  excludeAgencies?: readonly string[];
}

/** Location fields of one `ACTIVE` listing, input of {@link aggregateLocations}. */
export interface LocationEntry {
  country: string;
  /** `address.city` as stored. */
  city: string;
  agencyId?: string;
}

/**
 * Reference aggregation of `GET /locations` (pure): drops listings of excluded agencies, counts
 * listings per country and per city. Cities are grouped per country by {@link normalizeCity} —
 * the same case-insensitive match as the `city` filter — so every name filters to its count; the
 * most frequent spelling is shown (ties: lowest in code point order). Countries are ordered by
 * code, cities by country, then name.
 */
export function aggregateLocations(
  entries: Iterable<LocationEntry>,
  q: LocationQuery = {},
): LocationsDocument {
  const excluded = new Set(q.excludeAgencies ?? []);
  const countries = new Map<string, number>();
  const cities = new Map<string, { country: string; count: number; names: Map<string, number> }>();
  for (const entry of entries) {
    if (entry.agencyId !== undefined && excluded.has(entry.agencyId)) continue;
    countries.set(entry.country, (countries.get(entry.country) ?? 0) + 1);
    const key = `${entry.country}\u0000${normalizeCity(entry.city)}`;
    const city = cities.get(key) ?? { country: entry.country, count: 0, names: new Map() };
    city.count += 1;
    city.names.set(entry.city, (city.names.get(entry.city) ?? 0) + 1);
    cities.set(key, city);
  }
  return {
    countries: [...countries]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => compareCodePoints(a.code, b.code)),
    cities: [...cities.values()]
      .map(({ country, count, names }) => ({ name: preferredName(names), country, count }))
      .sort(compareCities),
  };
}

function preferredName(names: ReadonlyMap<string, number>): string {
  let best: [string, number] | undefined;
  for (const candidate of names) {
    if (
      best === undefined ||
      candidate[1] > best[1] ||
      (candidate[1] === best[1] && compareCodePoints(candidate[0], best[0]) < 0)
    ) {
      best = candidate;
    }
  }
  return best?.[0] ?? '';
}

/** Order of `cities` in a {@link LocationsDocument}: country, then name (code points). */
export function compareCities(a: CityFacet, b: CityFacet): number {
  return compareCodePoints(a.country, b.country) || compareCodePoints(a.name, b.name);
}

/**
 * Effective page size. Range validation (400 `INVALID_PAGE_SIZE`, Req 1.11) happens before the
 * provider is called; this only applies the default and guards the upper bound defensively.
 */
export function effectivePageSize(pageSize: number | undefined): number {
  if (pageSize === undefined) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(pageSize), 1), MAX_PAGE_SIZE);
}

/**
 * Maps a UTF-16 code unit so that unit order equals code point order: surrogates (D800–DFFF,
 * i.e. code points ≥ U+10000) move above E000–FFFF.
 */
const codePointRank = (unit: number): number =>
  unit < 0xd800 ? unit : unit < 0xe000 ? unit + 0x2000 : unit - 0x800;

/**
 * Compares strings by Unicode code points. For well-formed strings this equals the byte order of
 * their UTF-8 encoding, i.e. the `id` order of DynamoDB (binary sort key) and OpenSearch
 * (`keyword` sort). JavaScript's `<` compares UTF-16 code units, which differs for non-BMP vs.
 * high-BMP characters (U+1F600 < U+FF01 by code units, but U+FF01 < U+1F600 by code points).
 */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return codePointRank(x) < codePointRank(y) ? -1 : 1;
  }
  return Math.sign(a.length - b.length);
}

/** Global ordering: `id` ascending in UTF-8 byte order (total and provider-independent). */
export function compareById(a: Pick<Listing, 'id'>, b: Pick<Listing, 'id'>): number {
  return compareCodePoints(a.id, b.id);
}

function inRange(value: number | undefined, range: IntRange | undefined): boolean {
  if (range === undefined) return true;
  if (value === undefined) return false;
  return (
    (range.min === undefined || value >= range.min) &&
    (range.max === undefined || value <= range.max)
  );
}

function offerMatches(doc: SearchDocument, q: ResolvedQuery): boolean {
  if (q.offerType === undefined) return true;
  const [amount, currency] =
    q.offerType === 'SALE'
      ? [doc.saleAmountMinor, doc.saleCurrency]
      : [doc.rentAmountMinor, doc.rentCurrency];
  if (amount === undefined) return false;
  if (q.price === undefined) return true;
  return q.price.some((price) => currency === price.currency && inRange(amount, price));
}

/** Reference predicate: does `doc` satisfy every condition of `q`? (Req 1.1–1.4, 1.9, 12.6–12.9, 16.9) */
export function matchesQuery(doc: SearchDocument, q: ResolvedQuery): boolean {
  return (
    offerMatches(doc, q) &&
    inRange(doc.roomsHalf, q.roomsHalf) &&
    inRange(doc.areaMinor, q.areaMinor) &&
    (q.cityNorm === undefined || doc.cityNorm === q.cityNorm) &&
    (q.postalCode === undefined || doc.postalCode === q.postalCode) &&
    (q.country === undefined || doc.country === q.country) &&
    (q.listingTypes === undefined || q.listingTypes.includes(doc.listingType)) &&
    (q.tourHosts === undefined || doc.tourHosts.some((h) => q.tourHosts?.includes(h))) &&
    (q.excludeAgencies === undefined ||
      doc.agencyId === undefined ||
      !q.excludeAgencies.includes(doc.agencyId))
  );
}

/**
 * Cuts one page from matching listings already sorted by `id ASC`: skips ids ≤ `after`, takes
 * `pageSize + 1` as lookahead and reports `next` only if the extra item exists.
 */
export function paginate(sortedMatches: readonly Listing[], q: ResolvedQuery): SearchResult {
  const pageSize = effectivePageSize(q.pageSize);
  const { after } = q;
  const firstAfter =
    after === undefined ? 0 : sortedMatches.findIndex((l) => compareCodePoints(l.id, after) > 0);
  const start = firstAfter === -1 ? sortedMatches.length : firstAfter;
  const window = sortedMatches.slice(start, start + pageSize + 1);
  if (window.length <= pageSize) return { items: window };
  const items = window.slice(0, pageSize);
  return { items, next: { lastId: (items[pageSize - 1] as Listing).id } };
}
