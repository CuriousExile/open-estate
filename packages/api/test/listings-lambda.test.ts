import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Metrics } from '@open-estate/core';
import { DEFAULT_TAXONOMY_CONFIG } from '@open-estate/shared';
import {
  createListingsHandlerFromEnv,
  listingsEndpoint,
  logger,
  type ListingsRequest,
} from '@open-estate/api';
import { captureEmf } from '../../core/test/observability/emf-capture';

const REGION = 'eu-central-1';

const ENV = {
  CONFIG_BUCKET: 'config-bucket',
  DEFAULT_CURRENCY_SSM_PARAMETER: '/oe/test/default-currency',
  SEARCH_PROVIDER_SSM_PARAMETER: '/oe/test/search-provider',
  ACCESS_MODE_SSM_PARAMETER: '/oe/test/access-mode',
  RATE_LIMIT_SSM_PARAMETER: '/oe/test/rate-limit',
  LISTINGS_TABLE_NAME: 'listings',
  API_KEYS_TABLE_NAME: 'api-keys',
  RATE_LIMIT_COUNTERS_TABLE_NAME: 'rate-limit-counters',
  AGENCIES_TABLE_NAME: 'agencies',
};

const SSM_VALUES: Record<string, string> = {
  '/oe/test/default-currency': 'EUR',
  '/oe/test/search-provider': 'dynamodb',
  '/oe/test/access-mode': 'open',
  '/oe/test/rate-limit': '{"requests":60,"windowSeconds":60}',
};

const FILES: Record<string, string> = {
  'taxonomy.json': JSON.stringify(DEFAULT_TAXONOMY_CONFIG),
  'i18n-config.json': JSON.stringify({
    defaultLocale: 'de',
    enabled: [{ locale: 'de', label: 'Deutsch' }],
  }),
  'tour-providers.json': JSON.stringify({
    providers: [{ code: 'matterport', hostnames: ['my.matterport.com'] }],
  }),
};

const REQUEST: ListingsRequest = {
  resource: '/listings',
  requestContext: { identity: { sourceIp: '192.0.2.1' } },
};

const awsError = (name: string) => Object.assign(new Error(name), { name });

/** Real SDK clients with stubbed `send`; no AWS calls are made. */
function setup(
  env: Record<string, string | undefined> = ENV,
  files: Record<string, string | undefined> = FILES,
  ssmValues: Record<string, string | undefined> = SSM_VALUES,
  transientS3Failures = 0,
  metrics?: Metrics,
) {
  let failures = transientS3Failures;
  const ssm = new SSMClient({ region: REGION });
  const s3 = new S3Client({ region: REGION });
  jest.spyOn(ssm, 'send').mockImplementation(async (command: unknown) => {
    if (!(command instanceof GetParametersCommand)) throw new Error('unexpected command');
    const names = command.input.Names ?? [];
    return {
      Parameters: names
        .filter((n) => ssmValues[n] !== undefined)
        .map((n) => ({ Name: n, Value: ssmValues[n] })),
    };
  });
  const s3Send = jest.spyOn(s3, 'send').mockImplementation(async (command: unknown) => {
    if (!(command instanceof GetObjectCommand)) throw new Error('unexpected command');
    if (failures-- > 0) throw awsError('SlowDown');
    const body = files[command.input.Key ?? ''];
    if (body === undefined) throw awsError('NoSuchKey');
    return { Body: { transformToString: async () => body } };
  });
  // Counter update admits; listing queries return nothing.
  const dynamoSend = jest.fn(
    async (command: { constructor: { name: string }; input: { TableName?: string } }) =>
      command.constructor.name === 'QueryCommand' ? { Items: [] } : {},
  );
  const dynamo = { send: dynamoSend } as unknown as DynamoDBDocumentClient;
  const log = jest.spyOn(logger, 'error');
  const handler = createListingsHandlerFromEnv(env, { ssm, s3, dynamo }, metrics);
  return { handler, s3Send, dynamoSend, log };
}

afterEach(() => jest.restoreAllMocks());

