import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import openApi31Schema from '@seriousme/openapi-schema-validator/schemas/v3.1/schema.json';
import {
  createAccessGuard,
  hashApiKey,
  InMemoryApiKeyStore,
  InMemoryRateLimitCounterStore,
  StaticAccessConfigSource,
  type AccessConfig,
  type AccessGuard,
} from '@open-estate/core';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  ERROR_CODES,
  requestSchemaOverride,
  serialize,
  type LocaleConfig,
} from '@open-estate/shared';
import {
  buildMetaDocument,
  buildOpenApiDocument,
  createDiscoveryHandlers,
  DISCOVERY_CACHE_CONTROL,
  type DiscoveryInput,
  type ListingsRequest,
} from '@open-estate/api';
import { z } from 'zod';
import { exampleListing } from '../../shared/test/arbitraries';

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const locales: LocaleConfig = {
  defaultLocale: 'de',
  enabled: [
    { locale: 'de', label: 'Deutsch' },
    { locale: 'en', label: 'English' },
  ],
};
const INPUT: DiscoveryInput = {
  schemas: buildSchemas(taxonomy, locales),
  taxonomy,
  locales,
  defaultCurrency: 'EUR',
  tourProviders: {
    providers: [{ code: 'matterport', hostnames: ['My.Matterport.com', 'matterport.com'] }],
  },
};

const doc = buildOpenApiDocument(INPUT);
const json = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;

interface Param {
  name: string;
  in: string;
  required?: boolean;
  schema: Record<string, unknown>;
}

function params(path: string): Param[] {
  return (doc.paths?.[path]?.get?.parameters ?? []) as Param[];
}

/** Ajv over the document's components, to validate example payloads against them. */
function componentValidator(name: string) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ $id: 'doc', components: json['components'] });
  return ajv.compile({ $ref: `doc#/components/schemas/${name}` });
}

describe('GET /openapi.json document', () => {
  it('is a valid OpenAPI 3.1 document whose $refs all resolve (Req 3.1)', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addFormat('media-range', true); // content-type keys; not checked by ajv-formats
    const validate = ajv.compile(openApi31Schema);
    expect(validate.errors ?? []).toEqual([]);
    expect(validate(json)).toBe(true);

    const refs = [...JSON.stringify(json).matchAll(/"\$ref":"#\/([^"]+)"/g)].map((m) => m[1] ?? '');
    for (const ref of new Set(refs)) {
      const target = ref
        .split('/')
        .reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], json);
      expect([ref, target]).toEqual([ref, expect.any(Object)]);
    }
  });

  it('documents all public endpoints and no admin routes', () => {
    const operations = Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(operations.sort()).toEqual([
      'GET /listings',
      'GET /listings/{id}',
      'GET /locations',
      'GET /meta',
      'GET /openapi.json',
      'POST /mcp',
    ]);
  });

  it('describes the search parameters exactly like the MCP tool input schema (Req 3.2, 19.2)', () => {
    const mcp = z.toJSONSchema(INPUT.schemas.searchQuery, {
      io: 'input',
      override: requestSchemaOverride,
    }) as { properties: Record<string, unknown>; required?: string[] };
    const query = params('/listings').filter((p) => p.in === 'query');

    expect(query.map((p) => p.name)).toEqual(Object.keys(mcp.properties));
    for (const p of query) expect([p.name, p.schema]).toEqual([p.name, mcp.properties[p.name]]);
    expect(query.filter((p) => p.required).map((p) => p.name)).toEqual(mcp.required ?? []);
  });

  it('includes bounds, defaults and the configured enums (Req 3.2, 3.7)', () => {
    const byName = Object.fromEntries(params('/listings').map((p) => [p.name, p]));
    expect(byName['types']?.schema).toMatchObject({
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: { enum: INPUT.schemas.enums.types },
    });
    expect(byName['group']?.schema).toMatchObject({
      maxItems: 1,
      items: { enum: INPUT.schemas.enums.groups },
    });
    expect(byName['offerType']?.schema).toEqual({ type: 'string', enum: ['SALE', 'RENT'] });
    expect(byName['pageSize']?.schema).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 50,
      default: 20,
    });
    expect(byName['priceMin']?.schema).toMatchObject({
      type: 'string',
      'x-minimum': '0.01',
      'x-maximum': '999999999.99',
    });
    expect(byName['lang']).toMatchObject({ 'x-enabled-locales': ['de', 'en'] });

    const schemas = doc.components?.schemas ?? {};
    expect(schemas['PropertyGroup']).toMatchObject({ enum: INPUT.schemas.enums.groups });
    expect(schemas['ListingType']).toMatchObject({ enum: INPUT.schemas.enums.types });
    expect(schemas['OfferType']).toMatchObject({ enum: ['SALE', 'RENT'] });
    expect(schemas['EnabledLocale']).toMatchObject({ enum: ['de', 'en'], default: 'de' });
    expect(schemas['ErrorCode']).toMatchObject({ enum: [...ERROR_CODES] });
    expect(Object.keys(schemas).filter((name) => name.endsWith('Output'))).toEqual([]);
  });

  it('documents GET /listings/{id} with a required path id', () => {
    expect(params('/listings/{id}').map((p) => [p.in, p.name, p.required ?? false])).toEqual([
      ['path', 'id', true],
      ['query', 'lang', false],
      ['header', 'Accept-Language', false],
    ]);
  });

  it('describes the listing as sent: amounts and area as decimal strings (Req 3.3)', () => {
    const validate = componentValidator('SearchPage');
    const sent = serialize(
      exampleListing('id-1', {
        offers: [
          { offerType: 'SALE', price: 450_000_00, currency: 'EUR' },
          { offerType: 'RENT', coldRent: 1_250_50, currency: 'EUR', warmRent: 1_500_00 },
        ],
      }),
      { taxonomy, version: { title: 'Titel', description: '', deliveredLocale: 'de' } },
    );

    expect(validate(JSON.parse(JSON.stringify({ items: [sent], nextPageToken: 't' })))).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    // Minor units (the internal representation) are rejected.
    expect(validate({ items: [{ ...sent, area: 75_00 }] })).toBe(false);
  });

  it('documents error responses; 429 with Retry-After (Req 3.4, 17.2)', () => {
    const search = doc.paths?.['/listings']?.get?.responses ?? {};
    expect(Object.keys(search).sort()).toEqual(['200', '400', '401', '429', '503']);
    expect(Object.keys(doc.paths?.['/listings/{id}']?.get?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '401',
      '404',
      '429',
      '503',
    ]);
    expect(doc.components?.responses?.['RateLimited']).toMatchObject({
      headers: { 'Retry-After': { required: true, schema: { type: 'integer', minimum: 1 } } },
    });

    const validate = componentValidator('ErrorResponse');
    const body = {
      errors: [{ code: 'RATE_LIMITED', message: 'slow down', details: { retryAfterSeconds: 3 } }],
      retryAfterSeconds: 3,
    };
    expect(validate(body)).toBe(true);
    expect(validate({ errors: [{ code: 'NOPE', message: 'x' }] })).toBe(false);
  });
});

