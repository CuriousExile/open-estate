import {
  createListingService,
  createSearchService,
  InMemorySearchProvider,
  type ResolvedQuery,
  type SearchProvider,
  type SearchServiceDeps,
  type SuspendedAgencies,
} from '@open-estate/core';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  parseSearchQuery,
  type Listing,
  type LocalePreference,
  type SearchQuery,
  type TourProvidersConfig,
} from '@open-estate/shared';
import { exampleListing } from '../../../shared/test/arbitraries';

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const schemas = buildSchemas(taxonomy, {
  defaultLocale: 'de',
  enabled: [
    { locale: 'de', label: 'Deutsch' },
    { locale: 'en', label: 'English' },
  ],
});
const matterport: TourProvidersConfig = {
  providers: [{ code: 'matterport', hostnames: ['My.Matterport.com'] }],
};

function query(raw: Record<string, unknown> = {}): SearchQuery {
  const parsed = parseSearchQuery(raw, schemas);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}

function service(listings: Listing[], overrides: Partial<SearchServiceDeps> = {}) {
  return createSearchService({
    provider: new InMemorySearchProvider(listings),
    taxonomy,
    tourProviders: matterport,
    defaultCurrency: 'EUR',
    ...overrides,
  });
}

async function searchIds(
  listings: Listing[],
  raw: Record<string, unknown>,
  overrides: Partial<SearchServiceDeps> = {},
): Promise<string[]> {
  const result = await service(listings, overrides).search(query(raw), []);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value.items.map((l) => l.id);
}

const sale = (id: string, price: number, currency = 'EUR'): Listing =>
  exampleListing(id, { offers: [{ offerType: 'SALE', price, currency }] });
const rent = (id: string, coldRent: number, currency = 'EUR'): Listing =>
  exampleListing(id, { offers: [{ offerType: 'RENT', coldRent, currency }] });

