// Feature: duplicate-detection, Property 7: Ausschluss, Anker und Schwellenwert
import fc from 'fast-check';
import {
  ANCHOR_RADIUS_METERS,
  buildProfile,
  DEFAULT_DUPLICATE_CONFIG,
  distanceMeters,
  hamming,
  ListingContent,
  scoreMatch,
  type ListingContentInput,
  type MatchProfile,
} from '../../src';
import { arbRealisticInput, TAXONOMY } from '../arbitraries/duplicates';

/**
 * `duplicate` is true exactly when no exclusion of Req 3.3 applies, an Ortsanker of Req 3.4
 * exists and the Übereinstimmungswert reaches the threshold. The reference model below decides
 * exclusion and anchor directly from the two Merkmalsprofile, independently of `scoreMatch`.
 *
 * The generator deliberately builds related pairs (a copy with one changed fact), because
 * two unrelated random listings almost never reach an anchor.
 *
 * **Validates: Requirements 3.3, 3.4, 3.5**
 */

const config = DEFAULT_DUPLICATE_CONFIG;
const profileOf = (input: ListingContentInput): MatchProfile =>
  buildProfile(ListingContent.parse(input), { taxonomy: TAXONOMY, config });

/** Reference model of Req 3.3: contradicting facts. */
function excluded(a: MatchProfile, b: MatchProfile): boolean {
  const conflict = <T>(x: T | undefined, y: T | undefined): boolean =>
    x !== undefined && y !== undefined && x !== y;
  const sharedOffer = a.offers.some((offer) => b.offers.some((o) => o.type === offer.type));
  return (
    a.country !== b.country ||
    a.group !== b.group ||
    !sharedOffer ||
    conflict(a.addressHash, b.addressHash) ||
    conflict(a.unitHash, b.unitHash) ||
    conflict(a.floor, b.floor) ||
    conflict(a.parcelHash, b.parcelHash)
  );
}

/** Reference model of Req 3.4: at least one Ortsanker. */
function anchored(a: MatchProfile, b: MatchProfile): boolean {
  const sameAddress = a.addressHash !== undefined && a.addressHash === b.addressHash;
  const near =
    a.geo !== undefined &&
    b.geo !== undefined &&
    distanceMeters(a.geo, b.geo) <= ANCHOR_RADIUS_METERS;
  const sameParcel = a.parcelHash !== undefined && a.parcelHash === b.parcelHash;
  const sameSource = a.sourceUrlHash !== undefined && a.sourceUrlHash === b.sourceUrlHash;
  const nearText =
    a.postalCode === b.postalCode &&
    hamming(a.titleSig, b.titleSig) <= config.textNearHamming &&
    hamming(a.descriptionSig, b.descriptionSig) <= config.textNearHamming;
  return sameAddress || near || sameParcel || sameSource || nearText;
}

/** One changed fact, so pairs stay related but differ in exactly one respect. */
type Change = (input: ListingContentInput) => ListingContentInput;

const CHANGES: Record<string, Change> = {
  none: (input) => input,
  country: (input) => ({ ...input, address: { ...input.address, country: 'FR' } }),
  group: (input) => ({ ...input, listingType: 'building_plot' }),
  offerType: (input) => ({
    ...input,
    offers: [
      input.offers[0]?.offerType === 'SALE'
        ? { offerType: 'RENT', coldRent: '900.00', currency: 'EUR' }
        : { offerType: 'SALE', price: '250000.00', currency: 'EUR' },
    ],
  }),
  houseNumber: (input) => ({
    ...input,
    address: { ...input.address, street: `${input.address.street ?? 'Hauptstraße'} 999` },
  }),
  unit: (input) => ({ ...input, address: { ...input.address, unit: 'XYZ-99' } }),
  // A different floor, but never above `totalFloors` (Req 1.2), so the content stays valid.
  floor: (input) => {
    const limit = input.totalFloors ?? 20;
    return { ...input, floor: input.floor === limit ? limit - 1 : limit };
  },
  parcel: (input) => ({ ...input, parcelId: 'Flur 9/999' }),
  street: (input) => ({ ...input, address: { ...input.address, street: 'Andereweg 5' } }),
  city: (input) => ({
    ...input,
    address: { ...input.address, city: 'Kiel', postalCode: '24103' },
  }),
  geoFar: (input) => ({ ...input, geo: { lat: 10.5, lon: 20.5 } }),
  text: (input) => ({
    ...input,
    title: 'Voellig anderer Titel ohne Gemeinsamkeit',
    description: 'Ganz andere Beschreibung mit anderen Worten darin.',
  }),
  sourceUrl: (input) => ({ ...input, sourceUrl: 'https://woanders.example/objekt/7' }),
};

describe('Property 7: Ausschluss, Anker und Schwellenwert', () => {
  it('matches the reference model of exclusions, anchors and threshold', () => {
    fc.assert(
      fc.property(
        arbRealisticInput(),
        fc.array(fc.constantFrom(...Object.keys(CHANGES)), { minLength: 1, maxLength: 3 }),
        (input, changes) => {
          const other = changes.reduce<ListingContentInput>(
            (current, change) => (CHANGES[change] ?? ((x) => x))(current),
            input,
          );
          // A change may produce content the schema rejects (e.g. an impossible floor); such a
          // listing could never be stored, so it is not a case for the Duplikat_Bewertung.
          fc.pre(ListingContent.safeParse(other).success);
          const a = profileOf(input);
          const b = profileOf(other);
          const result = scoreMatch(a, b, config);

          if (excluded(a, b)) {
            expect(result.duplicate).toBe(false);
            expect(result.score).toBe(0);
            expect(result.reasons).toEqual([]);
            expect(result.excludedBy).toBeDefined();
            return;
          }
          if (!anchored(a, b)) {
            expect(result.duplicate).toBe(false);
            expect(result.excludedBy).toBe('NO_ANCHOR');
            return;
          }
          expect(result.excludedBy).toBeUndefined();
          expect(result.duplicate).toBe(result.score >= config.threshold);
        },
      ),
      { numRuns: 100 },
    );
  });
});