describe('GET /meta document', () => {
  const meta = buildMetaDocument(INPUT);

  it('lists every group with its type codes, locales, currency and tour hosts (Req 15.9, 16.6)', () => {
    expect(meta.taxonomy).toEqual({
      groups: taxonomy.groups.map((g) => ({ code: g.code, types: [...g.types] })),
    });
    expect(meta.locales).toEqual(locales);
    expect(meta.defaultCurrency).toBe('EUR');
    expect(meta.offerTypes).toEqual(['SALE', 'RENT']);
    expect(meta.tourProviders).toEqual(['my.matterport.com', 'matterport.com']);
    expect(meta.bounds.listing.money).toEqual({ min: '0.01', max: '999999999.99' });
    expect(meta.bounds.search.pageSize).toEqual({ min: 1, max: 50, default: 20 });
  });

  it('matches the documented Meta schema', () => {
    const validate = componentValidator('Meta');
    expect(validate(JSON.parse(JSON.stringify(meta)))).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });
});

describe('discovery handlers', () => {
  const OPEN: AccessConfig = { mode: 'open', rateLimit: { requests: 1, windowSeconds: 60 } };
  const REQUEST: ListingsRequest = { requestContext: { identity: { sourceIp: '192.0.2.1' } } };

  function guard(access: AccessConfig = OPEN): AccessGuard {
    return createAccessGuard({
      config: new StaticAccessConfigSource(access),
      apiKeys: new InMemoryApiKeyStore([
        { keyId: 'k1', keyHash: hashApiKey('key'), status: 'active' },
      ]),
      counters: new InMemoryRateLimitCounterStore(),
      clock: () => 60_000 * 29_000_000,
    });
  }

  afterEach(() => jest.restoreAllMocks());

  it('serves the precomputed documents with cache headers', async () => {
    const handlers = createDiscoveryHandlers(
      guard({ ...OPEN, rateLimit: { requests: 10, windowSeconds: 60 } }),
      INPUT,
    );

    const openapi = await handlers.openapi(REQUEST);
    const meta = await handlers.meta(REQUEST);

    expect(openapi.statusCode).toBe(200);
    expect(openapi.headers).toMatchObject({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': DISCOVERY_CACHE_CONTROL,
    });
    expect(JSON.parse(openapi.body)).toEqual(json);
    expect(meta.statusCode).toBe(200);
    expect(JSON.parse(meta.body)).toEqual(JSON.parse(JSON.stringify(buildMetaDocument(INPUT))));
  });

  it('goes through the AccessGuard: rate limit and API key (Req 17.1, 17.5)', async () => {
    const limited = createDiscoveryHandlers(guard(), INPUT);
    expect((await limited.meta(REQUEST)).statusCode).toBe(200);
    const rejected = await limited.openapi(REQUEST);
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers).toMatchObject({ 'Retry-After': '60', 'Cache-Control': 'no-store' });

    const keyed = createDiscoveryHandlers(guard({ ...OPEN, mode: 'api-keys' }), INPUT);
    const missing = await keyed.openapi(REQUEST);
    expect(missing.statusCode).toBe(401);
    expect(JSON.parse(missing.body)).toMatchObject({ errors: [{ code: 'API_KEY_MISSING' }] });
    const ok = await keyed.meta({ ...REQUEST, headers: { Authorization: 'Bearer key' } });
    expect(ok.statusCode).toBe(200);
  });

  it('answers 503 when the guard fails', async () => {
    const failing: AccessGuard = { admit: () => Promise.reject(new Error('store down')) };
    const res = await createDiscoveryHandlers(failing, INPUT).meta(REQUEST);
    expect(res.statusCode).toBe(503);
  });
});
