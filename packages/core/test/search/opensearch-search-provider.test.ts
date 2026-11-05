import {
  buildOpenSearchFilter,
  buildOpenSearchSearchBody,
  ConfigError,
  createSearchProvider,
  DEFAULT_PAGE_SIZE,
  DynamoDbSearchProvider,
  fromOpenSearchDocument,
  matchesQuery,
  OPENSEARCH_INDEX_MAPPING,
  OPENSEARCH_REQUEST_DEADLINE_MS,
  OpenSearchSearchProvider,
  parseSearchProviderKind,
  ServiceUnavailableError,
  toOpenSearchDocument,
  toSearchDocument,
  type OpenSearchClientLike,
  type OpenSearchFilterClause,
  type OpenSearchSearchProviderOptions,
  type ResolvedQuery,
  type SearchDocument,
} from '@open-estate/core';
import type { Listing } from '@open-estate/shared';
import fc from 'fast-check';
import { listing, listings } from './fixtures';

const INDEX = 'listings';

type SearchFn = OpenSearchClientLike['search'];

/** Client stub: answers with the given listings as hits; records every request. */
function setup(answer: (body: Record<string, unknown>) => Listing[] | Promise<Listing[]>) {
  const search = jest.fn<ReturnType<SearchFn>, Parameters<SearchFn>>(async ({ body }) => ({
    body: { hits: { hits: (await answer(body)).map((l) => ({ _source: { listing: l } })) } },
  }));
  const options = (extra: Partial<OpenSearchSearchProviderOptions> = {}) =>
    new OpenSearchSearchProvider({ client: { search }, index: INDEX, ...extra });
  return { search, provider: options(), options };
}

/** Behaves like the index for `search_after`/`size` over `all` (no filter evaluation). */
function pageOf(all: readonly Listing[]) {
  return (body: Record<string, unknown>) => {
    const [after] = (body['search_after'] as string[] | undefined) ?? [];
    return [...all]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .filter((l) => after === undefined || l.id > after)
      .slice(0, body['size'] as number);
  };
}

describe('OPENSEARCH_INDEX_MAPPING / toOpenSearchDocument', () => {
  it('maps every flat search field and keeps the listing non-indexed', () => {
    const doc = toOpenSearchDocument(listing('a'), 'agency-1');
    const { listing: stored, ...flat } = OPENSEARCH_INDEX_MAPPING.properties;
    expect(stored).toEqual({ type: 'object', enabled: false });
    for (const field of Object.keys(doc).filter((k) => k !== 'listing')) {
      expect(flat).toHaveProperty(field);
    }
    expect(OPENSEARCH_INDEX_MAPPING.properties.id.type).toBe('keyword');
    expect(OPENSEARCH_INDEX_MAPPING.properties.tourHosts.type).toBe('keyword');
    expect(OPENSEARCH_INDEX_MAPPING.properties.roomsHalf.type).toBe('integer');
    expect(OPENSEARCH_INDEX_MAPPING.properties.agencyId.type).toBe('keyword');
  });

  it('stores flat document + listing and round-trips to the listing', () => {
    const l = listing('a');
    const doc = toOpenSearchDocument(l);
    expect(doc).toEqual({ ...toSearchDocument(l), listing: l });
    expect(fromOpenSearchDocument(doc)).toEqual(l);
  });
});

describe('buildOpenSearchFilter', () => {
  it('produces no clause for an empty query', () => {
    expect(buildOpenSearchFilter({})).toEqual([]);
  });

  it('offer type → exists on the amount field', () => {
    expect(buildOpenSearchFilter({ offerType: 'SALE' })).toEqual([
      { exists: { field: 'saleAmountMinor' } },
    ]);
    expect(buildOpenSearchFilter({ offerType: 'RENT' })).toEqual([
      { exists: { field: 'rentAmountMinor' } },
    ]);
  });

  it('price → currency term + range on the amount of the offer type', () => {
    expect(
      buildOpenSearchFilter({ offerType: 'RENT', price: { currency: 'EUR', min: 100, max: 900 } }),
    ).toEqual([
      { exists: { field: 'rentAmountMinor' } },
      { term: { rentCurrency: 'EUR' } },
      { range: { rentAmountMinor: { gte: 100, lte: 900 } } },
    ]);
    expect(buildOpenSearchFilter({ offerType: 'SALE', price: { currency: 'USD' } })).toEqual([
      { exists: { field: 'saleAmountMinor' } },
      { term: { saleCurrency: 'USD' } },
    ]);
  });

  it('rooms and area → ranges with only the given bounds', () => {
    expect(buildOpenSearchFilter({ roomsHalf: { min: 4 }, areaMinor: { max: 9000 } })).toEqual([
      { range: { roomsHalf: { gte: 4 } } },
      { range: { areaMinor: { lte: 9000 } } },
    ]);
  });

  it('city, postal code → term; listing types, tour hosts → terms', () => {
    expect(
      buildOpenSearchFilter({
        cityNorm: 'köln',
        postalCode: '50667',
        listingTypes: ['house', 'villa'],
        tourHosts: ['tour.example'],
      }),
    ).toEqual([
      { term: { cityNorm: 'köln' } },
      { term: { postalCode: '50667' } },
      { terms: { listingType: ['house', 'villa'] } },
      { terms: { tourHosts: ['tour.example'] } },
    ]);
  });
});

