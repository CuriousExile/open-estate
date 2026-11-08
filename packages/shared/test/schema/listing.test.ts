import fc from 'fast-check';
import {
  assertValidTaxonomy,
  DEFAULT_TAXONOMY_CONFIG,
  Listing,
  LISTING_BOUNDS,
  LocalizedListing,
  parse,
  piiFieldPaths,
  serialize,
} from '../../src';
import { arbListing, OFFER_TYPE_COMBINATIONS } from '../arbitraries';

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);

const sale = { offerType: 'SALE', price: '350000.50', currency: 'EUR' } as const;
const rent = { offerType: 'RENT', coldRent: '1250', currency: 'EUR' } as const;

/** Valid listing in API/raw representation; `overrides` replace top-level fields. */
function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'lst-1',
    originalLocale: 'de',
    title: 'Helle Altbauwohnung',
    description: 'Drei Zimmer mit Balkon.',
    translations: [{ locale: 'en', title: 'Bright period flat', description: 'Three rooms.' }],
    offers: [sale],
    listingType: 'apartment_unit',
    rooms: 3.5,
    area: '85.5',
    address: { city: 'Berlin', postalCode: '10115', country: 'DE' },
    sourceUrl: 'https://partner.example/listings/1',
    media: [{ url: 'https://cdn.example/1.jpg' }],
    tours: [{ url: 'https://my.matterport.com/show/?m=abc', providerCode: 'matterport' }],
    source: 'partner-api',
    lastImportedAt: '2025-01-01T10:00:00+01:00',
    lastRunId: 'run-1',
    ...overrides,
  };
}

function issues(raw: unknown) {
  const result = Listing.safeParse(raw);
  expect(result.success).toBe(false);
  return result.error?.issues ?? [];
}

const issuePaths = (raw: unknown): string[] => issues(raw).map((i) => i.path.join('.'));

