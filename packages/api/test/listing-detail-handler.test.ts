import {
  createAccessGuard,
  createListingService,
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
} from '@open-estate/shared';
import { createListingDetailHandler, logger, type ListingsRequest } from '@open-estate/api';
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

const BOTH_OFFERS = exampleListing('home-1', {
  description: 'Helle Wohnung',
  translations: [
    { locale: 'en', title: 'Bright flat', description: 'A bright flat' },
    { locale: 'fr-FR', title: 'Appartement', description: 'Un appartement' },
  ],
  offers: [
    { offerType: 'SALE', price: 450_000_00, currency: 'EUR' },
    { offerType: 'RENT', coldRent: 1_250_50, currency: 'EUR' },
  ],
});

function setup(stored: readonly Listing[] = [BOTH_OFFERS], access: AccessConfig = OPEN) {
  const provider = new InMemorySearchProvider(stored);
  const guard = createAccessGuard({
    config: new StaticAccessConfigSource(access),
    apiKeys: new InMemoryApiKeyStore([KEY_RECORD]),
    counters: new InMemoryRateLimitCounterStore(),
    clock: () => NOW,
  });
  const listings = createListingService({ provider, taxonomy });
  const handler = createListingDetailHandler({ guard, schemas, listings });

  async function call(id: string | undefined, req: Partial<ListingsRequest> = {}) {
    const res = await handler({
      resource: '/listings/{id}',
      pathParameters: id === undefined ? null : { id },
      requestContext: { identity: { sourceIp: '192.0.2.1' } },
      ...req,
    });
    return { ...res, json: JSON.parse(res.body) as Record<string, unknown> };
  }
  return { provider, call };
}

afterEach(() => jest.restoreAllMocks());

const codes = (body: Record<string, unknown>) =>
  (body as unknown as ErrorResponse).errors.map((e) => [e.code, e.field]);

describe('GET /listings/{id}: success', () => {
  it('returns the full record with both offers in API representation (Req 2.1)', async () => {
    const { call } = setup();

    const res = await call('home-1');

    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({ 'Content-Type': 'application/json; charset=utf-8' });
    expect(res.json).toMatchObject({
      id: 'home-1',
      title: 'Listing home-1',
      description: 'Helle Wohnung',
      deliveredLocale: 'de',
      originalLocale: 'de',
      listingType: 'apartment_unit',
      group: 'apartment',
      area: '75.00',
      address: { city: 'Berlin', postalCode: '10115', country: 'DE' },
      offers: [
        { offerType: 'SALE', price: '450000.00', currency: 'EUR' },
        { offerType: 'RENT', coldRent: '1250.50', currency: 'EUR' },
      ],
    });
    expect(res.json).not.toHaveProperty('translations');
  });

  it('decodes a percent-encoded path id', async () => {
    const { call } = setup([exampleListing('a b/c')]);
    const res = await call('a%20b%2Fc');
    expect(res.statusCode).toBe(200);
    expect(res.json.id).toBe('a b/c');
  });
});

describe('GET /listings/{id}: language selection (Req 14.3, 14.7, 14.8)', () => {
  it.each([
    ['lang exact match', { queryStringParameters: { lang: 'EN' } }, 'en', 'Bright flat'],
    ['lang primary subtag', { queryStringParameters: { lang: 'fr-CA' } }, 'fr-FR', 'Appartement'],
    [
      'Accept-Language by q',
      { headers: { 'Accept-Language': 'es, en;q=0.5' } },
      'en',
      'Bright flat',
    ],
    [
      'lang overrides Accept-Language',
      { queryStringParameters: { lang: 'de' }, headers: { 'accept-language': 'en' } },
      'de',
      'Listing home-1',
    ],
    ['no match → original', { headers: { 'Accept-Language': 'it' } }, 'de', 'Listing home-1'],
  ])('%s', async (_name, req, deliveredLocale, title) => {
    const { call } = setup();
    const res = await call('home-1', req);
    expect(res.statusCode).toBe(200);
    expect(res.json).toMatchObject({ deliveredLocale, originalLocale: 'de', title });
  });

  it('rejects an invalid lang with 400 INVALID_LOCALE (Req 14.9)', async () => {
    const { call } = setup();
    const res = await call('home-1', { queryStringParameters: { lang: 'not a locale' } });
    expect(res.statusCode).toBe(400);
    expect(codes(res.json)).toEqual([['INVALID_LOCALE', 'lang']]);
  });
});

