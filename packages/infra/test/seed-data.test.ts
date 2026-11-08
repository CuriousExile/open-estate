import {
  assertValidTaxonomy,
  buildProfile,
  DEFAULT_DUPLICATE_CONFIG,
  DEFAULT_TAXONOMY_CONFIG,
  groupOfType,
  Listing,
  scoreMatch,
} from '@open-estate/shared';

const TAXONOMY = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
import { SEED_LISTING_INPUTS, SEED_SOURCE, seedListings } from '../scripts/seed-data';

describe('seed data', () => {
  const listings = seedListings();

  it('every seed listing passes the Listing schema', () => {
    for (const input of SEED_LISTING_INPUTS) {
      const result = Listing.safeParse(input);
      expect(result.error?.issues).toBeUndefined();
    }
    expect(listings.length).toBeGreaterThanOrEqual(6);
  });

  it('converts decimal strings to minor units', () => {
    const berlin = listings.find((l) => l.id === 'seed-de-berlin-001');
    expect(berlin?.offers).toEqual([{ offerType: 'SALE', price: 48_900_000, currency: 'EUR' }]);
    expect(berlin?.area).toBe(8_250);
  });

  it('covers SALE only, RENT only and SALE + RENT', () => {
    const variants = new Set(
      listings.map((l) =>
        l.offers
          .map((o) => o.offerType)
          .sort()
          .join('+'),
      ),
    );
    expect([...variants].sort()).toEqual(['RENT', 'RENT+SALE', 'SALE']);
  });

  it('has unique ids, several countries and currencies, and is marked as seed data', () => {
    expect(new Set(listings.map((l) => l.id)).size).toBe(listings.length);
    expect(new Set(listings.map((l) => l.address.country))).toEqual(new Set(['DE', 'AT', 'TH']));
    expect(new Set(listings.flatMap((l) => l.offers.map((o) => o.currency)))).toEqual(
      new Set(['EUR', 'THB']),
    );
    expect(listings.every((l) => l.source === SEED_SOURCE && l.contact === undefined)).toBe(true);
  });

  it('uses default taxonomy types, half rooms, translations and a Matterport tour', () => {
    const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
    expect(listings.every((l) => groupOfType(taxonomy, l.listingType) !== undefined)).toBe(true);
    expect(listings.some((l) => !Number.isInteger(l.rooms))).toBe(true);
    expect(listings.some((l) => l.translations.some((t) => t.locale === 'en'))).toBe(true);
    expect(
      listings.some((l) => l.tours.some((t) => new URL(t.url).host === 'my.matterport.com')),
    ).toBe(true);
  });

  it('carries Objektmerkmale and a duplicate pair next to a near-duplicate (duplicate-detection)', () => {
    const byId = new Map(listings.map((l) => [l.id, l]));
    expect(byId.get('seed-de-berlin-001')).toMatchObject({ floor: 2, address: { unit: 'WE 3' } });
    expect(listings.some((l) => l.plotArea !== undefined)).toBe(true);
    const profile = (id: string) => {
      const listing = byId.get(id);
      if (listing === undefined) throw new Error(`missing ${id}`);
      return buildProfile(listing, { taxonomy: TAXONOMY, config: DEFAULT_DUPLICATE_CONFIG });
    };
    const original = profile('seed-de-berlin-001');
    const score = (id: string) => scoreMatch(original, profile(id), DEFAULT_DUPLICATE_CONFIG);
    expect(score('seed-de-berlin-010').duplicate).toBe(true);
    expect(score('seed-de-berlin-011').duplicate).toBe(false);
  });

  it('uses only example.org and Matterport URLs', () => {
    const hosts = new Set(
      listings.flatMap((l) => [
        l.sourceUrl,
        ...l.media.map((m) => m.url),
        ...l.tours.map((t) => t.url),
      ]),
    );
    expect(new Set([...hosts].map((url) => new URL(url).host))).toEqual(
      new Set(['example.org', 'my.matterport.com']),
    );
  });
});