describe('createListingsHandlerFromEnv', () => {
  it('loads the configuration once and serves requests', async () => {
    const { handler, s3Send, dynamoSend } = setup();

    const first = await handler(REQUEST);
    const second = await handler({ ...REQUEST, queryStringParameters: { hasTour: 'true' } });

    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ items: [] });
    expect(second.statusCode).toBe(200);
    expect(s3Send).toHaveBeenCalledTimes(3); // taxonomy, i18n, tour providers — once
    // Counter, suspended agencies (cached for 60 s, so only once), listings.
    expect(dynamoSend.mock.calls.map(([c]) => [c.constructor.name, c.input.TableName])).toEqual([
      ['UpdateCommand', 'rate-limit-counters'],
      ['QueryCommand', 'agencies'],
      ['QueryCommand', 'listings'],
      ['UpdateCommand', 'rate-limit-counters'],
      ['QueryCommand', 'listings'],
    ]);
  });

  it('routes GET /listings/{id} to the detail handler', async () => {
    const { handler, dynamoSend } = setup();

    const res = await handler({
      ...REQUEST,
      resource: '/listings/{id}',
      pathParameters: { id: 'missing-1' },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({
      errors: [{ code: 'NOT_FOUND', details: { id: 'missing-1' } }],
    });
    expect(dynamoSend.mock.calls.map(([c]) => c.constructor.name)).toEqual([
      'UpdateCommand',
      'GetCommand',
    ]);
  });

  it('serves /openapi.json and /meta from the loaded configuration', async () => {
    const { handler, s3Send } = setup();

    const openapi = await handler({ ...REQUEST, resource: '/openapi.json' });
    const meta = await handler({ ...REQUEST, resource: '/meta' });

    expect(openapi.statusCode).toBe(200);
    expect(JSON.parse(openapi.body)).toMatchObject({ openapi: '3.1.0' });
    expect(meta.statusCode).toBe(200);
    expect(JSON.parse(meta.body)).toMatchObject({
      locales: { defaultLocale: 'de' },
      defaultCurrency: 'EUR',
      tourProviders: ['my.matterport.com'],
    });
    expect(s3Send).toHaveBeenCalledTimes(3);
  });

  it('answers an unrouted resource with 404 without touching the stores', async () => {
    const { handler, dynamoSend } = setup();
    const res = await handler({ ...REQUEST, resource: '/unknown' });
    expect(res.statusCode).toBe(404);
    expect(dynamoSend).not.toHaveBeenCalled();
  });

  it('treats a missing tour-providers.json as empty allow-list', async () => {
    const { handler, dynamoSend } = setup(ENV, { ...FILES, 'tour-providers.json': undefined });

    const res = await handler({ ...REQUEST, queryStringParameters: { hasTour: 'true' } });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ items: [] });
    // No allowed host: hasTour matches nothing, the provider skips the listings query.
    expect(dynamoSend.mock.calls.map(([c]) => [c.constructor.name, c.input.TableName])).toEqual([
      ['UpdateCommand', 'rate-limit-counters'],
      ['QueryCommand', 'agencies'],
    ]);
  });

  it.each([
    [
      'missing environment variables',
      { ...ENV, API_KEYS_TABLE_NAME: undefined, LISTINGS_TABLE_NAME: ' ' },
      FILES,
      SSM_VALUES,
      { code: 'CONFIG_MISSING', names: ['API_KEYS_TABLE_NAME', 'LISTINGS_TABLE_NAME'] },
    ],
    [
      'a missing SSM value',
      ENV,
      FILES,
      { ...SSM_VALUES, '/oe/test/default-currency': undefined },
      { code: 'CONFIG_MISSING', names: ['DEFAULT_CURRENCY'] },
    ],
    [
      'an invalid default currency',
      ENV,
      FILES,
      { ...SSM_VALUES, '/oe/test/default-currency': 'euro' },
      { code: 'CONFIG_INVALID', names: ['DEFAULT_CURRENCY'] },
    ],
    [
      'an unknown search provider',
      ENV,
      FILES,
      { ...SSM_VALUES, '/oe/test/search-provider': 'solr' },
      { code: 'CONFIG_INVALID', names: ['search-provider'] },
    ],
    [
      'a missing i18n-config.json',
      ENV,
      { ...FILES, 'i18n-config.json': undefined },
      SSM_VALUES,
      { code: 'CONFIG_MISSING', names: ['i18n-config.json'] },
    ],
    [
      'an invalid tour-providers.json',
      ENV,
      { ...FILES, 'tour-providers.json': '{"providers":[{"code":"x","hostnames":[]}]}' },
      SSM_VALUES,
      { code: 'CONFIG_INVALID', names: ['tour-providers.json'] },
    ],
    [
      'an invalid taxonomy (Req 15.4)',
      ENV,
      {
        ...FILES,
        'taxonomy.json': '{"groups":[{"code":"house","types":["house"]}]}',
      },
      SSM_VALUES,
      {
        errorName: 'TaxonomyValidationError',
        violations: [expect.objectContaining({ violation: 'DUPLICATE_CODE', code: 'house' })],
      },
    ],
  ])(
    'answers every request with 503 and logs the cause on %s',
    async (_name, env, files, ssmValues, logged) => {
      const { handler, dynamoSend, log } = setup(env, files, ssmValues);

      for (let i = 0; i < 2; i++) {
        const res = await handler(REQUEST);
        expect(res.statusCode).toBe(503);
        expect(JSON.parse(res.body)).toEqual({
          errors: [{ code: 'SERVICE_UNAVAILABLE', message: expect.any(String) }],
        });
      }
      expect(dynamoSend).not.toHaveBeenCalled();
      // Configuration errors are final: logged once, not retried.
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('Search API: init failed', expect.objectContaining(logged));
    },
  );

  it('retries the init after a transient failure', async () => {
    const { handler, log } = setup(ENV, FILES, SSM_VALUES, 1);

    expect((await handler(REQUEST)).statusCode).toBe(503);
    expect((await handler(REQUEST)).statusCode).toBe(200);
    expect(log).toHaveBeenCalledWith('Search API: init failed', { errorName: 'SlowDown' });
  });
});

