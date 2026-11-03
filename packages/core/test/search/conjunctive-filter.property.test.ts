// Feature: real-estate-platform, Property 1: Konjunktive Filterung entspricht dem Referenzmodell
import { createSearchService, InMemorySearchProvider } from '@open-estate/core';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  parseSearchQuery,
  type Listing,
  type TourProvidersConfig,
} from '@open-estate/shared';
import fc from 'fast-check';
import { arbListing } from '../../../shared/test/arbitraries';

/**
 * Property 1: for any listing set, tour allow-list and valid search query, the union of all
 * result pages (followed via `nextPageToken`) contains exactly the listings that satisfy an
 * independent reference predicate: city case-insensitively exact, postal code exact, rooms and
 * area ranges inclusive, `hasTour=true` ⇔ at least one tour host on the *current* allow-list.
 * No result violates a filter, no matching listing is missing; no match ⇒ empty, successful
 * result. "Current" is checked by querying the same indexed data through two services with
 * different allow-lists, each against its own list.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.12, 16.9**
 */

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const schemas = buildSchemas(taxonomy, {
  defaultLocale: 'de',
  enabled: [{ locale: 'de', label: 'Deutsch' }],
});

// Small value pools so that filters hit often, including case and Unicode-form variants.
const CITIES = ['Berlin', 'BERLIN', 'berlin', 'München', 'MÜNCHEN', 'Mu\u0308nchen', 'Köln'];
const POSTAL_CODES = ['10115', '10117', '80331', '50667'];
const TOUR_HOSTS = ['my.matterport.com', 'kuula.co', 'tours.other.example', 'vr.example.org'];
const AREA_MIN = 40_00;
const AREA_MAX = 42_00;

const randomCase = (s: string): fc.Arbitrary<string> =>
  fc
    .array(fc.boolean(), { minLength: s.length, maxLength: s.length })
    .map((upper) => [...s].map((c, i) => (upper[i] ? c.toUpperCase() : c.toLowerCase())).join(''));

const arbRooms = fc.integer({ min: 0, max: 12 }).map((n) => n / 2);
const arbAreaMinor = fc.integer({ min: AREA_MIN, max: AREA_MAX });

const arbTour = fc.record({
  url: fc
    .tuple(fc.constantFrom(...TOUR_HOSTS).chain(randomCase), fc.stringMatching(/^[a-z0-9]{0,8}$/))
    .map(([host, path]) => `https://${host}/${path}`),
  providerCode: fc.constantFrom('matterport', 'kuula', 'other'),
});

/** Valid listings (shared generator) with the filtered fields drawn from the small pools. */
const arbFilterListing: fc.Arbitrary<Listing> = fc
  .tuple(
    arbListing(),
    fc.constantFrom(...CITIES),
    fc.constantFrom(...POSTAL_CODES),
    arbRooms,
    arbAreaMinor,
    fc.array(arbTour, { maxLength: 3 }),
  )
  .map(([listing, city, postalCode, rooms, area, tours]) => ({
    ...listing,
    address: { ...listing.address, city, postalCode },
    rooms,
    area,
    tours,
  }));

const arbListings = fc.uniqueArray(arbFilterListing, { maxLength: 20, selector: (l) => l.id });

/** Allow-list: disjoint host subsets per provider, host names in random case. */
const arbAllowList: fc.Arbitrary<TourProvidersConfig> = fc
  .shuffledSubarray(TOUR_HOSTS)
  .chain((hosts) => fc.tuple(...hosts.map(randomCase)))
  .chain((hosts) =>
    fc
      .array(fc.integer({ min: 0, max: 2 }), { minLength: hosts.length, maxLength: hosts.length })
      .map((slots) => ({
        providers: [0, 1, 2]
          .map((slot) => ({
            code: `provider-${slot}`,
            hostnames: hosts.filter((_, i) => slots[i] === slot),
          }))
          .filter((p) => p.hostnames.length > 0),
      })),
  );

/** Optional filters are absent more often than by default, so conjunctions still match. */
const ABSENT = { nil: undefined, freq: 2 };

/** Inclusive range; an absent bound is `undefined`. */
interface Range<T extends number = number> {
  min: T | undefined;
  max: T | undefined;
}

/** Optional inclusive range [min, max] with min ≤ max; either bound may be absent. */
function arbRange<T extends number>(value: fc.Arbitrary<T>): fc.Arbitrary<Range<T>> {
  return fc
    .tuple(fc.option(value, ABSENT), fc.option(value, ABSENT))
    .map(([a, b]) =>
      a !== undefined && b !== undefined && a > b ? { min: b, max: a } : { min: a, max: b },
    );
}

