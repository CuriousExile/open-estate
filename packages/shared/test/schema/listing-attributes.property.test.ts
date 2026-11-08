// Feature: duplicate-detection, Property 1: Validierung der Objektmerkmale
import fc from 'fast-check';
import { LISTING_BOUNDS as B, Listing, type ListingInput } from '../../src';

/**
 * For any Listing_Inhalt with arbitrary (valid and invalid) Objektmerkmale the schema accepts
 * exactly the inputs whose merkmale lie in the value ranges of Req 1.1 and satisfy
 * `floor ≤ totalFloors` (Req 1.2), and a rejection names every invalid merkmal separately
 * (Req 1.3: all field errors at once, like the rest of the listing model).
 *
 * The reference model below decides per field from the bounds alone; the expected issue paths
 * are compared as a set against the paths Zod reports.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3**
 */

/** Valid listing in the API representation; every Objektmerkmal is added by the test. */
const BASE: ListingInput = {
  id: 'listing-1',
  originalLocale: 'de',
  title: 'Titel',
  description: '',
  translations: [],
  offers: [{ offerType: 'SALE', price: '100000.00', currency: 'EUR' }],
  listingType: 'apartment_unit',
  rooms: 3,
  area: '75.00',
  address: { city: 'Berlin', postalCode: '10115', country: 'DE' },
  sourceUrl: 'https://partner.example/listings/1',
  media: [],
  tours: [],
  source: 'example',
  lastImportedAt: '2025-01-01T00:00:00.000Z',
  lastRunId: 'run-1',
};

/** A generated merkmal value with the expectation the reference model derives from the bounds. */
interface Candidate {
  value: unknown;
  valid: boolean;
}

const bounded = (bounds: { min: number; max: number }): fc.Arbitrary<Candidate> =>
  fc.oneof(
    fc.integer({ min: bounds.min, max: bounds.max }).map((value) => ({ value, valid: true })),
    // Out of range, not an integer, or not a number at all.
    fc
      .oneof(
        fc.integer({ min: bounds.max + 1, max: bounds.max + 1000 }),
        fc.integer({ min: bounds.min - 1000, max: bounds.min - 1 }),
        fc.constantFrom(bounds.min + 0.5, bounds.max - 0.5),
        fc.constantFrom('3', null, true),
      )
      .map((value) => ({ value, valid: false })),
  );

const boundedText = (bounds: { min: number; max: number }): fc.Arbitrary<Candidate> =>
  fc.oneof(
    fc
      .string({ minLength: bounds.min, maxLength: bounds.max })
      .map((value) => ({ value, valid: true })),
    fc
      .oneof(
        fc.string({ minLength: bounds.max + 1, maxLength: bounds.max + 20 }),
        fc.constantFrom('', 42, null),
      )
      .map((value) => ({ value, valid: false })),
  );

/** Decimal string in m²; invalid: out of range, more than two fraction digits, wrong type. */
const arbPlotArea: fc.Arbitrary<Candidate> = fc.oneof(
  fc.integer({ min: B.plotArea.minMinor, max: B.plotArea.maxMinor }).map((minor) => ({
    value: `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`,
    valid: true,
  })),
  fc
    .constantFrom('0.99', '0.00', '10000000.01', '99999999.00', '1.234', '1,5', '-5.00', 100, null)
    .map((value) => ({ value, valid: false })),
);

const ATTRIBUTES = {
  floor: bounded(B.floor),
  totalFloors: bounded(B.totalFloors),
  yearBuilt: bounded(B.yearBuilt),
  plotArea: arbPlotArea,
  bedrooms: bounded(B.bedrooms),
  bathrooms: bounded(B.bathrooms),
  parcelId: boundedText(B.parcelId),
} as const;

const ADDRESS_ATTRIBUTES = {
  houseNumber: boundedText(B.houseNumber),
  unit: boundedText(B.unit),
} as const;

type Candidates = Record<string, Candidate | undefined>;

/** Every merkmal absent, valid or invalid. */
const arbCandidates = (
  arbitraries: Readonly<Record<string, fc.Arbitrary<Candidate>>>,
): fc.Arbitrary<Candidates> =>
  fc.record(Object.fromEntries(Object.entries(arbitraries).map(([key, arb]) => [key, arb])), {
    requiredKeys: [],
  });

const values = (candidates: Candidates): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(candidates).flatMap(([key, candidate]) =>
      candidate === undefined ? [] : [[key, candidate.value]],
    ),
  );

/** Paths the reference model expects to be reported. */
function expectedIssuePaths(listing: Candidates, address: Candidates): Set<string> {
  const paths = new Set<string>();
  for (const [key, candidate] of Object.entries(listing)) {
    if (candidate !== undefined && !candidate.valid) paths.add(key);
  }
  for (const [key, candidate] of Object.entries(address)) {
    if (candidate !== undefined && !candidate.valid) paths.add(`address.${key}`);
  }
  // Req 1.2: only compared when both values passed their own field check.
  const floor = listing['floor'];
  const totalFloors = listing['totalFloors'];
  if (
    floor?.valid === true &&
    totalFloors?.valid === true &&
    (floor.value as number) > (totalFloors.value as number)
  ) {
    paths.add('floor');
  }
  return paths;
}

describe('Property 1: Validierung der Objektmerkmale', () => {
  it('accepts exactly the merkmale within their bounds and names every invalid one', () => {
    fc.assert(
      fc.property(
        arbCandidates(ATTRIBUTES),
        arbCandidates(ADDRESS_ATTRIBUTES),
        (listingAttributes, addressAttributes) => {
          const candidate = {
            ...BASE,
            ...values(listingAttributes),
            address: { ...BASE.address, ...values(addressAttributes) },
          };
          const expected = expectedIssuePaths(listingAttributes, addressAttributes);
          const result = Listing.safeParse(candidate);

          expect(result.success).toBe(expected.size === 0);
          if (result.success) return;
          const reported = new Set(result.error.issues.map((issue) => issue.path.join('.')));
          expect([...reported].sort()).toEqual([...expected].sort());
        },
      ),
      { numRuns: 100 },
    );
  });
});
