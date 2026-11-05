// Deterministic listing generator for the reference load (100,000 listings, Req 2.4, 11.3).
// Structure and text fields come from the shared `arbListing`; the search-relevant fields (city,
// prices, rooms, area) are drawn from realistic ranges so that the k6 search filters hit.
import { COORDINATE_DECIMALS, type Listing, type Offer, type OfferType } from '@open-estate/shared';
import fc from 'fast-check';
import { arbListing, OFFER_TYPE_COMBINATIONS } from '../../shared/test/arbitraries';
import CITIES_JSON from './cities.json';

export interface City {
  readonly city: string;
  readonly postalCode: string;
  readonly country: string;
  readonly lat: number;
  readonly lon: number;
}

/** City pool, also read by the k6 script (`k6/api-load.js`) for its `city` filter. */
export const CITIES: readonly City[] = CITIES_JSON;

export const DEFAULT_COUNT = 100_000;
export const DEFAULT_SEED = 1;
export const LOADTEST_SOURCE = 'loadtest';
export const LOADTEST_RUN_ID = 'loadtest-v1';
export const LOADTEST_IMPORTED_AT = '2026-01-01T00:00:00.000Z';
const CURRENCY = 'EUR';

const COORDINATE_SCALE = 10 ** COORDINATE_DECIMALS;
/** ±0.05° (≈ 5 km) around the city centre, in coordinate units. */
const GEO_JITTER = 0.05 * COORDINATE_SCALE;

/** `loadtest-<seed>-<index>`; zero-padded so ids sort like the generation order. */
export function listingId(seed: number, index: number): string {
  return `loadtest-${seed}-${String(index).padStart(7, '0')}`;
}

function coordinate(centre: number, jitter: number): number {
  return (Math.round(centre * COORDINATE_SCALE) + jitter) / COORDINATE_SCALE || 0;
}

/** Realistic amounts in minor units (EUR cents). */
const arbSearchFields = fc.record({
  city: fc.constantFrom(...CITIES),
  latJitter: fc.integer({ min: -GEO_JITTER, max: GEO_JITTER }),
  lonJitter: fc.integer({ min: -GEO_JITTER, max: GEO_JITTER }),
  /** 1–6 rooms in steps of 0.5. */
  rooms: fc.integer({ min: 2, max: 12 }).map((n) => n / 2),
  /** 20–300 m². */
  area: fc.integer({ min: 20_00, max: 300_00 }),
  /** 50,000–2,000,000 EUR. */
  price: fc.integer({ min: 50_000_00, max: 2_000_000_00 }),
  /** 300–5,000 EUR. */
  coldRent: fc.integer({ min: 300_00, max: 5_000_00 }),
  /** 0–800 EUR. */
  additionalCosts: fc.integer({ min: 0, max: 800_00 }),
});

type SearchFields = typeof arbSearchFields extends fc.Arbitrary<infer T> ? T : never;

function offer(type: OfferType, f: SearchFields): Offer {
  return type === 'SALE'
    ? { offerType: 'SALE', price: f.price, currency: CURRENCY }
    : {
        offerType: 'RENT',
        coldRent: f.coldRent,
        currency: CURRENCY,
        ...(f.additionalCosts > 0
          ? { additionalCosts: f.additionalCosts, warmRent: f.coldRent + f.additionalCosts }
          : {}),
      };
}

/** Listing for one offer-type combination; id, URLs and provenance are set by `generateListing`. */
function arbBody(offerTypes: readonly OfferType[]): fc.Arbitrary<Listing> {
  return fc.tuple(arbListing({ offerTypes: [offerTypes] }), arbSearchFields).map(([base, f]) => ({
    ...base,
    offers: offerTypes.map((type) => offer(type, f)),
    rooms: f.rooms,
    area: f.area,
    address: {
      city: f.city.city,
      postalCode: f.city.postalCode,
      country: f.city.country,
      ...(base.address.street === undefined ? {} : { street: base.address.street }),
    },
    geo: { lat: coordinate(f.city.lat, f.latJitter), lon: coordinate(f.city.lon, f.lonJitter) },
  }));
}

/** One arbitrary per combination: SALE, RENT, SALE + RENT, RENT + SALE (rotated by index). */
const BODIES = OFFER_TYPE_COMBINATIONS.map(arbBody);

/** 32-bit seed per (seed, index), so every listing depends only on its own index. */
function indexSeed(seed: number, index: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(index + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) | 0;
}

/** The listing at `index` for `seed`; ids, URLs and provenance are fixed, so re-seeding is idempotent. */
export function generateListing(seed: number, index: number): Listing {
  const body = BODIES[index % BODIES.length];
  const [base] = body ? fc.sample(body, { seed: indexSeed(seed, index), numRuns: 1 }) : [];
  if (base === undefined) throw new Error(`No listing generated for index ${index}`);
  const id = listingId(seed, index);
  const url = `https://example.org/open-estate/loadtest/${id}`;
  return {
    ...base,
    id,
    sourceUrl: url,
    media: base.media.map((_, i) => ({ url: `${url}/photo-${i + 1}.jpg` })),
    // Placeholder model ids on the Matterport host of the default tour allow-list.
    tours: base.tours.map((_, i) => ({
      url: `https://my.matterport.com/show/?m=${id}-${i + 1}`,
      providerCode: 'matterport',
    })),
    source: LOADTEST_SOURCE,
    lastImportedAt: LOADTEST_IMPORTED_AT,
    lastRunId: LOADTEST_RUN_ID,
  };
}

export interface GenerateOptions {
  count: number;
  seed: number;
}

/** Lazily yields `count` listings; `generateListings({count: n})` is a prefix of any larger count. */
export function* generateListings({ count, seed }: GenerateOptions): Generator<Listing> {
  for (let index = 0; index < count; index++) yield generateListing(seed, index);
}
