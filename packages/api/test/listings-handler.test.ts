import {
  createAccessGuard,
  createSearchService,
  hashApiKey,
  InMemoryApiKeyStore,
  InMemoryRateLimitCounterStore,
  InMemorySearchProvider,
  ServiceUnavailableError,
  StaticAccessConfigSource,
  type AccessConfig,
  type ApiKeyRecord,
} from '@open-estate/core';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  type ErrorResponse,
  type Listing,
  type LocalizedListing,
} from '@open-estate/shared';
import { createListingsHandler, logger, type ListingsRequest } from '@open-estate/api';
import { exampleListing } from '../../shared/test/arbitraries';

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const schemas = buildSchemas(taxonomy, {
  defaultLocale: 'de',
  enabled: [
    { locale: 'de', label: 'Deutsch' },
    { locale: 'en', label: 'English' },
  ],
});

const API_KEY = 'test-api-key';
const KEY_RECORD: ApiKeyRecord = { keyId: 'k1', keyHash: hashApiKey(API_KEY), status: 'active' };
// 15 s into a 60-s window → Retry-After 45.
const NOW = 60_000 * 29_000_000 + 15_000;

const OPEN: AccessConfig = { mode: 'open', rateLimit: { requests: 1000, windowSeconds: 60 } };

function listings(count: number): Listing[] {
  return Array.from({ length: count }, (_, i) =>
    exampleListing(`id-${String(i).padStart(3, '0')}`),
  );
}

function setup(stored: readonly Listing[] = [], access: AccessConfig = OPEN) {
  const provider = new InMemorySearchProvider(stored);
  const counters = new InMemoryRateLimitCounterStore();
  const guard = createAccessGuard({
    config: new StaticAccessConfigSource(access),
    apiKeys: new InMemoryApiKeyStore([KEY_RECORD]),
    counters,
    clock: () => NOW,
  });
  const search = createSearchService({
    provider,
    taxonomy,
    tourProviders: { providers: [] },
    defaultCurrency: 'EUR',
  });
  const handler = createListingsHandler({ guard, schemas, search });

  async function call(req: Partial<ListingsRequest> = {}) {
    const res = await handler({ requestContext: { identity: { sourceIp: '192.0.2.1' } }, ...req });
    return { ...res, json: JSON.parse(res.body) as Record<string, unknown> };
  }
  return { provider, counters, call };
}

afterEach(() => jest.restoreAllMocks());

const ids = (body: Record<string, unknown>) => (body.items as LocalizedListing[]).map((l) => l.id);
const codes = (body: Record<string, unknown>) =>
  (body as unknown as ErrorResponse).errors.map((e) => [e.code, e.field]);

describe('GET /listings: success', () => {
  it('pages 20 by default in id order and follows nextPageToken (Req 1.1, 1.6, 1.7)', async () => {
    const { call } = setup(listings(30).reverse());

    const first = await call();
    expect(first.statusCode).toBe(200);
    expect(first.headers).toEqual({ 'Content-Type': 'application/json; charset=utf-8' });
    expect(ids(first.json)).toEqual(listings(20).map((l) => l.id));
    expect(first.json.nextPageToken).toEqual(expect.any(String));

    const second = await call({
      queryStringParameters: { pageToken: first.json.nextPageToken as string },
    });
    expect(second.statusCode).toBe(200);
    expect(ids(second.json)).toEqual(
      listings(30)
        .slice(20)
        .map((l) => l.id),
    );
    expect(second.json).not.toHaveProperty('nextPageToken');
  });

  it('honours pageSize', async () => {
    const { call } = setup(listings(10));
    const res = await call({ queryStringParameters: { pageSize: '3' } });
    expect(ids(res.json)).toEqual(['id-000', 'id-001', 'id-002']);
  });

  it('returns 200 with an empty list when nothing matches (Req 1.12)', async () => {
    const { call } = setup(listings(3));
    const res = await call({ queryStringParameters: { city: 'Hamburg' } });
    expect(res.statusCode).toBe(200);
    expect(res.json).toEqual({ items: [] });
  });

  it('serializes listings as API representation (Req 3.3)', async () => {
    const both = exampleListing('a', {
      offers: [
        { offerType: 'SALE', price: 450_000_00, currency: 'EUR' },
        { offerType: 'RENT', coldRent: 1_250_50, currency: 'EUR' },
      ],
    });
    const { call } = setup([both]);

    const [item] = (await call()).json.items as LocalizedListing[];
    expect(item).toMatchObject({
      id: 'a',
      group: 'apartment',
      deliveredLocale: 'de',
      originalLocale: 'de',
      area: '75.00',
      offers: [
        { offerType: 'SALE', price: '450000.00', currency: 'EUR' },
        { offerType: 'RENT', coldRent: '1250.50', currency: 'EUR' },
      ],
    });
    expect(item).not.toHaveProperty('translations');
  });

  it('filters by offer type (Req 12.6)', async () => {
    const rent = exampleListing('rent', {
      offers: [{ offerType: 'RENT', coldRent: 900_00, currency: 'EUR' }],
    });
    const { call } = setup([exampleListing('sale'), rent]);
    const res = await call({ queryStringParameters: { offerType: 'RENT' } });
    expect(ids(res.json)).toEqual(['rent']);
  });

  it('ORs repeated types from multiValueQueryStringParameters (Req 15.6)', async () => {
    const { call } = setup([
      exampleListing('a', { listingType: 'penthouse' }),
      exampleListing('b', { listingType: 'loft' }),
      exampleListing('c', { listingType: 'villa' }),
    ]);
    const res = await call({
      queryStringParameters: { types: 'loft' },
      multiValueQueryStringParameters: { types: ['penthouse', 'loft'] },
    });
    expect(res.statusCode).toBe(200);
    expect(ids(res.json)).toEqual(['a', 'b']);
  });
});

