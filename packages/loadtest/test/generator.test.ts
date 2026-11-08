import {
  formatDecimal,
  Listing,
  type ListingInput,
  type Offer,
  type OfferType,
} from '@open-estate/shared';
import { CITIES, generateListing, generateListings, LOADTEST_SOURCE } from '../src/generator';

/** Internal listing (minor units) → API/input representation (decimal strings). */
function toInput(listing: Listing): ListingInput {
  const offer = (o: Offer): ListingInput['offers'][number] => {
    if (o.offerType === 'SALE') return { ...o, price: formatDecimal(o.price) };
    const { additionalCosts, warmRent, ...rent } = o;
    return {
      ...rent,
      coldRent: formatDecimal(o.coldRent),
      ...(additionalCosts === undefined ? {} : { additionalCosts: formatDecimal(additionalCosts) }),
      ...(warmRent === undefined ? {} : { warmRent: formatDecimal(warmRent) }),
    };
  };
  // Objektmerkmal `plotArea` is a decimal string in the API representation, too; it is taken
  // out of the spread so the optional field does not keep its internal number type.
  const { plotArea, ...rest } = listing;
  return {
    ...rest,
    offers: listing.offers.map(offer),
    area: formatDecimal(listing.area),
    ...(plotArea === undefined ? {} : { plotArea: formatDecimal(plotArea) }),
  };
}

const offerTypes = (listing: Listing): OfferType[] => listing.offers.map((o) => o.offerType);

describe('generateListings', () => {
  const N = 200;
  const listings = [...generateListings({ count: N, seed: 7 })];

  it('generates the requested number of listings with unique ids', () => {
    expect(listings).toHaveLength(N);
    expect(new Set(listings.map((l) => l.id)).size).toBe(N);
  });

  it('is deterministic per seed and differs between seeds', () => {
    expect([...generateListings({ count: N, seed: 7 })]).toEqual(listings);
    // Prefix-stable: a smaller count yields the first listings of a larger one.
    expect([...generateListings({ count: 10, seed: 7 })]).toEqual(listings.slice(0, 10));
    expect(generateListing(7, 123)).toEqual(listings[123]);

    const other = [...generateListings({ count: N, seed: 8 })];
    expect(other.map((l) => l.id)).not.toEqual(listings.map((l) => l.id));
    expect(other.map((l) => l.title)).not.toEqual(listings.map((l) => l.title));
  });

  it('covers SALE, RENT and SALE + RENT', () => {
    const combinations = new Set(listings.map((l) => [...offerTypes(l)].sort().join('+')));
    expect(combinations).toEqual(new Set(['SALE', 'RENT', 'RENT+SALE']));
  });

  it('produces listings valid against the shared Listing schema (round trip)', () => {
    for (const listing of listings) {
      const result = Listing.safeParse(toInput(listing));
      expect(result.error?.issues).toBeUndefined();
      expect(result.data).toEqual(listing);
    }
  });

  it('uses the city pool and EUR, so the k6 search filters hit', () => {
    const cities = new Set(CITIES.map((c) => c.city));
    for (const listing of listings) {
      expect(cities.has(listing.address.city)).toBe(true);
      expect(listing.offers.every((o) => o.currency === 'EUR')).toBe(true);
      expect(listing.source).toBe(LOADTEST_SOURCE);
    }
    expect(new Set(listings.map((l) => l.address.city)).size).toBe(CITIES.length);
  });
});
