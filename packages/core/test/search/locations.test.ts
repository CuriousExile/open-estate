import {
  aggregateLocations,
  buildLocationsQueryInput,
  buildOpenSearchLocationsBody,
  createLocationService,
  DynamoDbSearchProvider,
  InMemorySearchProvider,
  LISTINGS_BY_ID_INDEX,
  locationsOf,
  OpenSearchSearchProvider,
  ServiceUnavailableError,
  type SuspendedAgencies,
} from '@open-estate/core';
import type { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Listing } from '@open-estate/shared';
import { listing } from './fixtures';

const at = (id: string, city: string, country: string): Listing => {
  const l = listing(id);
  return { ...l, address: { ...l.address, city, country } };
};

describe('aggregateLocations', () => {
  it('counts per country and per city, grouping case variants of a city', () => {
    const doc = aggregateLocations([
      { country: 'DE', city: 'Lübeck' },
      { country: 'DE', city: 'LÜBECK' },
      { country: 'DE', city: 'Lübeck' },
      { country: 'TH', city: 'Bangkok' },
      { country: 'DE', city: 'Berlin' },
    ]);
    expect(doc).toEqual({
      countries: [
        { code: 'DE', count: 4 },
        { code: 'TH', count: 1 },
      ],
      cities: [
        { name: 'Berlin', country: 'DE', count: 1 },
        { name: 'Lübeck', country: 'DE', count: 3 },
        { name: 'Bangkok', country: 'TH', count: 1 },
      ],
    });
  });

  it('keeps equally named cities of different countries apart', () => {
    const { cities } = aggregateLocations([
      { country: 'US', city: 'Berlin' },
      { country: 'DE', city: 'Berlin' },
    ]);
    expect(cities.map((c) => c.country)).toEqual(['DE', 'US']);
  });

  it('drops listings of excluded agencies, keeps listings without agency', () => {
    const doc = aggregateLocations(
      [
        { country: 'DE', city: 'Kiel', agencyId: 'a-1' },
        { country: 'AT', city: 'Wien', agencyId: 'a-2' },
        { country: 'TH', city: 'Pattaya' },
      ],
      { excludeAgencies: ['a-2'] },
    );
    expect(doc.countries.map((c) => c.code)).toEqual(['DE', 'TH']);
    expect(doc.cities.map((c) => c.name)).toEqual(['Kiel', 'Pattaya']);
  });

  it('picks the lowest spelling on a tie', () => {
    const { cities } = aggregateLocations([
      { country: 'DE', city: 'kiel' },
      { country: 'DE', city: 'Kiel' },
    ]);
    expect(cities).toEqual([{ name: 'Kiel', country: 'DE', count: 2 }]);
  });
});

describe('InMemorySearchProvider', () => {
  it('filters by country', async () => {
    const provider = new InMemorySearchProvider([
      at('a', 'Berlin', 'DE'),
      at('b', 'Bangkok', 'TH'),
      at('c', 'Pattaya', 'TH'),
    ]);
    const { items } = await provider.search({ country: 'TH' });
    expect(items.map((l) => l.id)).toEqual(['b', 'c']);
    expect((await provider.search({ country: 'FR' })).items).toEqual([]);
  });

  it('aggregates only ACTIVE listings', async () => {
    const provider = new InMemorySearchProvider([at('a', 'Berlin', 'DE')]);
    provider.put(at('b', 'Bangkok', 'TH'), { status: 'INACTIVE', agencyId: 'x' });
    await expect(provider.locations({})).resolves.toEqual({
      countries: [{ code: 'DE', count: 1 }],
      cities: [{ name: 'Berlin', country: 'DE', count: 1 }],
    });
  });
});

describe('createLocationService', () => {
  it('excludes suspended agencies (sorted)', async () => {
    const provider = new InMemorySearchProvider();
    provider.put(at('a', 'Berlin', 'DE'), { status: 'ACTIVE', agencyId: 'b-2' });
    provider.put(at('b', 'Kiel', 'DE'), { status: 'ACTIVE', agencyId: 'a-1' });
    provider.put(at('c', 'Bangkok', 'TH'));
    const locations = jest.spyOn(provider, 'locations');
    const suspendedAgencies: SuspendedAgencies = {
      current: async () => new Set(['b-2', 'a-1']),
    };
    const doc = await createLocationService({ provider, suspendedAgencies }).locations();
    expect(locations).toHaveBeenCalledWith({ excludeAgencies: ['a-1', 'b-2'] });
    expect(doc.countries).toEqual([{ code: 'TH', count: 1 }]);
  });
});