describe('Listing schema', () => {
  it('accepts a complete listing and converts amounts and area to minor units', () => {
    const parsed = Listing.parse(input());
    expect(parsed.offers).toEqual([{ offerType: 'SALE', price: 35_000_050, currency: 'EUR' }]);
    expect(parsed.area).toBe(8_550);
    expect(parsed.rooms).toBe(3.5);
  });

  it('drops unknown fields', () => {
    expect(Listing.parse(input({ internalNote: 'x' }))).not.toHaveProperty('internalNote');
  });

  describe('offers', () => {
    it.each([
      ['SALE only', [sale]],
      ['RENT only', [rent]],
      ['SALE + RENT', [sale, rent]],
    ])('accepts %s', (_name, offers) => {
      expect(Listing.safeParse(input({ offers })).success).toBe(true);
    });

    it.each([
      ['no offer', []],
      ['three offers', [sale, rent, sale]],
      ['two SALE offers', [sale, sale]],
      ['two RENT offers', [rent, rent]],
    ])('rejects %s on field offers', (_name, offers) => {
      expect(issuePaths(input({ offers }))).toEqual(['offers']);
    });

    it('accepts additional costs and a warm rent equal to the cold rent', () => {
      const offer = { ...rent, additionalCosts: '250.50', warmRent: '1250.00' };
      expect(Listing.parse(input({ offers: [offer] })).offers[0]).toEqual({
        offerType: 'RENT',
        coldRent: 125_000,
        currency: 'EUR',
        additionalCosts: 25_050,
        warmRent: 125_000,
      });
    });

    it('rejects a warm rent below the cold rent on field warmRent', () => {
      const offer = { ...rent, warmRent: '1249.99' };
      expect(issuePaths(input({ offers: [sale, offer] }))).toEqual(['offers.1.warmRent']);
    });

    it('rejects rent fields on a SALE offer and names each of them', () => {
      const offer = { ...sale, additionalCosts: '100', warmRent: '200' };
      const [issue] = issues(input({ offers: [offer] }));
      expect(issue).toMatchObject({
        code: 'unrecognized_keys',
        path: ['offers', 0],
        keys: ['additionalCosts', 'warmRent'],
      });
    });

    it('rejects an unknown offer type on field offerType', () => {
      const offer = { offerType: 'LEASE', price: '1', currency: 'EUR' };
      expect(issuePaths(input({ offers: [offer] }))).toEqual(['offers.0.offerType']);
    });
  });

  describe('rooms', () => {
    it.each([0, 0.5, 2.5, 99.5])('accepts %d', (rooms) => {
      expect(Listing.safeParse(input({ rooms })).success).toBe(true);
    });

    it.each([2.3, -0.5, 100, Number.NaN])('rejects %d', (rooms) => {
      expect(issuePaths(input({ rooms }))).toContain('rooms');
    });
  });

  it('requires the country in the address', () => {
    expect(issuePaths(input({ address: { city: 'Berlin', postalCode: '10115' } }))).toEqual([
      'address.country',
    ]);
  });

  describe('geo', () => {
    it('accepts a complete pair and a missing geo object', () => {
      expect(Listing.safeParse(input({ geo: { lat: 52.5, lon: 13.4 } })).success).toBe(true);
      expect(Listing.safeParse(input()).success).toBe(true);
    });

    it.each([
      [{ lat: 52.5 }, 'geo.lon', 'lon is required together with lat'],
      [{ lon: 13.4 }, 'geo.lat', 'lat is required together with lon'],
    ])('names the missing coordinate of a half pair %j', (geo, path, message) => {
      const result = issues(input({ geo }));
      expect(result.map((i) => [i.path.join('.'), i.message])).toEqual([[path, message]]);
    });

    it('rejects coordinates out of range', () => {
      expect(issuePaths(input({ geo: { lat: 90.1, lon: -180.1 } }))).toEqual([
        'geo.lat',
        'geo.lon',
      ]);
    });

    it.each([
      [
        { lat: 5e-324, lon: -1e-131 },
        { lat: 0, lon: 0 },
      ],
      [
        { lat: -0, lon: -0.0000004 },
        { lat: 0, lon: 0 },
      ],
      [
        { lat: 52.5200064, lon: -13.4049954 },
        { lat: 52.520006, lon: -13.404995 },
      ],
      [
        { lat: 89.9999996, lon: -180 },
        { lat: 90, lon: -180 },
      ],
    ])('rounds %j to 6 decimal places without -0 or underflowing values', (geo, expected) => {
      const parsed = Listing.parse(input({ geo }));
      expect(parsed.geo).toEqual(expected);
      expect(Object.is(parsed.geo?.lat, -0) || Object.is(parsed.geo?.lon, -0)).toBe(false);
      // Idempotent: parsing the output again changes nothing.
      expect(Listing.parse(input({ geo: parsed.geo })).geo).toEqual(parsed.geo);
    });
  });

  describe('translations', () => {
    const t = (locale: string) => ({ locale, title: 'T', description: '' });

    it('rejects a translation in the original locale (case-insensitive)', () => {
      expect(issuePaths(input({ translations: [t('DE')] }))).toEqual(['translations.0.locale']);
    });

    it('rejects duplicate translation locales', () => {
      expect(issuePaths(input({ translations: [t('en'), t('en')] }))).toEqual([
        'translations.1.locale',
      ]);
    });

    it('rejects an invalid locale tag', () => {
      expect(issuePaths(input({ translations: [t('not a locale')] }))).toEqual([
        'translations.0.locale',
      ]);
    });

    it('reports a duplicate locale together with a missing required field', () => {
      const address = { city: 'Berlin', country: 'DE' };
      const paths = issuePaths(input({ address, translations: [t('en'), t('EN')] }));
      expect(paths.sort()).toEqual(['address.postalCode', 'translations.1.locale']);
    });

    it('checks the remaining locales when the original locale or the translations are invalid', () => {
      expect(
        issuePaths(input({ originalLocale: undefined, translations: [t('en'), t('en')] })).sort(),
      ).toEqual(['originalLocale', 'translations.1.locale']);
      expect(issuePaths(input({ translations: [t('x y'), t('X Y')] }))).toEqual([
        'translations.0.locale',
        'translations.1.locale',
      ]);
      expect(issuePaths(input({ translations: 'en' }))).toEqual(['translations']);
      expect(
        issuePaths(input({ translations: [null, { title: 'T', description: '' }] })).sort(),
      ).toEqual(['translations.0', 'translations.1.locale']);
    });

    // Too many items must not abort the duplicate-locale rule (Zod's array `.max()` would).
    it.each([
      ['offers', Array(LISTING_BOUNDS.offers.max + 1).fill(sale)],
      ['media', Array(LISTING_BOUNDS.media.max + 1).fill({ url: 'https://cdn.example/a.jpg' })],
      [
        'tours',
        Array(LISTING_BOUNDS.tours.max + 1).fill({
          url: 'https://my.matterport.com/show',
          providerCode: 'matterport',
        }),
      ],
    ])('reports a duplicate locale together with too many %s', (field, items) => {
      const paths = issuePaths(input({ [field]: items, translations: [t('en'), t('en')] }));
      expect(paths).toEqual(expect.arrayContaining([field, 'translations.1.locale']));
    });

    it('reports a duplicate locale together with too many translations', () => {
      const translations = Array.from({ length: LISTING_BOUNDS.translations.max + 1 }, () =>
        t('en'),
      );
      const paths = issuePaths(input({ translations }));
      expect(paths).toEqual(expect.arrayContaining(['translations', 'translations.1.locale']));
    });

    it(`accepts ${LISTING_BOUNDS.translations.max} and rejects more translations`, () => {
      const locales = Array.from({ length: LISTING_BOUNDS.translations.max + 1 }, (_, i) =>
        t(`en-${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}`),
      );
      const max = locales.slice(0, LISTING_BOUNDS.translations.max);
      expect(Listing.safeParse(input({ translations: max })).success).toBe(true);
      expect(issuePaths(input({ translations: locales }))).toEqual(['translations']);
    });
  });

  describe('media and tours', () => {
    const media = { url: 'https://cdn.example/a.jpg' };
    const tour = { url: 'https://my.matterport.com/show', providerCode: 'matterport' };

    it.each([
      ['media', media, LISTING_BOUNDS.media.max],
      ['tours', tour, LISTING_BOUNDS.tours.max],
    ])('accepts at most the maximum number of %s', (field, item, max) => {
      expect(Listing.safeParse(input({ [field]: Array(max).fill(item) })).success).toBe(true);
      expect(issuePaths(input({ [field]: Array(max + 1).fill(item) }))).toEqual([field]);
    });

    it('rejects non-https media URLs', () => {
      expect(issuePaths(input({ media: [{ url: 'http://cdn.example/a.jpg' }] }))).toEqual([
        'media.0.url',
      ]);
    });
  });

  it('marks all contact fields as PII', () => {
    expect(piiFieldPaths(Listing)).toEqual(['contact.name', 'contact.phone', 'contact.email']);
    expect(piiFieldPaths(LocalizedListing)).toEqual(piiFieldPaths(Listing));
  });
});

