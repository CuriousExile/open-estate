// Feature: duplicate-detection, Property 9: Verlustfreie Kandidatensuche
import {
  agencyScope,
  DuplicateDetector,
  InMemoryDuplicateIndexStore,
  InMemoryTransactor,
  type StoredProfile,
} from '@open-estate/core';
import {
  ANCHOR_RADIUS_METERS,
  blockKeys,
  buildProfile,
  DEFAULT_DUPLICATE_CONFIG,
  distanceMeters,
  ListingContent,
  lookupKeys,
  scoreMatch,
  SIMHASH_HEX_LENGTH,
  type ListingContentInput,
  type MatchProfile,
} from '@open-estate/shared';
import fc from 'fast-check';
import {
  arbRealisticInput,
  arbVariantOptions,
  formattingVariant,
  TAXONOMY,
} from '../../../shared/test/arbitraries/duplicates';

/**
 * For any pair of Merkmalsprofile with an Ortsanker (Req 3.4) the lookup keys of one and the
 * stored block keys of the other intersect — including geo pairs at any latitude up to 85° and
 * across the date line, and text pairs with a SimHash distance up to `textNearHamming`. And with
 * at most `maxCandidates` candidates, `DuplicateDetector.assess` finds exactly the Treffer a
 * brute-force comparison against the whole Prüfbereich finds (Req 4.2, 5.1).
 *
 * **Validates: Requirements 3.4, 4.2, 5.1**
 */

const config = DEFAULT_DUPLICATE_CONFIG;

/**
 * Whether a lookup of `a` hits a stored key of `b` of the given kind. Restricting the kind keeps
 * each check honest: two test profiles share other keys (e.g. text bands) by construction.
 */
const intersects = (a: MatchProfile, b: MatchProfile, kind: 'G' | 'T'): boolean => {
  const stored = new Set(blockKeys(b, config).filter((key) => key.startsWith(`${kind}|`)));
  return lookupKeys(a, config).some((key) => stored.has(key));
};

const base = (overrides: Partial<MatchProfile> = {}): MatchProfile =>
  ({
    rules: 'r',
    country: 'DE',
    postalCode: '10115',
    group: 'apartment',
    listingType: 'apartment_unit',
    offers: [{ type: 'SALE', amountMinor: 100, currency: 'EUR' }],
    areaMinor: 5000,
    rooms: 2,
    mediaHashes: [],
    titleSig: '0'.repeat(SIMHASH_HEX_LENGTH),
    descriptionSig: '0'.repeat(SIMHASH_HEX_LENGTH),
    exactKey: 'e',
    ...overrides,
  }) as MatchProfile;

/**
 * A point and a second one at most the anchor radius away, in any direction. Integer-based on
 * purpose: `fc.double` favours extreme values (bearings and distances near 0), which would almost
 * never cross a grid cell. The first point is placed close to a cell edge half of the time, where
 * a too small neighbourhood ring would miss the second one.
 */
const arbNearbyPoints = fc
  .record({
    latMicro: fc.integer({ min: -85_000_000, max: 85_000_000 }),
    lonCell: fc.oneof(
      fc.integer({ min: -180_000, max: 179_999 }),
      // Bias towards the date line.
      fc.constantFrom(-180_000, -179_999, 179_998, 179_999),
    ),
    /** Position inside the 0.001° column in millionths of a degree (0–999). */
    inCell: fc.oneof(fc.integer({ min: 0, max: 999 }), fc.constantFrom(0, 1, 998, 999)),
    bearingDegrees: fc.integer({ min: 0, max: 359 }),
    centimeters: fc.integer({ min: 0, max: ANCHOR_RADIUS_METERS * 100 }),
  })
  .map(({ latMicro, lonCell, inCell, bearingDegrees, centimeters }) => {
    const lat = latMicro / 1e6;
    const lon = (lonCell * 1000 + inCell) / 1e6;
    const meters = centimeters / 100;
    const bearing = (bearingDegrees * Math.PI) / 180;
    // Offset on a local tangent plane; the exact distance is checked with `distanceMeters`.
    const dLat = (meters * Math.cos(bearing)) / 111_320;
    const dLon = (meters * Math.sin(bearing)) / (111_320 * Math.cos((lat * Math.PI) / 180));
    let lon2 = lon + dLon;
    if (lon2 >= 180) lon2 -= 360;
    if (lon2 < -180) lon2 += 360;
    const round = (x: number) => Math.round(x * 1e6) / 1e6;
    return { a: { lat, lon }, b: { lat: round(lat + dLat), lon: round(lon2) } };
  });

