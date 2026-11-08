import {
  assertValidTaxonomy,
  buildProfile,
  DEFAULT_DUPLICATE_CONFIG,
  DEFAULT_TAXONOMY_CONFIG,
  ListingContent,
  scoreMatch,
} from '../../src';

// Calibration of the default Duplikat_Konfiguration (duplicate-detection task 13.2, Req 3.8): a
// catalog of realistic pairs that must be judged "same property" or "different property" with
// the documented defaults. A change of weights, tolerances or threshold that flips one of them
// must be a deliberate decision (and the Developer_Documentation updated).

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const config = DEFAULT_DUPLICATE_CONFIG;

type Input = Record<string, unknown>;

const flat: Input = {
  originalLocale: 'de',
  title: 'Helle 3-Zimmer-Altbauwohnung mit Balkon',
  description: 'Altbau mit Stuck und Dielen, Südbalkon, ruhige Seitenstraße, U-Bahn in 5 Minuten.',
  translations: [],
  offers: [{ offerType: 'SALE', price: '489000.00', currency: 'EUR' }],
  listingType: 'apartment_unit',
  rooms: 3,
  area: '82.50',
  address: { city: 'Berlin', postalCode: '10115', country: 'DE', street: 'Ackerstraße 12' },
  sourceUrl: 'https://makler-a.example/expose/1',
  media: [],
  tours: [],
};

const house: Input = {
  ...flat,
  title: 'Reihenmittelhaus mit Garten',
  description: 'Familienfreundlich, vier Zimmer, Garten nach Westen, Stellplatz.',
  listingType: 'terraced',
  rooms: 4,
  area: '112',
  address: { city: 'Lübeck', postalCode: '23562', country: 'DE', street: 'Am Rehwinkel 8' },
  plotArea: '210.00',
  sourceUrl: 'https://makler-a.example/expose/2',
};

const merged = (base: Input, changes: Input): Input => ({
  ...base,
  ...changes,
  ...(changes['address'] !== undefined && {
    address: { ...(base['address'] as Input), ...(changes['address'] as Input) },
  }),
});

const profile = (input: Input) => buildProfile(ListingContent.parse(input), { taxonomy, config });

const judge = (a: Input, b: Input) => scoreMatch(profile(a), profile(b), config);

/** Another agent's text for the same property: different title, description and source link. */
const rewritten: Input = {
  title: 'Altbau-Juwel in Mitte: 3 Zimmer, Balkon nach Süden',
  description: 'Stuckdecken, Holzdielen und ein sonniger Balkon. Die U-Bahn ist nah.',
  sourceUrl: 'https://makler-b.example/objekt/77',
};