describe('serialize / parse', () => {
  const listing = Listing.parse(
    input({
      offers: [sale, { ...rent, warmRent: '1500.5' }],
      geo: { lat: 52.5, lon: 13.4 },
      contact: { name: 'Maklerbüro Beispiel' },
    }),
  );
  const version = {
    title: 'Bright period flat',
    description: 'Three rooms.',
    deliveredLocale: 'en',
  };

  it('produces the API representation with decimal strings and the selected version', () => {
    const api = serialize(listing, { taxonomy, version });
    expect(api).toMatchObject({
      title: 'Bright period flat',
      description: 'Three rooms.',
      deliveredLocale: 'en',
      originalLocale: 'de',
      group: 'apartment',
      area: '85.50',
      rooms: 3.5,
      offers: [
        { offerType: 'SALE', price: '350000.50', currency: 'EUR' },
        { offerType: 'RENT', coldRent: '1250.00', currency: 'EUR', warmRent: '1500.50' },
      ],
    });
    expect(api).not.toHaveProperty('translations');
  });

  it('parses the API representation back to minor units', () => {
    const result = parse(serialize(listing, { taxonomy, version }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { originalLocale, offers, listingType, rooms, area, address, geo, sourceUrl } = listing;
    expect(result.value).toEqual({
      ...version,
      id: listing.id,
      originalLocale,
      offers,
      listingType,
      group: 'apartment',
      rooms,
      area,
      address,
      geo,
      sourceUrl,
      media: listing.media,
      tours: listing.tours,
      contact: listing.contact,
      source: listing.source,
      lastImportedAt: listing.lastImportedAt,
      lastRunId: listing.lastRunId,
    });
  });

  it('omits the group of a type that is not in the taxonomy', () => {
    const api = serialize({ ...listing, listingType: 'castle' }, { taxonomy, version });
    expect(api).not.toHaveProperty('group');
  });

  it('reports all issues of an invalid API representation', () => {
    const result = parse({ ...serialize(listing, { taxonomy, version }), area: '0.5', rooms: 1.2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.map((i) => i.path.join('.'))).toEqual(['rooms', 'area']);
  });
});

describe('listing arbitraries', () => {
  it('generate listings accepted by the API schema', () => {
    fc.assert(
      fc.property(arbListing(), (l) => {
        const version = {
          title: l.title,
          description: l.description,
          deliveredLocale: l.originalLocale,
        };
        expect(parse(serialize(l, { taxonomy, version })).ok).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('generate every offer-type combination', () => {
    // A fixed-seed sample, not `fc.assert`: the quick tier caps property runs at 10, and ten
    // random draws regularly miss one of the four combinations.
    const combinations = new Set(
      fc
        .sample(arbListing(), { numRuns: 200, seed: 42 })
        .map((l) => l.offers.map((o) => o.offerType).join('+')),
    );
    expect(combinations.size).toBe(OFFER_TYPE_COMBINATIONS.length);
  });
});