/** A signature and a second one with at most `textNearHamming` flipped bits. */
const arbNearSignatures = fc
  .tuple(
    fc.array(fc.integer({ min: 0, max: 15 }), {
      minLength: SIMHASH_HEX_LENGTH,
      maxLength: SIMHASH_HEX_LENGTH,
    }),
    fc.uniqueArray(fc.integer({ min: 0, max: 63 }), { maxLength: config.textNearHamming }),
  )
  .map(([nibbles, flips]) => {
    const a = nibbles.map((n) => n.toString(16)).join('');
    const flipped = [...nibbles];
    for (const bit of flips) {
      const index = Math.floor(bit / 4);
      flipped[index] = (flipped[index] ?? 0) ^ (8 >> (bit % 4));
    }
    return { a, b: flipped.map((n) => n.toString(16)).join('') };
  });

// ---------------------------------------------------------------------------------------------
// Stock for the end-to-end part: variants of a few base listings in two Prüfbereiche.
// ---------------------------------------------------------------------------------------------

const SCOPES = [agencyScope('agy-1'), agencyScope('agy-2')];

const arbStock = fc.array(arbRealisticInput(), { minLength: 1, maxLength: 3 }).chain((bases) =>
  fc.array(
    fc.record({
      base: fc.constantFrom(...bases),
      variant: arbVariantOptions,
      tweak: fc.constantFrom('none', 'area', 'title', 'price'),
      scope: fc.constantFrom(...SCOPES),
      day: fc.integer({ min: 1, max: 28 }),
    }),
    { minLength: 1, maxLength: 20 },
  ),
);

function tweaked(input: ListingContentInput, tweak: string): ListingContentInput {
  switch (tweak) {
    case 'area':
      return { ...input, area: '311.00' };
    case 'title':
      return { ...input, title: `${input.title} Neu renoviert` };
    case 'price':
      return {
        ...input,
        offers: input.offers.map((o) =>
          o.offerType === 'SALE' ? { ...o, price: '123456.00' } : { ...o, coldRent: '777.00' },
        ),
      };
    default:
      return input;
  }
}

describe('Property 9: Verlustfreie Kandidatensuche', () => {
  it('finds a shared key for every geo pair within the anchor radius', () => {
    fc.assert(
      fc.property(arbNearbyPoints, ({ a, b }) => {
        fc.pre(distanceMeters(a, b) <= ANCHOR_RADIUS_METERS);
        expect(intersects(base({ geo: a }), base({ geo: b }), 'G')).toBe(true);
        expect(intersects(base({ geo: b }), base({ geo: a }), 'G')).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('finds a shared key for every text pair within the Hamming limit', () => {
    fc.assert(
      fc.property(arbNearSignatures, ({ a, b }) => {
        expect(intersects(base({ titleSig: a }), base({ titleSig: b }), 'T')).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('assess finds exactly the Treffer of a brute-force comparison', async () => {
    await fc.assert(
      fc.asyncProperty(arbStock, arbRealisticInput(), async (stock, queryInput) => {
        const index = new InMemoryDuplicateIndexStore();
        const tx = new InMemoryTransactor();
        const stored: StoredProfile[] = [];
        for (const [i, entry] of stock.entries()) {
          const input = tweaked(formattingVariant(entry.base, entry.variant), entry.tweak);
          const parsed = ListingContent.safeParse(input);
          if (!parsed.success) continue;
          const profile = buildProfile(parsed.data, { taxonomy: TAXONOMY, config });
          const record: StoredProfile = {
            listingId: `lst-${i}`,
            scope: entry.scope,
            createdAt: `2026-01-${String(entry.day).padStart(2, '0')}T00:00:00.000Z`,
            listingVersion: 1,
            profile,
            blockKeys: blockKeys(profile, config),
            dismissed: [],
          };
          stored.push(record);
          await tx.transact(index.syncOps(null, record));
        }

        // Query with one of the stock listings' base content or an unrelated listing.
        const first = stock[0];
        const query =
          first === undefined ? queryInput : formattingVariant(first.base, first.variant);
        const content = ListingContent.parse(query);
        const detector = new DuplicateDetector({ index, taxonomy: TAXONOMY, config });
        const scope = SCOPES[0] ?? '';
        const result = await detector.assess({
          listingId: 'query',
          scope,
          createdAt: '2026-02-01T00:00:00.000Z',
          content,
          dismissed: [],
        });

        const profile = buildProfile(content, { taxonomy: TAXONOMY, config });
        const expected = stored
          .filter((s) => s.scope === scope && scoreMatch(profile, s.profile, config).duplicate)
          .map((s) => s.listingId)
          .sort();
        expect(result.truncated).toBe(false);
        expect(result.matches.map((m) => m.listingId).sort()).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  });
});