describe('SearchService', () => {
  it('resolves group to the type codes of the loaded taxonomy', async () => {
    const data = [
      exampleListing('a', { listingType: 'villa' }),
      exampleListing('b', { listingType: 'terraced' }),
      exampleListing('c', { listingType: 'loft' }),
    ];
    await expect(searchIds(data, { group: 'house' })).resolves.toEqual(['a', 'b']);
    await expect(searchIds(data, { types: ['loft', 'villa'] })).resolves.toEqual(['a', 'c']);
  });

  it('returns an empty page (no error) when nothing matches', async () => {
    const result = await service([exampleListing('a')]).search(query({ group: 'land' }), []);
    expect(result).toEqual({ ok: true, value: { items: [] } });
  });

  describe('hasTour', () => {
    const data = [
      exampleListing('allowed', {
        tours: [{ url: 'https://my.matterport.com/show/?m=1', providerCode: 'matterport' }],
      }),
      exampleListing('foreign', {
        tours: [{ url: 'https://tours.other.example/1', providerCode: 'other' }],
      }),
      exampleListing('none'),
    ];

    it('true keeps only listings with a tour host on the current allow-list (case-insensitive)', async () => {
      await expect(searchIds(data, { hasTour: true })).resolves.toEqual(['allowed']);
    });

    it('true with an empty allow-list matches nothing', async () => {
      await expect(
        searchIds(data, { hasTour: true }, { tourProviders: { providers: [] } }),
      ).resolves.toEqual([]);
    });

    it('false applies no tour filter', async () => {
      await expect(searchIds(data, { hasTour: false })).resolves.toEqual([
        'allowed',
        'foreign',
        'none',
      ]);
    });
  });

  describe('offer type and price', () => {
    const both = exampleListing('both', {
      offers: [
        { offerType: 'SALE', price: 300_000_00, currency: 'EUR' },
        { offerType: 'RENT', coldRent: 1_200_00, currency: 'EUR' },
      ],
    });
    const data = [both, sale('sale', 200_000_00), rent('rent', 900_00)];

    it('includes a SALE+RENT listing in searches for both offer types', async () => {
      await expect(searchIds(data, { offerType: 'SALE' })).resolves.toEqual(['both', 'sale']);
      await expect(searchIds(data, { offerType: 'RENT' })).resolves.toEqual(['both', 'rent']);
    });

    it('applies the price range to the offer of the requested type (inclusive)', async () => {
      await expect(
        searchIds(data, { offerType: 'SALE', priceMin: '250000', priceMax: '300000' }),
      ).resolves.toEqual(['both']);
      await expect(
        searchIds(data, { offerType: 'RENT', priceMin: '900', priceMax: '1000' }),
      ).resolves.toEqual(['rent']);
      await expect(searchIds(data, { offerType: 'RENT', priceMax: '1200' })).resolves.toEqual([
        'both',
        'rent',
      ]);
    });

    it('uses the default currency when the price filter has none', async () => {
      const mixed = [sale('eur', 100_00), sale('chf', 100_00, 'CHF')];
      await expect(searchIds(mixed, { offerType: 'SALE', priceMin: '1' })).resolves.toEqual([
        'eur',
      ]);
      await expect(
        searchIds(mixed, { offerType: 'SALE', priceMin: '1' }, { defaultCurrency: 'CHF' }),
      ).resolves.toEqual(['chf']);
      await expect(
        searchIds(mixed, { offerType: 'SALE', priceMin: '1', currency: 'CHF' }),
      ).resolves.toEqual(['chf']);
    });
  });

  describe('currency conversion (convertCurrency=true)', () => {
    // 1 EUR = 40 THB = 1.25 USD; JPY has no rate.
    const exchangeRates = { base: 'EUR', asOf: '2026-11-01', rates: { THB: 40, USD: 1.25 } };
    const data = [
      sale('eur', 100_000_00),
      sale('thb', 4_000_000_00, 'THB'), // = 100,000 EUR
      sale('thb-big', 8_000_000_00, 'THB'), // = 200,000 EUR
      sale('usd', 150_000_00, 'USD'), // = 120,000 EUR
      sale('jpy', 1_00, 'JPY'),
    ];
    const ids = (raw: Record<string, unknown>, deps: Partial<SearchServiceDeps> = {}) =>
      searchIds(data, { offerType: 'SALE', ...raw }, { exchangeRates, ...deps });

    it('matches offers in every currency with a rate after converting the bounds', async () => {
      await expect(ids({ priceMax: '120000', convertCurrency: 'true' })).resolves.toEqual([
        'eur',
        'thb',
        'usd',
      ]);
      await expect(
        ids({ priceMin: '4000000', priceMax: '4000000', currency: 'THB', convertCurrency: true }),
      ).resolves.toEqual(['eur', 'thb']);
    });

    it('compares in one currency without the flag, without rates or for a currency without rate', async () => {
      await expect(ids({ priceMax: '120000' })).resolves.toEqual(['eur']);
      await expect(
        ids({ priceMax: '120000', convertCurrency: true }, { exchangeRates: undefined }),
      ).resolves.toEqual(['eur']);
      await expect(
        ids({ priceMax: '1000', currency: 'JPY', convertCurrency: true }),
      ).resolves.toEqual(['jpy']);
    });

    it('resolves one price condition per currency, the requested one first', async () => {
      const searches: ResolvedQuery[] = [];
      const recording: SearchProvider = {
        search: async (q) => {
          searches.push(q);
          return { items: [] };
        },
        getById: async () => null,
        locations: async () => ({ countries: [], cities: [] }),
      };
      const q = query({
        offerType: 'SALE',
        priceMin: '1.01',
        priceMax: '2',
        convertCurrency: true,
      });
      await service([], { provider: recording, exchangeRates }).search(q, []);
      expect(searches[0]?.price).toEqual([
        { currency: 'EUR', min: 101, max: 200 },
        { currency: 'THB', min: 4040, max: 8000 },
        { currency: 'USD', min: 127, max: 250 },
      ]);
    });
  });

  it('normalizes city and converts rooms/area to the indexed units', async () => {
    const data = [
      exampleListing('a', { rooms: 2.5, area: 60_50 }),
      exampleListing('b', { rooms: 3, area: 80_00 }),
      exampleListing('c', { address: { city: 'München', postalCode: '80331', country: 'DE' } }),
    ];
    await expect(searchIds(data, { city: 'BERLIN', roomsMax: '2.5' })).resolves.toEqual(['a']);
    await expect(searchIds(data, { areaMin: '60.5', areaMax: '60.5' })).resolves.toEqual(['a']);
    await expect(searchIds(data, { city: 'münchen' })).resolves.toEqual(['c']);
  });

  describe('pagination', () => {
    const data = ['e', 'a', 'd', 'c', 'b'].map((id) => exampleListing(id));

    it('round-trips the cursor over two pages', async () => {
      const svc = service(data);
      const first = await svc.search(query({ pageSize: 3 }), []);
      if (!first.ok) throw new Error('first page failed');
      expect(first.value.items.map((l) => l.id)).toEqual(['a', 'b', 'c']);
      expect(first.value.nextPageToken).toEqual(expect.any(String));

      const second = await svc.search(
        query({ pageSize: 3, pageToken: first.value.nextPageToken }),
        [],
      );
      if (!second.ok) throw new Error('second page failed');
      expect(second.value.items.map((l) => l.id)).toEqual(['d', 'e']);
      expect(second.value.nextPageToken).toBeUndefined();
    });

    it('rejects a cursor issued for a different query with INVALID_PAGE_TOKEN', async () => {
      const svc = service(data);
      const first = await svc.search(query({ pageSize: 2 }), []);
      if (!first.ok) throw new Error('first page failed');
      const token = first.value.nextPageToken;

      const otherFilter = await svc.search(
        query({ pageSize: 2, city: 'Berlin', pageToken: token }),
        [],
      );
      const otherSize = await svc.search(query({ pageSize: 3, pageToken: token }), []);
      for (const result of [otherFilter, otherSize]) {
        expect(result).toEqual({
          ok: false,
          error: [expect.objectContaining({ code: 'INVALID_PAGE_TOKEN', field: 'pageToken' })],
        });
      }
    });

    it('rejects a malformed cursor with INVALID_PAGE_TOKEN', async () => {
      const result = await service(data).search(query({ pageToken: 'not-a-cursor' }), []);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.map((e) => e.code)).toEqual(['INVALID_PAGE_TOKEN']);
    });

    it('keeps the cursor valid when only lang changes', async () => {
      const svc = service(data);
      const first = await svc.search(query({ pageSize: 2, lang: 'de' }), [{ tag: 'de', q: 1 }]);
      if (!first.ok) throw new Error('first page failed');
      const second = await svc.search(
        query({ pageSize: 2, lang: 'en', pageToken: first.value.nextPageToken }),
        [{ tag: 'en', q: 1 }],
      );
      expect(second.ok && second.value.items.map((l) => l.id)).toEqual(['c', 'd']);
    });
  });

  it('applies the language selection per listing', async () => {
    const translated = exampleListing('a', {
      title: 'Wohnung',
      description: 'Hell',
      translations: [{ locale: 'en-GB', title: 'Flat', description: 'Bright' }],
    });
    const prefs: LocalePreference[] = [{ tag: 'en', q: 1 }];
    const result = await service([translated, exampleListing('b')]).search(query(), prefs);
    if (!result.ok) throw new Error('search failed');
    const [a, b] = result.value.items;
    expect(a).toMatchObject({
      title: 'Flat',
      description: 'Bright',
      deliveredLocale: 'en-GB',
      originalLocale: 'de',
      group: 'apartment',
    });
    expect(a).not.toHaveProperty('translations');
    expect(b).toMatchObject({ title: 'Listing b', deliveredLocale: 'de' });
  });
});