interface Filters {
  city: string | undefined;
  postalCode: string | undefined;
  rooms: Range;
  areaMinor: Range;
  hasTour: boolean | undefined;
  pageSize: number;
}

const arbFilters: fc.Arbitrary<Filters> = fc.record({
  city: fc.option(
    fc.oneof(fc.constantFrom(...CITIES).chain(randomCase), fc.constantFrom('Hamburg', 'BERLIN ')),
    ABSENT,
  ),
  postalCode: fc.option(fc.oneof(fc.constantFrom(...POSTAL_CODES), fc.constant('10115 ')), ABSENT),
  rooms: arbRange(arbRooms),
  areaMinor: arbRange(fc.integer({ min: AREA_MIN - 10, max: AREA_MAX + 10 })),
  hasTour: fc.option(fc.boolean(), ABSENT),
  pageSize: fc.oneof(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 50 })),
});

const decimal = (minor: number): string =>
  `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;

/** Raw API query parameters (query-string representation) for the filters. */
function rawQuery(f: Filters): Record<string, unknown> {
  const raw: Record<string, unknown> = { pageSize: String(f.pageSize) };
  if (f.city !== undefined) raw['city'] = f.city;
  if (f.postalCode !== undefined) raw['postalCode'] = f.postalCode;
  if (f.rooms.min !== undefined) raw['roomsMin'] = String(f.rooms.min);
  if (f.rooms.max !== undefined) raw['roomsMax'] = String(f.rooms.max);
  if (f.areaMinor.min !== undefined) raw['areaMin'] = decimal(f.areaMinor.min);
  if (f.areaMinor.max !== undefined) raw['areaMax'] = decimal(f.areaMinor.max);
  if (f.hasTour !== undefined) raw['hasTour'] = String(f.hasTour);
  return raw;
}

// ---------------------------------------------------------------------------------------------
// Independent reference predicate (deliberately not using production filter code)
// ---------------------------------------------------------------------------------------------

const foldCity = (s: string): string => s.normalize('NFC').toLowerCase();

const within = (v: number, r: Range): boolean =>
  (r.min === undefined || v >= r.min) && (r.max === undefined || v <= r.max);

function referenceMatches(l: Listing, f: Filters, allowList: TourProvidersConfig): boolean {
  if (f.city !== undefined && foldCity(l.address.city) !== foldCity(f.city)) return false;
  if (f.postalCode !== undefined && l.address.postalCode !== f.postalCode) return false;
  if (!within(l.rooms, f.rooms) || !within(l.area, f.areaMinor)) return false;
  if (f.hasTour === true) {
    const allowed = allowList.providers.flatMap((p) => p.hostnames.map((h) => h.toLowerCase()));
    return l.tours.some((t) => allowed.includes(new URL(t.url).hostname.toLowerCase()));
  }
  return true;
}

// ---------------------------------------------------------------------------------------------

/** Follows `nextPageToken` until the last page and returns all ids in delivery order. */
async function allPages(
  listings: InMemorySearchProvider,
  allowList: TourProvidersConfig,
  f: Filters,
): Promise<string[]> {
  const svc = createSearchService({
    provider: listings,
    taxonomy,
    tourProviders: allowList,
    defaultCurrency: 'EUR',
  });
  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page <= 50; page++) {
    const parsed = parseSearchQuery({ ...rawQuery(f), ...(pageToken && { pageToken }) }, schemas);
    if (!parsed.ok) throw new Error(`generated query is invalid: ${JSON.stringify(parsed.error)}`);
    const result = await svc.search(parsed.value, []);
    if (!result.ok) throw new Error(`search failed: ${JSON.stringify(result.error)}`);
    expect(result.value.items.length).toBeLessThanOrEqual(f.pageSize);
    ids.push(...result.value.items.map((l) => l.id));
    pageToken = result.value.nextPageToken;
    if (pageToken === undefined) return ids;
  }
  throw new Error('pagination did not terminate');
}

describe('Property 1: Konjunktive Filterung entspricht dem Referenzmodell', () => {
  it('the union of all pages equals the reference-filtered listing set', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbListings,
        arbAllowList,
        arbAllowList,
        arbFilters,
        async (listings, allowList, laterAllowList, filters) => {
          // Indexed once; only the allow-list the service currently holds may decide `hasTour`.
          const provider = new InMemorySearchProvider(listings);
          for (const current of [allowList, laterAllowList]) {
            const ids = await allPages(provider, current, filters);
            const expected = listings
              .filter((l) => referenceMatches(l, filters, current))
              .map((l) => l.id);

            expect(new Set(ids).size).toBe(ids.length);
            expect([...ids].sort()).toEqual([...expected].sort());
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