describe('calibration catalog of the default Duplikat_Konfiguration', () => {
  describe('same property (a duplicate)', () => {
    it.each<[string, Input, Input]>([
      [
        'repost with another title and description (with unit)',
        merged(flat, { address: { unit: 'WE 3' } }),
        merged(flat, { ...rewritten, address: { unit: 'Wohnung 3' } }),
      ],
      ['repost with another text, no unit on either side', flat, merged(flat, rewritten)],
      [
        'same listing typed differently (abbreviations, decimals, postal code spacing)',
        flat,
        merged(flat, {
          area: '82.5',
          address: { street: 'Ackerstr. 12', postalCode: '10 115' },
        }),
      ],
      [
        'price reduced by 3 %, same text',
        flat,
        merged(flat, { offers: [{ offerType: 'SALE', price: '474330.00', currency: 'EUR' }] }),
      ],
      [
        'same source link, text rewritten',
        flat,
        merged(flat, { ...rewritten, sourceUrl: flat['sourceUrl'] }),
      ],
      [
        'no street, same coordinates and text',
        merged(flat, {
          address: { street: undefined },
          geo: { lat: 52.532, lon: 13.385 },
        }),
        merged(flat, {
          address: { street: undefined },
          geo: { lat: 52.53205, lon: 13.38503 },
          sourceUrl: 'https://makler-b.example/objekt/78',
        }),
      ],
      [
        'two photos shared, text rewritten',
        merged(flat, {
          media: [{ url: 'https://cdn.example/a.jpg' }, { url: 'https://cdn.example/b.jpg' }],
        }),
        merged(flat, {
          ...rewritten,
          media: [{ url: 'https://cdn.example/a.jpg' }, { url: 'https://cdn.example/b.jpg' }],
        }),
      ],
      [
        'house listed again with the same plot and parcel',
        merged(house, { parcelId: 'Flur 3/17' }),
        merged(house, {
          title: 'Reihenhaus mit Westgarten',
          description: 'Vier Zimmer, Stellplatz, Garten.',
          sourceUrl: 'https://makler-b.example/objekt/79',
          parcelId: 'Flur 3 / 17',
        }),
      ],
      [
        // Without unit or floor the platform cannot tell identical flats of one building apart;
        // the agency releases one of them (Req 8.1).
        'identical flats of one building without unit or floor',
        flat,
        merged(flat, {
          title: 'Baugleiche 3-Zimmer-Wohnung, Ackerstraße',
          description: 'Gleicher Schnitt, anderes Stockwerk.',
          sourceUrl: 'https://makler-a.example/expose/3',
        }),
      ],
    ])('%s', (_, a, b) => {
      const result = judge(a, b);
      expect(result.duplicate).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(config.threshold);
      // Symmetric (Req 3.7).
      expect(judge(b, a)).toEqual(result);
    });
  });

  describe('different properties (no duplicate)', () => {
    it.each<[string, Input, Input, string | undefined]>([
      [
        'identical flats of one building with different units',
        merged(flat, { address: { unit: 'WE 3' } }),
        merged(flat, { address: { unit: 'WE 5' } }),
        'UNIT',
      ],
      [
        'identical flats on different floors',
        merged(flat, { floor: 2 }),
        merged(flat, { floor: 3 }),
        'FLOOR',
      ],
      [
        'neighbouring house numbers',
        flat,
        merged(flat, { address: { street: 'Ackerstraße 14' } }),
        'ADDRESS',
      ],
      [
        'same street name in another postal code',
        flat,
        merged(flat, { address: { postalCode: '13355', city: 'Berlin' } }),
        'ADDRESS',
      ],
      [
        'same size and price in the same city, nothing else in common',
        merged(flat, { address: { street: undefined }, sourceUrl: 'https://a.example/1' }),
        merged(flat, {
          ...rewritten,
          address: { street: undefined },
          sourceUrl: 'https://b.example/2',
        }),
        'NO_ANCHOR',
      ],
      [
        'the flat for rent and for sale',
        flat,
        merged(flat, {
          offers: [{ offerType: 'RENT', coldRent: '1450.00', currency: 'EUR' }],
        }),
        'OFFER_TYPE',
      ],
      [
        'a house and a flat at the same address',
        flat,
        merged(house, { address: flat['address'] as Input }),
        'GROUP',
      ],
      [
        'same address, clearly different size and rooms',
        flat,
        merged(flat, {
          ...rewritten,
          rooms: 1,
          area: '31',
          offers: [{ offerType: 'SALE', price: '189000.00', currency: 'EUR' }],
        }),
        undefined,
      ],
      [
        'houses on neighbouring plots with different parcels',
        merged(house, { parcelId: 'Flur 3/17', address: { street: undefined } }),
        merged(house, { parcelId: 'Flur 3/18', address: { street: undefined } }),
        'PARCEL',
      ],
    ])('%s', (_, a, b, excludedBy) => {
      const result = judge(a, b);
      expect(result.duplicate).toBe(false);
      if (excludedBy !== undefined) expect(result.excludedBy).toBe(excludedBy);
      expect(judge(b, a).duplicate).toBe(false);
    });
  });
});
