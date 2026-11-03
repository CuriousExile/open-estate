import {
  DEFAULT_PAGE_SIZE,
  InMemorySearchProvider,
  MAX_PAGE_SIZE,
  normalizeCity,
  type ResolvedQuery,
} from '@open-estate/core';
import { exampleListing } from '../../../shared/test/arbitraries';
import { listing, listings, sortedIds } from './fixtures';

describe('InMemorySearchProvider', () => {
  it('returns an empty result for an empty store', async () => {
    const provider = new InMemorySearchProvider();
    await expect(provider.search({})).resolves.toEqual({ items: [] });
  });

  it('returns items in id ASC order', async () => {
    const data = [listing('c'), listing('a'), listing('B'), listing('b')];
    const { items } = await new InMemorySearchProvider(data).search({});
    expect(items.map((l) => l.id)).toEqual(['B', 'a', 'b', 'c']);
  });

  // U+FF01 (UTF-8 EF BC 81) < U+1F600 (F0 9F 98 80) by bytes, but U+1F600 (D83D …) < U+FF01 by
  // UTF-16 code units — the order DynamoDB Local delivered for this counterexample.
  it('orders and resumes by UTF-8 byte order, not UTF-16 code units', async () => {
    const provider = new InMemorySearchProvider(['\uFF01', '\u{1F600}', 'a'].map(listing));
    const { items } = await provider.search({});
    expect(items.map((l) => l.id)).toEqual(['a', '\uFF01', '\u{1F600}']);
    const rest = await provider.search({ after: '\uFF01' });
    expect(rest.items.map((l) => l.id)).toEqual(['\u{1F600}']);
  });

  it('limits to the default page size of 20 when pageSize is omitted', async () => {
    const data = listings(30);
    const { items } = await new InMemorySearchProvider(data).search({});
    expect(items).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(items.map((l) => l.id)).toEqual(sortedIds(data).slice(0, DEFAULT_PAGE_SIZE));
  });

  it.each([1, 7, 50])('returns at most pageSize=%i items', async (pageSize) => {
    const { items } = await new InMemorySearchProvider(listings(60)).search({ pageSize });
    expect(items).toHaveLength(pageSize);
  });

  it('caps pageSize at the maximum of 50', async () => {
    const { items } = await new InMemorySearchProvider(listings(60)).search({ pageSize: 500 });
    expect(items).toHaveLength(MAX_PAGE_SIZE);
  });

  it('returns fewer items than pageSize when the store is smaller', async () => {
    const { items } = await new InMemorySearchProvider(listings(3)).search({ pageSize: 10 });
    expect(items).toHaveLength(3);
  });

  it('getById returns the listing or null', async () => {
    const provider = new InMemorySearchProvider([listing('a')]);
    await expect(provider.getById('a')).resolves.toEqual(listing('a'));
    await expect(provider.getById('missing')).resolves.toBeNull();
  });

  it('put replaces a listing with the same id', async () => {
    const provider = new InMemorySearchProvider([listing('a')]);
    provider.put({ ...listing('a'), title: 'Updated' });
    const { items } = await provider.search({});
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Updated');
  });
});

