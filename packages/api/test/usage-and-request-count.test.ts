// Task 10.5 (Req 13.4, 14.1): the production-wired Search_API handler writes one usage line per
// successful search page / detail call — ids only, no IP address, no API key — and emits
// `RequestCount` with `interface`, `endpoint` and `statusClass` (429 additionally as 4xx).
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { hashApiKey, toListingItem, UsageLine } from '@open-estate/core';
import { DEFAULT_TAXONOMY_CONFIG } from '@open-estate/shared';
import { createListingsHandlerFromEnv, type ListingsRequest } from '@open-estate/api';
import { exampleListing } from '../../shared/test/arbitraries';
import { captureEmf } from '../../core/test/observability/emf-capture';

const REGION = 'eu-central-1';
const SOURCE_IP = '198.51.100.77';
const API_KEY = 'oe_live_9f8e7d6c5b4a39281706f5e4d3c2b1a0';
const KEY_ID = 'key-usage-1';

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

const FILES: Record<string, string> = {
  'taxonomy.json': JSON.stringify(DEFAULT_TAXONOMY_CONFIG),
  'i18n-config.json': JSON.stringify({
    defaultLocale: 'de',
    enabled: [{ locale: 'de', label: 'Deutsch' }],
  }),
  'tour-providers.json': JSON.stringify({ providers: [] }),
};

const OWNED = exampleListing('owned-1');
const UNOWNED = exampleListing('unowned-1');
const AGENCY = 'agency-7';

const awsError = (name: string) => Object.assign(new Error(name), { name });

function setup(mode: 'open' | 'api-keys', { rateLimited = false } = {}) {
  const ssmValues: Record<string, string> = {
    '/oe/test/default-currency': 'EUR',
    '/oe/test/search-provider': 'dynamodb',
    '/oe/test/access-mode': mode,
    '/oe/test/rate-limit': '{"requests":60,"windowSeconds":60}',
  };
  const ssm = new SSMClient({ region: REGION });
  const s3 = new S3Client({ region: REGION });
  jest.spyOn(ssm, 'send').mockImplementation(async (command: unknown) => {
    if (!(command instanceof GetParametersCommand)) throw new Error('unexpected command');
    return {
      Parameters: (command.input.Names ?? []).map((n) => ({ Name: n, Value: ssmValues[n] })),
    };
  });
  jest.spyOn(s3, 'send').mockImplementation(async (command: unknown) => {
    if (!(command instanceof GetObjectCommand)) throw new Error('unexpected command');
    const body = FILES[command.input.Key ?? ''];
    if (body === undefined) throw awsError('NoSuchKey');
    return { Body: { transformToString: async () => body } };
  });
  const items = [
    toListingItem(OWNED, { status: 'ACTIVE', agencyId: AGENCY }),
    toListingItem(UNOWNED),
  ];
  const dynamo = {
    send: jest.fn(
      async (command: {
        constructor: { name: string };
        input: { TableName?: string; Key?: { id?: string } };
      }) => {
        const { name } = command.constructor;
        const table = command.input.TableName;
        if (name === 'UpdateCommand' && rateLimited) {
          throw awsError('ConditionalCheckFailedException');
        }
        if (name === 'QueryCommand' && table === 'api-keys') {
          return { Items: [{ keyId: KEY_ID, keyHash: hashApiKey(API_KEY), status: 'active' }] };
        }
        if (name === 'QueryCommand' && table === 'listings') return { Items: items };
        if (name === 'QueryCommand') return { Items: [] };
        if (name === 'GetCommand' && table === 'listings') {
          const item = items.find((i) => i.id === command.input.Key?.id);
          return item === undefined ? {} : { Item: item };
        }
        return {};
      },
    ),
  } as unknown as DynamoDBDocumentClient;
  const { metrics, countPoints, lines } = captureEmf();
  const handler = createListingsHandlerFromEnv(ENV, { ssm, s3, dynamo }, metrics);
  const usageLines = () => lines().filter((line) => line.includes('"usage"'));
  return { handler, countPoints, usageLines };
}