describe('RequestLatency (Req 11.4)', () => {
  it('is emitted per request with interface=api and the route as endpoint', async () => {
    const { metrics, points } = captureEmf();
    const { handler } = setup(ENV, FILES, SSM_VALUES, 0, metrics);

    const statuses = [
      await handler(REQUEST),
      await handler({ ...REQUEST, resource: '/listings/{id}', pathParameters: { id: 'gone-1' } }),
      await handler({ ...REQUEST, queryStringParameters: { priceMin: 'x' } }),
      await handler({ ...REQUEST, resource: '/openapi.json' }),
      await handler({ ...REQUEST, resource: '/meta' }),
    ].map((r) => r.statusCode);

    expect(statuses).toEqual([200, 404, 400, 200, 200]);
    expect(points()).toEqual(
      ['search', 'detail', 'search', 'openapi', 'meta'].map((endpoint) => ({
        namespace: 'OpenEstateTest',
        dimensionSets: [['interface', 'endpoint']],
        interface: 'api',
        endpoint,
        latencyMs: expect.any(Number),
        unit: 'Milliseconds',
      })),
    );
  });

  it('is emitted for 503 while the init failed', async () => {
    const { metrics, points } = captureEmf();
    const { handler } = setup(
      { ...ENV, LISTINGS_TABLE_NAME: undefined },
      FILES,
      SSM_VALUES,
      0,
      metrics,
    );

    expect((await handler(REQUEST)).statusCode).toBe(503);
    expect(points()).toEqual([expect.objectContaining({ interface: 'api', endpoint: 'search' })]);
  });

  it('maps unknown resources to a bounded endpoint value', () => {
    expect(listingsEndpoint({ resource: '/listings/{id}' })).toBe('detail');
    expect(listingsEndpoint({ resource: '/admin/secret' })).toBe('unknown');
    expect(listingsEndpoint({})).toBe('unknown');
  });
});