describe('InMemorySearchProvider filters', () => {
  const sale = (price: number, currency = 'EUR') =>
    ({ offerType: 'SALE', price, currency }) as const;
  const rent = (coldRent: number, currency = 'EUR') =>
    ({ offerType: 'RENT', coldRent, currency }) as const;
  const tour = (host: string) => ({ url: `https://${host}/t`, providerCode: 'p' });

  const data = [
    exampleListing('s1', { offers: [sale(100_000_00)] }),
    exampleListing('s2', { offers: [sale(300_000_00)] }),
    exampleListing('s3', { offers: [sale(200_000_00, 'USD')] }),
    exampleListing('r1', { offers: [rent(800_00)] }),
    exampleListing('b1', { offers: [sale(200_000_00), rent(1_000_00)] }),
    exampleListing('k1', {
      offers: [rent(500_00)],
      rooms: 1.5,
      area: 40_00,
      listingType: 'house',
      address: { city: 'Köln', postalCode: '50667', country: 'DE' },
      tours: [tour('my.matterport.com')],
    }),
    exampleListing('k2', {
      address: { city: 'KÖLN', postalCode: '50668', country: 'DE' },
      tours: [tour('other.example')],
    }),
  ];
  const provider = new InMemorySearchProvider(data);
  const ids = async (q: ResolvedQuery) => (await provider.search(q)).items.map((l) => l.id);

  it('offerType matches listings with an offer of that type, SALE + RENT in both', async () => {
    await expect(ids({ offerType: 'SALE' })).resolves.toEqual(['b1', 'k2', 's1', 's2', 's3']);
    await expect(ids({ offerType: 'RENT' })).resolves.toEqual(['b1', 'k1', 'r1']);
  });

  it('price is inclusive, applies to the selected offer type and requires its currency', async () => {
    const price = { currency: 'EUR', min: 100_000_00, max: 200_000_00 };
    await expect(ids({ offerType: 'SALE', price })).resolves.toEqual(['b1', 'k2', 's1']);
    // b1's sale price must not satisfy a RENT price filter.
    await expect(
      ids({ offerType: 'RENT', price: { currency: 'EUR', min: 900_00 } }),
    ).resolves.toEqual(['b1']);
    await expect(
      ids({ offerType: 'SALE', price: { currency: 'USD', max: 200_000_00 } }),
    ).resolves.toEqual(['s3']);
  });

  it('rooms, area, city (case-insensitive), postal code and types are AND-combined', async () => {
    await expect(ids({ cityNorm: normalizeCity('KöLN') })).resolves.toEqual(['k1', 'k2']);
    await expect(ids({ cityNorm: 'köl' })).resolves.toEqual([]);
    await expect(ids({ cityNorm: 'köln', postalCode: '50667' })).resolves.toEqual(['k1']);
    await expect(ids({ roomsHalf: { max: 3 } })).resolves.toEqual(['k1']);
    await expect(ids({ areaMinor: { min: 40_00, max: 40_00 } })).resolves.toEqual(['k1']);
    await expect(ids({ listingTypes: ['house', 'villa'] })).resolves.toEqual(['k1']);
    await expect(ids({ listingTypes: [] })).resolves.toEqual([]);
    await expect(
      ids({ offerType: 'SALE', cityNorm: 'köln', roomsHalf: { min: 6 } }),
    ).resolves.toEqual(['k2']);
  });

  it('hasTour matches only tours whose host is currently allowed', async () => {
    await expect(ids({ tourHosts: ['my.matterport.com'] })).resolves.toEqual(['k1']);
    await expect(ids({ tourHosts: ['my.matterport.com', 'other.example'] })).resolves.toEqual([
      'k1',
      'k2',
    ]);
    await expect(ids({ tourHosts: [] })).resolves.toEqual([]);
  });
});

describe('InMemorySearchProvider pagination', () => {
  it('sets next only when more matches follow and resumes after lastId', async () => {
    const provider = new InMemorySearchProvider(listings(5));
    const first = await provider.search({ pageSize: 2 });
    expect(first.items.map((l) => l.id)).toEqual(['id-000', 'id-001']);
    expect(first.next).toEqual({ lastId: 'id-001' });

    const second = await provider.search({ pageSize: 2, after: 'id-001' });
    expect(second.items.map((l) => l.id)).toEqual(['id-002', 'id-003']);
    expect(second.next).toEqual({ lastId: 'id-003' });

    const last = await provider.search({ pageSize: 2, after: 'id-003' });
    expect(last.items.map((l) => l.id)).toEqual(['id-004']);
    expect(last).not.toHaveProperty('next');
  });

  it('has no next when the matches exactly fill the page', async () => {
    const result = await new InMemorySearchProvider(listings(3)).search({ pageSize: 3 });
    expect(result.items).toHaveLength(3);
    expect(result).not.toHaveProperty('next');
  });

  it('after need not be an existing id and may be past the end', async () => {
    const provider = new InMemorySearchProvider(listings(3));
    await expect(provider.search({ after: 'id-000x' })).resolves.toMatchObject({
      items: [{ id: 'id-001' }, { id: 'id-002' }],
    });
    await expect(provider.search({ after: 'zzz' })).resolves.toEqual({ items: [] });
  });

  it('paginates over filtered matches only', async () => {
    const data = listings(6).map((l, i) => ({ ...l, rooms: i % 2 === 0 ? 2 : 4 }));
    const provider = new InMemorySearchProvider(data);
    const first = await provider.search({ roomsHalf: { min: 8 }, pageSize: 2 });
    const rest = await provider.search({
      roomsHalf: { min: 8 },
      pageSize: 2,
      after: first.next?.lastId ?? '',
    });
    const all = [...first.items, ...rest.items].map((l) => l.rooms);
    expect(all).toEqual([4, 4, 4]);
    expect(rest).not.toHaveProperty('next');
  });
});