describe('GET /listings/{id}: errors', () => {
  it('answers 404 NOT_FOUND naming the id without a record (Req 2.2)', async () => {
    const { call } = setup();

    const res = await call('missing-1');

    expect(res.statusCode).toBe(404);
    expect(res.json).toEqual({
      errors: [{ code: 'NOT_FOUND', message: expect.any(String), details: { id: 'missing-1' } }],
    });
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too long', 'x'.repeat(129)],
    ['malformed percent-encoding', '%E0%A4%A'],
  ])('rejects a %s id with 400 INVALID_ID without lookup (Req 2.3)', async (_name, id) => {
    const { provider, call } = setup();
    const getById = jest.spyOn(provider, 'getById');

    const res = await call(id);

    expect(res.statusCode).toBe(400);
    expect(codes(res.json)).toEqual([['INVALID_ID', 'id']]);
    expect(getById).not.toHaveBeenCalled();
  });

  it('reports an invalid id and an invalid lang together', async () => {
    const { call } = setup();
    const res = await call('', { queryStringParameters: { lang: '' } });
    expect(res.statusCode).toBe(400);
    expect(codes(res.json)).toEqual(
      expect.arrayContaining([
        ['INVALID_ID', 'id'],
        ['INVALID_LOCALE', 'lang'],
      ]),
    );
  });

  it.each([
    ['ServiceUnavailableError', new ServiceUnavailableError('deadline arn:aws:secret')],
    ['any other exception', new TypeError('secret arn:aws:dynamodb')],
  ])('maps %s of the provider to 503 without details (Req 9.5)', async (_n, failure) => {
    const { provider, call } = setup();
    jest.spyOn(provider, 'getById').mockRejectedValue(failure);
    const log = jest.spyOn(logger, 'error');

    const res = await call('home-1');

    expect(res.statusCode).toBe(503);
    expect(res.json).toEqual({
      errors: [{ code: 'SERVICE_UNAVAILABLE', message: expect.any(String) }],
    });
    expect(res.body).not.toContain('secret');
    expect(log).toHaveBeenCalledWith('GET /listings/{id}: request failed', {
      errorName: failure.name,
    });
  });
});

describe('GET /listings/{id}: access (401/429)', () => {
  it('rejects a missing API key with 401 before validating or looking up', async () => {
    const { provider, call } = setup([BOTH_OFFERS], {
      mode: 'api-keys',
      rateLimit: OPEN.rateLimit,
    });
    const getById = jest.spyOn(provider, 'getById');

    const res = await call('');

    expect(res.statusCode).toBe(401);
    expect(codes(res.json)).toEqual([['API_KEY_MISSING', undefined]]);
    expect(getById).not.toHaveBeenCalled();
  });

  it('admits a valid key', async () => {
    const { call } = setup([BOTH_OFFERS], { mode: 'api-keys', rateLimit: OPEN.rateLimit });
    const res = await call('home-1', { headers: { Authorization: `Bearer ${API_KEY}` } });
    expect(res.statusCode).toBe(200);
  });

  it('answers 429 with Retry-After (Req 17.2)', async () => {
    const { call } = setup([BOTH_OFFERS], {
      mode: 'open',
      rateLimit: { requests: 1, windowSeconds: 60 },
    });

    expect((await call('home-1')).statusCode).toBe(200);
    const res = await call('home-1');

    expect(res.statusCode).toBe(429);
    expect(res.headers).toMatchObject({ 'Retry-After': '45' });
    expect(res.json).toMatchObject({ errors: [{ code: 'RATE_LIMITED' }], retryAfterSeconds: 45 });
  });
});