describe('DynamoDbSearchProvider.locations', () => {
  const TABLE = 'Listings';

  function setup(pages: Record<string, unknown>[][]) {
    let now = 0;
    const send = jest.fn(async (command: QueryCommand) => {
      const start = command.input.ExclusiveStartKey as { page?: number } | undefined;
      const index = start?.page ?? 0;
      return {
        Items: pages[index] ?? [],
        ...(index + 1 < pages.length && { LastEvaluatedKey: { page: index + 1 } }),
      };
    });
    const provider = new DynamoDbSearchProvider({
      client: { send } as never,
      tableName: TABLE,
      clock: () => now,
      locationsCacheTtlMs: 1000,
    });
    return { provider, send, advance: (ms: number) => (now += ms) };
  }

  const item = (city: string, country: string, agencyId?: string) => ({
    address: { city },
    country,
    ...(agencyId !== undefined && { agencyId }),
  });

  it('reads all pages of a projection query on byId', async () => {
    const { provider, send } = setup([
      [item('Berlin', 'DE'), item('Bangkok', 'TH', 'a-1')],
      [item('Berlin', 'DE'), { country: 'DE' }],
    ]);
    await expect(provider.locations({ excludeAgencies: ['a-1'] })).resolves.toEqual({
      countries: [{ code: 'DE', count: 2 }],
      cities: [{ name: 'Berlin', country: 'DE', count: 2 }],
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0].input).toEqual({
      ...buildLocationsQueryInput(TABLE),
      ExclusiveStartKey: undefined,
    });
    expect(buildLocationsQueryInput(TABLE)).toMatchObject({
      IndexName: LISTINGS_BY_ID_INDEX,
      ProjectionExpression: '#country, #address.#city, #agencyId',
    });
  });

  it('caches the rows for the TTL and applies suspensions per call', async () => {
    const { provider, send, advance } = setup([[item('Kiel', 'DE', 'a-1')]]);
    expect((await provider.locations({})).countries).toHaveLength(1);
    expect((await provider.locations({ excludeAgencies: ['a-1'] })).countries).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(1);
    advance(1000);
    await provider.locations({});
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('maps a failure to ServiceUnavailableError and does not cache it', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ Items: [] });
    const provider = new DynamoDbSearchProvider({ client: { send } as never, tableName: TABLE });
    await expect(provider.locations({})).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(provider.locations({})).resolves.toEqual({ countries: [], cities: [] });
  });
});

describe('OpenSearch locations', () => {
  it('aggregates country → cityNorm → top_hits and excludes suspended owners', () => {
    expect(buildOpenSearchLocationsBody({ excludeAgencies: ['a-1'] })).toMatchObject({
      size: 0,
      query: { bool: { filter: [], must_not: [{ terms: { agencyId: ['a-1'] } }] } },
      aggs: {
        countries: {
          terms: { field: 'country' },
          aggs: { cities: { terms: { field: 'cityNorm' } } },
        },
      },
    });
    expect(buildOpenSearchLocationsBody({}).query).toEqual({ bool: { filter: [] } });
  });

  const hit = (city: string) => ({
    hits: { hits: [{ _source: { listing: { address: { city } } } }] },
  });
  const response = {
    aggregations: {
      countries: {
        buckets: [
          {
            key: 'TH',
            doc_count: 2,
            cities: { buckets: [{ key: 'pattaya', doc_count: 2, name: hit('Pattaya') }] },
          },
          {
            key: 'DE',
            doc_count: 3,
            cities: {
              buckets: [
                { key: 'lübeck', doc_count: 2, name: hit('Lübeck') },
                { key: 'berlin', doc_count: 1, name: hit('Berlin') },
              ],
            },
          },
        ],
      },
    },
  };

  it('parses the buckets into an ordered document', () => {
    expect(locationsOf(response)).toEqual({
      countries: [
        { code: 'DE', count: 3 },
        { code: 'TH', count: 2 },
      ],
      cities: [
        { name: 'Berlin', country: 'DE', count: 1 },
        { name: 'Lübeck', country: 'DE', count: 2 },
        { name: 'Pattaya', country: 'TH', count: 2 },
      ],
    });
  });

  it('rejects a malformed response as ServiceUnavailableError', async () => {
    const provider = new OpenSearchSearchProvider({
      client: { search: () => Promise.resolve({ body: { hits: {} } }) },
      index: 'listings',
    });
    await expect(provider.locations({})).rejects.toBeInstanceOf(ServiceUnavailableError);
    const ok = new OpenSearchSearchProvider({
      client: { search: () => Promise.resolve({ body: response }) },
      index: 'listings',
    });
    await expect(ok.locations({})).resolves.toEqual(locationsOf(response));
  });
});
