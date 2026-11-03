import { createSearchService, type SearchProvider } from '@open-estate/core';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  parseSearchQuery,
  type Listing,
  type TourProvidersConfig,
} from '@open-estate/shared';
import fc from 'fast-check';
import { arbListing, exampleListing } from '../../../shared/test/arbitraries';

// Shared harness of the provider conformance tests against real backends (tasks 6.11, 18.3):
// generators as in Property 1, an independent reference model, `id ASC` in UTF-8 byte order
// (Property 5) and a reader that follows all pages through `createSearchService`.

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const schemas = buildSchemas(taxonomy, {
  defaultLocale: 'de',
  enabled: [{ locale: 'de', label: 'Deutsch' }],
});

// ---------------------------------------------------------------------------------------------
// Generators (minimal copy of Property 1's generators)
// ---------------------------------------------------------------------------------------------

export const CITIES = ['Berlin', 'BERLIN', 'berlin', 'München', 'MÜNCHEN', 'Mu\u0308nchen', 'Köln'];
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

/** Ids: mostly the shared generator's, sometimes well-formed Unicode (BMP and astral). */
const arbId = fc.oneof(
  fc.constant(undefined),
  fc.string({ unit: 'grapheme', minLength: 1, maxLength: 8 }),
);

export const arbFilterListing: fc.Arbitrary<Listing> = fc
  .tuple(
    arbListing(),
    arbId,
    fc.constantFrom(...CITIES),
    fc.constantFrom(...POSTAL_CODES),
    arbRooms,
    arbAreaMinor,
    fc.array(arbTour, { maxLength: 3 }),
  )
  .map(([listing, id, city, postalCode, rooms, area, tours]) => ({
    ...listing,
    id: id ?? listing.id,
    address: { ...listing.address, city, postalCode },
    rooms,
    area,
    tours,
  }));

export const arbListings = fc.uniqueArray(arbFilterListing, {
  maxLength: 20,
  selector: (l) => l.id,
});

export const arbAllowList: fc.Arbitrary<TourProvidersConfig> = fc
  .shuffledSubarray(TOUR_HOSTS)
  .chain((hosts) => fc.tuple(...hosts.map(randomCase)))
  .map((hostnames) => ({
    providers: hostnames.length > 0 ? [{ code: 'provider', hostnames }] : [],
  }));

const ABSENT = { nil: undefined, freq: 2 };

interface Range {
  min: number | undefined;
  max: number | undefined;
}

function arbRange(value: fc.Arbitrary<number>): fc.Arbitrary<Range> {
  return fc
    .tuple(fc.option(value, ABSENT), fc.option(value, ABSENT))
    .map(([a, b]) =>
      a !== undefined && b !== undefined && a > b ? { min: b, max: a } : { min: a, max: b },
    );
}

export interface Filters {
  city: string | undefined;
  postalCode: string | undefined;
  rooms: Range;
  areaMinor: Range;
  hasTour: boolean | undefined;
  pageSize: number;
}

export const arbFilters: fc.Arbitrary<Filters> = fc.record({
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

/** No filter; `pageSize` small enough to force several pages. */
export function noFilters(pageSize: number): Filters {
  return {
    city: undefined,
    postalCode: undefined,
    rooms: { min: undefined, max: undefined },
    areaMinor: { min: undefined, max: undefined },
    hasTour: undefined,
    pageSize,
  };
}

const decimal = (minor: number): string =>
  `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;

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
// Independent reference model (deliberately not using production filter/ordering code)
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

/** `id ASC` in byte order of the UTF-8 encoding (design: "Ordnung"). */
const byUtf8Bytes = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** Expected ids for a query: reference-filtered, in `id ASC` byte order. */
export function referenceIds(
  listings: readonly Listing[],
  f: Filters,
  allowList: TourProvidersConfig,
): string[] {
  return listings
    .filter((l) => referenceMatches(l, f, allowList))
    .map((l) => l.id)
    .sort(byUtf8Bytes);
}

// ---------------------------------------------------------------------------------------------

/** Follows `nextPageToken` until the last page and returns all ids in delivery order. */
export async function allPages(
  provider: SearchProvider,
  allowList: TourProvidersConfig,
  f: Filters,
): Promise<string[]> {
  const svc = createSearchService({
    provider,
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

/**
 * Fixed example where UTF-8 byte order and UTF-16 code-unit order disagree: U+FF01 (EF BC 81)
 * sorts before U+1F600 (F0 9F 98 80) by bytes, but after it by code units (FF01 > D83D).
 */
export const BYTE_ORDER_EXAMPLE: [Listing[], TourProvidersConfig, Filters] = [
  ['\uFF01', '\u{1F600}', 'a'].map((id) => exampleListing(id)),
  { providers: [] },
  noFilters(1),
];