describe('GET /listings: language selection', () => {
  const bilingual = exampleListing('a', {
    title: 'Wohnung',
    translations: [{ locale: 'en', title: 'Flat', description: '' }],
  });

  it.each([
    ['Accept-Language picks the version (Req 14.3)', {}, { 'Accept-Language': 'en' }, 'en'],
    ['header name is case-insensitive', {}, { 'accept-language': 'fr;q=0.9, en' }, 'en'],
    ['q-values order the ranges (Req 14.6)', {}, { 'Accept-Language': 'en;q=0.2, de' }, 'de'],
    ['an unparsable header is no error (Req 14.6)', {}, { 'Accept-Language': ';;;=' }, 'de'],
    ['lang overrides the header (Req 14.8)', { lang: 'de' }, { 'Accept-Language': 'en' }, 'de'],
    ['lang falls back to the primary subtag (Req 14.4)', { lang: 'en-GB' }, {}, 'en'],
  ])('%s', async (_name, query, headers, delivered) => {
    const { call } = setup([bilingual]);
    const res = await call({ queryStringParameters: query, headers });
    expect(res.statusCode).toBe(200);
    expect((res.json.items as LocalizedListing[])[0]).toMatchObject({
      deliveredLocale: delivered,
      originalLocale: 'de',
      title: delivered === 'en' ? 'Flat' : 'Wohnung',
    });
  });
});

