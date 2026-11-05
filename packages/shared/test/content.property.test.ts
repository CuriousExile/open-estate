// Feature: listing-management, Property 11: Inhalts_Hash
import fc from 'fast-check';
import {
  changedContentPaths,
  contentHash,
  contentPaths,
  formatDecimal,
  LISTING_STATUSES,
  ListingContent,
  type ContentPath,
  type ListingContentInput,
  type Offer,
} from '../src';
import { arbListing } from './arbitraries/listing';
import {
  arbAgencyId,
  arbCustomId,
  arbListingContent,
  arbRunId,
  OPTIONAL_CONTENT_PATHS,
  toContent,
} from './arbitraries/management';

/**
 * For any two Listing_Inhalte a, b, `contentHash(a) = contentHash(b)` if a and b are equal after
 * normalization, regardless of key order and of the representation of amounts (decimal string or
 * minor units); for any change of an Inhaltsfeld the hash changes; Listing_Status, Custom_Id and
 * provenance fields do not contribute.
 *
 * **Validates: Requirements 4.7, 7.3**
 */

const RUNS = { numRuns: 100 };

type Json = Record<string, unknown>;

const isPlainObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Deep copy with the keys of every object in a seed-determined order (array order kept). */
function reorderKeys(value: unknown, seed: number): unknown {
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state;
  };
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isPlainObject(v)) return v;
    const keys = Object.keys(v);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = next() % (i + 1);
      [keys[i], keys[j]] = [keys[j] as string, keys[i] as string];
    }
    return Object.fromEntries(keys.map((key) => [key, walk(v[key])]));
  };
  return walk(value);
}

/** Decimal string: canonical two fraction digits, or short form without trailing zeros. */
function toDecimal(minor: number, short: boolean): string {
  const canonical = formatDecimal(minor);
  return short ? canonical.replace(/\.?0+$/, '') : canonical;
}

function offerToApi(offer: Offer, short: boolean): Json {
  const api: Json = { ...offer };
  for (const key of ['price', 'coldRent', 'additionalCosts', 'warmRent']) {
    const amount = api[key];
    if (typeof amount === 'number') api[key] = toDecimal(amount, short);
  }
  return api;
}

/** Internal Listing_Inhalt → API representation (amounts and area as decimal strings). */
function toApiContent(content: ListingContent, short: boolean): ListingContentInput {
  return {
    ...content,
    area: toDecimal(content.area, short),
    offers: content.offers.map((offer) => offerToApi(offer, short)),
  } as unknown as ListingContentInput;
}

const getPath = (value: unknown, path: ContentPath): unknown =>
  path.split('.').reduce<unknown>((v, key) => (isPlainObject(v) ? v[key] : undefined), value);

/** Deep copy of `content` with the value at `path` replaced (`undefined` = removed). */
function setPath(content: ListingContent, path: ContentPath, value: unknown): ListingContent {
  const copy = structuredClone(content) as unknown as Json;
  const keys = path.split('.');
  const last = keys.pop() as string;
  const parent = keys.reduce<Json>((v, key) => v[key] as Json, copy);
  parent[last] = value;
  // Removal: `undefined` keys are dropped, like an absent field.
  return JSON.parse(JSON.stringify(copy)) as ListingContent;
}

/** Element appended to an empty content list, by top-level field. */
const LIST_ELEMENT: Readonly<Record<string, unknown>> = {
  translations: { locale: 'zz', title: 't', description: 'd' },
  media: { url: 'https://example.org/m' },
  tours: { url: 'https://example.org/t', providerCode: 'p' },
  offers: { offerType: 'SALE', price: 1, currency: 'EUR' },
};

/** A different value for the leaf at `path` (scalar changed, list shortened or extended). */
function changedValue(path: ContentPath, value: unknown): unknown {
  if (typeof value === 'string') return `${value}x`;
  if (typeof value === 'number') return value + 1;
  if (Array.isArray(value)) {
    return value.length > 0 ? value.slice(0, -1) : [LIST_ELEMENT[path] ?? { added: true }];
  }
  throw new Error(`Unexpected leaf at ${path}: ${JSON.stringify(value)}`);
}

/** Content plus one changed Inhaltsfeld: a leaf changed, an optional field removed or added. */
const arbChange = arbListingContent().chain((content) => {
  const paths = contentPaths(content);
  const removable = paths.filter((p) =>
    [...OPTIONAL_CONTENT_PATHS].some((o) => p === o || p.startsWith(`${o}.`)),
  );
  const changes: fc.Arbitrary<{ path: ContentPath; after: ListingContent }>[] = [
    fc.constantFrom(...paths).map((path) => ({
      path,
      after: setPath(content, path, changedValue(path, getPath(content, path))),
    })),
  ];
  if (removable.length > 0) {
    changes.push(
      fc
        .constantFrom(...removable)
        .map((path) => ({ path, after: setPath(content, path, undefined) })),
    );
  }
  if (content.geo === undefined) {
    changes.push(
      fc.constant({ path: 'geo.lat', after: setPath(content, 'geo', { lat: 1, lon: 2 }) }),
    );
  }
  return fc.oneof(...changes).map((change) => ({ before: content, ...change }));
});

describe('Property 11: Inhalts_Hash', () => {
  it('is independent of key order and of the amount representation', () => {
    fc.assert(
      fc.property(arbListingContent(), fc.integer(), fc.boolean(), (content, seed, short) => {
        const hash = contentHash(content);
        const reordered = reorderKeys(content, seed) as ListingContent;
        const parsed = ListingContent.parse(reorderKeys(toApiContent(content, short), seed));

        expect(contentHash(reordered)).toBe(hash);
        expect(contentHash(parsed)).toBe(hash);
        expect(changedContentPaths(content, reordered)).toEqual([]);
        expect(changedContentPaths(content, parsed)).toEqual([]);
      }),
      RUNS,
    );
  });

  it('changes for any change of an Inhaltsfeld', () => {
    fc.assert(
      fc.property(arbChange, ({ before, path, after }) => {
        expect(contentHash(after)).not.toBe(contentHash(before));
        expect(changedContentPaths(before, after)).toContain(path);
      }),
      RUNS,
    );
  });

  it('is equal exactly when no Inhaltsfeld differs', () => {
    fc.assert(
      fc.property(arbListingContent(), arbListingContent(), (a, b) => {
        const equal = contentHash(a) === contentHash(b);
        expect(equal).toBe(changedContentPaths(a, b).length === 0);
        expect(contentHash(a) === contentHash(structuredClone(a))).toBe(true);
      }),
      RUNS,
    );
  });

  it('ignores Listing_Status, Custom_Id, id, agency and provenance fields', () => {
    const arbManagement = fc.record(
      {
        id: fc.string({ minLength: 1, maxLength: 20 }),
        status: fc.constantFrom(...LISTING_STATUSES),
        customId: arbCustomId,
        agencyId: arbAgencyId,
        source: fc.string({ minLength: 1, maxLength: 20 }),
        lastImportedAt: fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
        lastRunId: arbRunId,
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(arbListing(), arbManagement, arbManagement, (listing, m1, m2) => {
        const content = toContent(listing);
        const withM1 = { ...content, ...m1 } as ListingContent;
        const withM2 = { ...listing, ...m2 } as ListingContent;

        expect(contentHash(withM1)).toBe(contentHash(content));
        expect(contentHash(withM2)).toBe(contentHash(content));
        expect(contentPaths(withM2)).toEqual(contentPaths(content));
        expect(changedContentPaths(withM1, withM2)).toEqual([]);
      }),
      RUNS,
    );
  });
});