describe('ListingService', () => {
  const listing = exampleListing('x', {
    translations: [{ locale: 'en', title: 'English title', description: 'Text' }],
  });
  const svc = createListingService({ provider: new InMemorySearchProvider([listing]), taxonomy });

  it('returns the localized listing', async () => {
    const result = await svc.get('x', [{ tag: 'en-US', q: 1 }]);
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({ id: 'x', title: 'English title', deliveredLocale: 'en' }),
    });
  });

  it('returns NOT_FOUND with details.id for an unknown id', async () => {
    await expect(svc.get('missing', [])).resolves.toEqual({
      ok: false,
      error: [expect.objectContaining({ code: 'NOT_FOUND', details: { id: 'missing' } })],
    });
  });
});

const suspendedOf = (...ids: string[]): SuspendedAgencies & { current: jest.Mock } => ({
  current: jest.fn(async () => new Set(ids)),
});

describe('agency suspension and status (Req 1.8, 1.9, 6.4)', () => {
  function provider() {
    const p = new InMemorySearchProvider([exampleListing('plain')]);
    p.put(exampleListing('own'), { status: 'ACTIVE', agencyId: 'agency-ok' });
    p.put(exampleListing('susp'), { status: 'ACTIVE', agencyId: 'agency-x' });
    p.put(exampleListing('off'), { status: 'INACTIVE', agencyId: 'agency-ok' });
    return p;
  }

  it('search passes the sorted suspended set as excludeAgencies and hides those listings', async () => {
    const p = provider();
    const search = jest.spyOn(p, 'search');
    const svc = createSearchService({
      provider: p,
      taxonomy,
      tourProviders: matterport,
      defaultCurrency: 'EUR',
      suspendedAgencies: suspendedOf('agency-z', 'agency-x'),
    });
    const result = await svc.search(query(), []);
    expect(result.ok && result.value.items.map((l) => l.id)).toEqual(['own', 'plain']);
    expect((search.mock.calls[0]?.[0] as ResolvedQuery).excludeAgencies).toEqual([
      'agency-x',
      'agency-z',
    ]);
  });

  it('search omits excludeAgencies when no agency is suspended', async () => {
    const p = provider();
    const search = jest.spyOn(p, 'search');
    const svc = createSearchService({
      provider: p,
      taxonomy,
      tourProviders: matterport,
      defaultCurrency: 'EUR',
    });
    await svc.search(query(), []);
    expect(search.mock.calls[0]?.[0]).not.toHaveProperty('excludeAgencies');
  });

  it('detail answers inactive and suspended listings exactly like unknown ids', async () => {
    const suspendedAgencies = suspendedOf('agency-x');
    const svc = createListingService({ provider: provider(), taxonomy, suspendedAgencies });
    const notFound = async (id: string) => {
      const unknown = await svc.get(`${id}-unknown`, []);
      const actual = await svc.get(id, []);
      // Same shape and code; only the echoed id differs.
      expect(JSON.stringify(actual).replaceAll(id, '#')).toBe(
        JSON.stringify(unknown).replaceAll(`${id}-unknown`, '#'),
      );
      expect(actual).toMatchObject({ ok: false, error: [{ code: 'NOT_FOUND' }] });
    };
    await notFound('off');
    await notFound('susp');
    await expect(svc.get('own', [])).resolves.toMatchObject({ ok: true, value: { id: 'own' } });
    await expect(svc.get('plain', [])).resolves.toMatchObject({ ok: true });
  });

  it('detail loads the suspended set only for listings with agency', async () => {
    const suspendedAgencies = suspendedOf();
    const svc = createListingService({ provider: provider(), taxonomy, suspendedAgencies });
    await svc.get('plain', []);
    await svc.get('missing', []);
    expect(suspendedAgencies.current).not.toHaveBeenCalled();
    await svc.get('own', []);
    expect(suspendedAgencies.current).toHaveBeenCalledTimes(1);
  });
});