describe('buildOpenSearchSearchBody', () => {
  it('requests pageSize + 1, id ASC, no total hits, only the listing source', () => {
    expect(buildOpenSearchSearchBody({ pageSize: 5 })).toEqual({
      size: 6,
      query: { bool: { filter: [] } },
      sort: [{ id: 'asc' }],
      track_total_hits: false,
      _source: ['listing'],
    });
    expect(buildOpenSearchSearchBody({})?.size).toBe(DEFAULT_PAGE_SIZE + 1);
  });

  it('continues after the cursor id', () => {
    expect(buildOpenSearchSearchBody({ after: 'id-007' })?.search_after).toEqual(['id-007']);
  });

  it('returns null for empty type or host sets', () => {
    expect(buildOpenSearchSearchBody({ listingTypes: [] })).toBeNull();
    expect(buildOpenSearchSearchBody({ tourHosts: [] })).toBeNull();
  });
});

describe('OpenSearchSearchProvider.search', () => {
  it('sends the built body to the configured index with deadline options', async () => {
    const { provider, search } = setup(() => []);
    const q: ResolvedQuery = { cityNorm: 'berlin', pageSize: 3 };
    await expect(provider.search(q)).resolves.toEqual({ items: [] });
    expect(search).toHaveBeenCalledWith(
      { index: INDEX, body: buildOpenSearchSearchBody(q) },
      { requestTimeout: OPENSEARCH_REQUEST_DEADLINE_MS, maxRetries: 0 },
    );
  });

  it('pages through all matches in id order via search_after without gaps or duplicates', async () => {
    const all = listings(7);
    const { provider, search } = setup(pageOf(all));
    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await provider.search({ pageSize: 3, ...(after ? { after } : {}) });
      seen.push(...page.items.map((l) => l.id));
      if (page.next === undefined) break;
      expect(page.items).toHaveLength(3);
      expect(page.next.lastId).toBe(page.items[2]?.id);
      after = page.next.lastId;
    }
    expect(seen).toEqual(all.map((l) => l.id).sort());
    expect(search).toHaveBeenCalledTimes(3);
  });

  it('reports no next page when exactly pageSize matches exist', async () => {
    const { provider } = setup(pageOf(listings(3)));
    const result = await provider.search({ pageSize: 3 });
    expect(result.items).toHaveLength(3);
    expect(result.next).toBeUndefined();
  });

  it('answers empty sets without a request', async () => {
    const { provider, search } = setup(() => [listing('a')]);
    await expect(provider.search({ tourHosts: [] })).resolves.toEqual({ items: [] });
    await expect(provider.search({ listingTypes: [] })).resolves.toEqual({ items: [] });
    expect(search).not.toHaveBeenCalled();
  });

  it('maps client errors and malformed responses to ServiceUnavailableError', async () => {
    const failing = setup(() => Promise.reject(new Error('connection refused')));
    await expect(failing.provider.search({})).rejects.toBeInstanceOf(ServiceUnavailableError);

    const malformed = new OpenSearchSearchProvider({
      client: { search: async () => ({ body: { hits: { hits: [{ _source: {} }] } } }) },
      index: INDEX,
    });
    await expect(malformed.search({})).rejects.toThrow('OpenSearch request failed');
    await expect(malformed.getById('a')).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('aborts the request when the deadline expires', async () => {
    const controller = new AbortController();
    const abort = jest.fn();
    const pending = Object.assign(new Promise<{ body: unknown }>(() => undefined), { abort });
    const provider = new OpenSearchSearchProvider({
      client: { search: () => pending },
      index: INDEX,
      deadlineMs: 10,
      deadlineSignal: () => controller.signal,
    });
    const result = provider.search({});
    controller.abort(new Error('timeout'));
    await expect(result).rejects.toThrow('OpenSearch deadline of 10 ms exceeded');
    expect(abort).toHaveBeenCalled();
  });
});

describe('OpenSearchSearchProvider.getById', () => {
  it('looks up the id by term and returns the listing or null', async () => {
    const l = listing('a');
    const { provider, search } = setup((body) =>
      JSON.stringify(body).includes('"id":"a"') ? [l] : [],
    );
    await expect(provider.getById('a')).resolves.toEqual(l);
    await expect(provider.getById('b')).resolves.toBeNull();
    expect(search.mock.calls[0]?.[0].body).toEqual({
      size: 1,
      query: { bool: { filter: [{ term: { id: 'a' } }] } },
      track_total_hits: false,
      _source: ['listing'],
    });
  });
});

describe('createSearchProvider / parseSearchProviderKind', () => {
  const dynamodb = () => ({ client: { send: jest.fn() }, tableName: 't' });
  const opensearch = () => ({ client: { search: jest.fn() }, index: INDEX });

  it('creates only the selected provider', () => {
    const os = jest.fn(opensearch);
    expect(createSearchProvider('dynamodb', { dynamodb, opensearch: os })).toBeInstanceOf(
      DynamoDbSearchProvider,
    );
    expect(os).not.toHaveBeenCalled();
    expect(createSearchProvider('opensearch', { opensearch })).toBeInstanceOf(
      OpenSearchSearchProvider,
    );
  });

  it('fails with CONFIG_MISSING when the selected backend has no options', () => {
    expect(() => createSearchProvider('opensearch', { dynamodb })).toThrow(ConfigError);
  });

  it('parses the SSM value', () => {
    expect(parseSearchProviderKind('opensearch')).toBe('opensearch');
    expect(parseSearchProviderKind(' dynamodb ')).toBe('dynamodb');
    expect(() => parseSearchProviderKind(undefined)).toThrow(
      expect.objectContaining({ code: 'CONFIG_MISSING', names: ['search-provider'] }),
    );
    expect(() => parseSearchProviderKind('elastic')).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });
});

// In-memory evaluator for exactly the clause kinds the builder emits (OpenSearch semantics:
// a missing field matches no term/terms/range clause; multi-valued fields match if any value does).
function values(doc: SearchDocument, field: string): unknown[] {
  const v = (doc as unknown as Record<string, unknown>)[field];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function evaluate(clause: OpenSearchFilterClause, doc: SearchDocument): boolean {
  if ('exists' in clause) return values(doc, clause.exists.field).length > 0;
  if ('term' in clause) {
    const [[field, value]] = Object.entries(clause.term) as [[string, string]];
    return values(doc, field).includes(value);
  }
  if ('terms' in clause) {
    const [[field, set]] = Object.entries(clause.terms) as [[string, string[]]];
    return values(doc, field).some((v) => set.includes(v as string));
  }
  const [[field, { gte, lte }]] = Object.entries(clause.range) as [
    [string, { gte?: number; lte?: number }],
  ];
  return values(doc, field).some(
    (v) =>
      (gte === undefined || (v as number) >= gte) && (lte === undefined || (v as number) <= lte),
  );
}

describe('builder ≡ matchesQuery (in-memory evaluation of bool.filter)', () => {
  const small = fc.integer({ min: 0, max: 6 });
  const arbRange = fc.record({ min: small, max: small }, { requiredKeys: [] });
  const arbCurrency = fc.constantFrom('EUR', 'USD');
  const arbCode = fc.constantFrom('house', 'flat', 'villa');
  const arbHost = fc.constantFrom('a.example', 'b.example', 'c.example');

  const arbDoc: fc.Arbitrary<SearchDocument> = fc.record(
    {
      id: fc.string(),
      cityNorm: fc.constantFrom('berlin', 'köln'),
      postalCode: fc.constantFrom('10115', '50667'),
      country: fc.constant('DE'),
      listingType: arbCode,
      saleAmountMinor: small,
      saleCurrency: arbCurrency,
      rentAmountMinor: small,
      rentCurrency: arbCurrency,
      roomsHalf: small,
      areaMinor: small,
      tourHosts: fc.uniqueArray(arbHost, { maxLength: 2 }),
    },
    {
      requiredKeys: [
        'id',
        'cityNorm',
        'postalCode',
        'country',
        'listingType',
        'roomsHalf',
        'areaMinor',
        'tourHosts',
      ],
    },
  );

  const arbOffer = fc.oneof(
    fc.constant({}),
    fc.record(
      {
        offerType: fc.constantFrom('SALE' as const, 'RENT' as const),
        price: fc.record(
          { currency: arbCurrency, min: small, max: small },
          { requiredKeys: ['currency'] },
        ),
      },
      { requiredKeys: ['offerType'] },
    ),
  );

  const arbQuery: fc.Arbitrary<ResolvedQuery> = fc
    .tuple(
      arbOffer,
      fc.record(
        {
          roomsHalf: arbRange,
          areaMinor: arbRange,
          cityNorm: fc.constantFrom('berlin', 'köln'),
          postalCode: fc.constantFrom('10115', '50667'),
          listingTypes: fc.uniqueArray(arbCode, { maxLength: 3 }),
          tourHosts: fc.uniqueArray(arbHost, { maxLength: 3 }),
        },
        { requiredKeys: [] },
      ),
    )
    .map(([offer, rest]) => ({ ...offer, ...rest }) as ResolvedQuery);

  it('every document matches the generated bool.filter iff it satisfies matchesQuery', () => {
    fc.assert(
      fc.property(arbQuery, fc.array(arbDoc, { maxLength: 10 }), (q, docs) => {
        const body = buildOpenSearchSearchBody(q);
        for (const doc of docs) {
          const viaFilter = body !== null && body.query.bool.filter.every((c) => evaluate(c, doc));
          expect(viaFilter).toBe(matchesQuery(doc, q));
        }
      }),
      { numRuns: 300 },
    );
  });
});