describe('CORS for the SPA origin', () => {
  const SPA = 'https://d111111abcdef8.cloudfront.net';
  const CORS_ENV = {
    ...ENV,
    FRONTEND_ORIGIN_SSM_PARAMETER: '/oe/test/frontend-origin',
    CORS_ALLOWED_ORIGINS: 'http://localhost:4200',
  };
  const CORS_SSM = { ...SSM_VALUES, '/oe/test/frontend-origin': SPA };
  const from = (origin: string) => ({ ...REQUEST, headers: { Origin: origin } });
  const ALLOWED = (origin: string) => ({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': 'Retry-After',
    Vary: 'Origin',
  });

  it('allows the frontend origin (SSM) and the context origins on every route', async () => {
    const { handler } = setup(CORS_ENV, FILES, CORS_SSM);
    const responses = [
      await handler(from(SPA)),
      await handler({ ...from(SPA), queryStringParameters: { priceMin: 'x' } }),
      await handler({ ...from(SPA), resource: '/listings/{id}', pathParameters: { id: 'x-1' } }),
      await handler({ ...from(SPA), resource: '/openapi.json' }),
      await handler({ ...from(SPA), resource: '/unknown' }),
      await handler(from('http://localhost:4200')),
    ];
    expect(responses.map((r) => r.statusCode)).toEqual([200, 400, 404, 200, 404, 200]);
    for (const res of responses.slice(0, -1)) expect(res.headers).toMatchObject(ALLOWED(SPA));
    expect(responses.at(-1)?.headers).toMatchObject(ALLOWED('http://localhost:4200'));
  });

  it('sends no ACAO, only Vary, to other origins', async () => {
    const { handler } = setup(CORS_ENV, FILES, CORS_SSM);
    const res = await handler(from('https://evil.example'));
    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({
      'Content-Type': 'application/json; charset=utf-8',
      Vary: 'Origin',
    });
  });

  it('keeps the 503 of a failed init readable by the SPA', async () => {
    const { handler } = setup(CORS_ENV, { ...FILES, 'taxonomy.json': undefined }, CORS_SSM);
    const res = await handler(from(SPA));
    expect(res.statusCode).toBe(503);
    expect(res.headers).toMatchObject({ ...ALLOWED(SPA), 'Cache-Control': 'no-store' });
  });

  it('exposes Retry-After of a 429 to the SPA', async () => {
    const { handler, dynamoSend } = setup(CORS_ENV, FILES, CORS_SSM);
    // The conditional counter update fails: limit reached.
    dynamoSend.mockImplementation(async () => {
      throw awsError('ConditionalCheckFailedException');
    });
    const res = await handler(from(SPA));
    expect(res.statusCode).toBe(429);
    expect(res.headers).toMatchObject({ ...ALLOWED(SPA), 'Retry-After': expect.any(String) });
  });

  it('answers a preflight of the SPA without AccessGuard or store access', async () => {
    const { handler, dynamoSend } = setup(CORS_ENV, FILES, CORS_SSM);
    const res = await handler({ ...from(SPA), httpMethod: 'OPTIONS' });
    expect(res.statusCode).toBe(204);
    expect(res.headers).toMatchObject({
      'Access-Control-Allow-Origin': SPA,
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Authorization, Accept-Language',
      Vary: 'Origin',
    });
    expect(dynamoSend).not.toHaveBeenCalled();
  });

  it('serves without ACAO while the frontend origin is not deployed yet', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const { handler } = setup({
      ...ENV,
      FRONTEND_ORIGIN_SSM_PARAMETER: '/oe/test/frontend-origin',
    });
    const res = await handler(from(SPA));
    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({
      'Content-Type': 'application/json; charset=utf-8',
      Vary: 'Origin',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no CORS origin configured'));
  });

  it('fails closed on an invalid allowlist and logs the variable once', async () => {
    const { handler, log } = setup({ ...CORS_ENV, CORS_ALLOWED_ORIGINS: '*' }, FILES, CORS_SSM);
    for (let i = 0; i < 2; i++) {
      const res = await handler(from(SPA));
      expect(res.statusCode).toBe(200);
      expect(res.headers).not.toHaveProperty('Access-Control-Allow-Origin');
    }
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'Search API: CORS init failed',
      expect.objectContaining({ code: 'CONFIG_INVALID', names: ['CORS_ALLOWED_ORIGINS'] }),
    );
  });
});