describe('GET /listings: validation errors (400)', () => {
  it.each([
    [{ pageSize: '0' }, 'INVALID_PAGE_SIZE', 'pageSize'],
    [{ pageSize: '51' }, 'INVALID_PAGE_SIZE', 'pageSize'],
    [{ roomsMin: 'many' }, 'INVALID_PARAMETER', 'roomsMin'],
    [{ city: 'x'.repeat(201) }, 'INVALID_PARAMETER', 'city'],
    [{ areaMin: '90', areaMax: '80' }, 'INVALID_RANGE', 'areaMin'],
    [{ offerType: 'LEASE' }, 'INVALID_OFFER_TYPE', 'offerType'],
    [{ priceMax: '100000' }, 'OFFER_TYPE_REQUIRED', 'offerType'],
    [{ group: 'house', types: 'villa' }, 'CONFLICTING_FILTERS', 'group,types'],
    [{ types: 'castle' }, 'UNKNOWN_TAXONOMY_CODE', 'types'],
    [{ types: '' }, 'INVALID_FILTER_COUNT', 'types'],
    [{ lang: '' }, 'INVALID_LOCALE', 'lang'],
    [{ lang: 'x'.repeat(36) }, 'INVALID_LOCALE', 'lang'],
    [{ pageToken: 'not-a-cursor' }, 'INVALID_PAGE_TOKEN', 'pageToken'],
  ])('%j → %s', async (query, code, field) => {
    const { provider, call } = setup(listings(3));
    const search = jest.spyOn(provider, 'search');

    const res = await call({ queryStringParameters: query });

    expect(res.statusCode).toBe(400);
    expect(res.headers).toEqual({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    expect(codes(res.json)).toContainEqual([code, field]);
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects more than one group (Req 15.10)', async () => {
    const { call } = setup();
    const res = await call({ multiValueQueryStringParameters: { group: ['house', 'land'] } });
    expect(res.statusCode).toBe(400);
    expect(codes(res.json)).toEqual([['INVALID_FILTER_COUNT', 'group']]);
  });

  it('reports all errors at once', async () => {
    const { call } = setup();
    const res = await call({
      queryStringParameters: {
        priceMin: '5',
        roomsMin: '4',
        roomsMax: '2',
        pageSize: '0',
        lang: '',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(codes(res.json)).toEqual(
      expect.arrayContaining([
        ['OFFER_TYPE_REQUIRED', 'offerType'],
        ['INVALID_RANGE', 'roomsMin'],
        ['INVALID_PAGE_SIZE', 'pageSize'],
        ['INVALID_LOCALE', 'lang'],
      ]),
    );
  });
});

describe('GET /listings: access (401/429)', () => {
  const KEYS: AccessConfig = { mode: 'api-keys', rateLimit: OPEN.rateLimit };

  it.each([
    ['missing', undefined, 'API_KEY_MISSING'],
    ['unknown', `Bearer wrong`, 'API_KEY_INVALID'],
    ['not a bearer token', API_KEY, 'API_KEY_INVALID'],
  ])('rejects a %s API key with 401 (Req 17.5)', async (_name, authorization, code) => {
    const { provider, call } = setup(listings(1), KEYS);
    const search = jest.spyOn(provider, 'search');

    const res = await call({ headers: authorization ? { Authorization: authorization } : {} });

    expect(res.statusCode).toBe(401);
    expect(res.headers).toMatchObject({ 'Cache-Control': 'no-store' });
    expect(codes(res.json)).toEqual([[code, undefined]]);
    expect(search).not.toHaveBeenCalled();
  });

  it('admits a valid key (header name case-insensitive) and counts it per key', async () => {
    const { counters, call } = setup(listings(1), KEYS);
    const res = await call({ headers: { authorization: `Bearer ${API_KEY}` } });
    expect(res.statusCode).toBe(200);
    expect(counters.count(`key:k1#${Math.floor(NOW / 60_000) * 60}`)).toBe(1);
  });

  it('answers 429 with Retry-After without searching (Req 17.2)', async () => {
    const { provider, call } = setup(listings(1), {
      mode: 'open',
      rateLimit: { requests: 1, windowSeconds: 60 },
    });
    const search = jest.spyOn(provider, 'search');

    expect((await call()).statusCode).toBe(200);
    const res = await call();

    expect(res.statusCode).toBe(429);
    expect(res.headers).toEqual({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '45',
    });
    expect(res.json).toMatchObject({
      errors: [{ code: 'RATE_LIMITED' }],
      retryAfterSeconds: 45,
    });
    expect(search).toHaveBeenCalledTimes(1);
  });
});

describe('GET /listings: downstream failures (503)', () => {
  it.each([
    ['ServiceUnavailableError', new ServiceUnavailableError('deadline arn:aws:secret')],
    ['any other exception', new TypeError('secret arn:aws:dynamodb')],
  ])('maps %s of the provider to 503 without details (Req 9.5, 9.6)', async (_n, failure) => {
    const { provider, call } = setup();
    jest.spyOn(provider, 'search').mockRejectedValue(failure);
    const log = jest.spyOn(logger, 'error');

    const res = await call();

    expect(res.statusCode).toBe(503);
    expect(res.headers).toMatchObject({ 'Cache-Control': 'no-store' });
    expect(res.json).toEqual({
      errors: [{ code: 'SERVICE_UNAVAILABLE', message: expect.any(String) }],
    });
    expect(res.body).not.toContain('secret');
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
    expect(log).toHaveBeenCalledWith(expect.any(String), { errorName: failure.name });
  });

  it('maps a failing rate-limit store to 503', async () => {
    const { counters, call } = setup();
    jest.spyOn(counters, 'tryIncrement').mockRejectedValue(new Error('throttled'));

    expect((await call()).statusCode).toBe(503);
  });
});