const request = (overrides: Partial<ListingsRequest> = {}): ListingsRequest => ({
  resource: '/listings',
  headers: { Authorization: `Bearer ${API_KEY}`, 'X-Forwarded-For': SOURCE_IP },
  requestContext: { identity: { sourceIp: SOURCE_IP } },
  ...overrides,
});

afterEach(() => jest.restoreAllMocks());

describe('usage line (Req 13.4)', () => {
  it('records impressions of a search page and a detail view with listing and agency ids', async () => {
    const { handler, usageLines } = setup('api-keys');

    expect((await handler(request())).statusCode).toBe(200);
    const detail = await handler(
      request({ resource: '/listings/{id}', pathParameters: { id: OWNED.id } }),
    );
    expect(detail.statusCode).toBe(200);

    const parsed = usageLines().map((line) => UsageLine.parse(JSON.parse(line)));
    expect(parsed).toEqual([
      {
        usage: {
          kind: 'impression',
          items: [{ id: OWNED.id, agencyId: AGENCY }, { id: UNOWNED.id }],
        },
      },
      { usage: { kind: 'detail', items: [{ id: OWNED.id, agencyId: AGENCY }] } },
    ]);
  });

  it('contains no IP address and no API key (nor its id or hash)', async () => {
    const { handler, usageLines } = setup('api-keys');

    await handler(request());
    await handler(request({ resource: '/listings/{id}', pathParameters: { id: UNOWNED.id } }));

    const written = usageLines();
    expect(written).toHaveLength(2);
    for (const line of written) {
      expect(line.endsWith('\n')).toBe(true);
      for (const secret of [SOURCE_IP, API_KEY, KEY_ID, hashApiKey(API_KEY)]) {
        expect(line).not.toContain(secret);
      }
      // Only `usage.kind` and `usage.items[].{id, agencyId}`.
      const json = JSON.parse(line) as { usage: { items: object[] } };
      expect(Object.keys(json)).toEqual(['usage']);
      expect(Object.keys(json.usage).sort()).toEqual(['items', 'kind']);
      for (const item of json.usage.items) {
        expect(Object.keys(item).every((k) => k === 'id' || k === 'agencyId')).toBe(true);
      }
    }
  });

  it('writes no line for failed or rejected requests', async () => {
    const open = setup('open');
    expect(
      (
        await open.handler(
          request({ resource: '/listings/{id}', pathParameters: { id: 'missing-1' } }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await open.handler(request({ queryStringParameters: { priceMin: 'x' } }))).statusCode,
    ).toBe(400);
    expect(open.usageLines()).toEqual([]);

    const limited = setup('open', { rateLimited: true });
    expect((await limited.handler(request())).statusCode).toBe(429);
    expect(limited.usageLines()).toEqual([]);
  });
});

describe('RequestCount (Req 14.1)', () => {
  it('is emitted per response with interface, endpoint and statusClass', async () => {
    const { handler, countPoints } = setup('open');

    await handler(request());
    await handler(request({ resource: '/listings/{id}', pathParameters: { id: 'missing-1' } }));

    expect(countPoints()).toEqual([
      {
        namespace: 'OpenEstateTest',
        dimensionSets: [['interface', 'endpoint', 'statusClass']],
        interface: 'api',
        endpoint: 'search',
        statusClass: '2xx',
        count: 1,
        unit: 'Count',
      },
      expect.objectContaining({ interface: 'api', endpoint: 'detail', statusClass: '4xx' }),
    ]);
  });

  it('counts 429 as 4xx and additionally as 429', async () => {
    const { handler, countPoints } = setup('open', { rateLimited: true });

    expect((await handler(request())).statusCode).toBe(429);

    expect(countPoints().map((p) => p.statusClass)).toEqual(['4xx', '429']);
  });
});
