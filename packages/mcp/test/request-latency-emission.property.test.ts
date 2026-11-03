// Task 19.3 (Req 11.4): every search and detail call via API and MCP emits exactly one
// `RequestLatency` data point with the dimensions `interface` and `endpoint` — for every outcome
// (200, 400, 404, 401, 429, 503). Both handlers are the production-wired `*FromEnv` factories with
// stubbed AWS clients; the EMF lines are captured from stdout.
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import fc from 'fast-check';
import { createListingsHandlerFromEnv, type ListingsRequest } from '@open-estate/api';
import type { Metrics } from '@open-estate/core';
import { createMcpHandlerFromEnv, type McpRequest } from '@open-estate/mcp';
import { DEFAULT_TAXONOMY_CONFIG } from '@open-estate/shared';
import { captureEmf } from '../../core/test/observability/emf-capture';

const ENV = {
  CONFIG_BUCKET: 'config-bucket',
  DEFAULT_CURRENCY_SSM_PARAMETER: '/oe/test/default-currency',
  SEARCH_PROVIDER_SSM_PARAMETER: '/oe/test/search-provider',
  ACCESS_MODE_SSM_PARAMETER: '/oe/test/access-mode',
  RATE_LIMIT_SSM_PARAMETER: '/oe/test/rate-limit',
  LISTINGS_TABLE_NAME: 'listings',
  API_KEYS_TABLE_NAME: 'api-keys',
  RATE_LIMIT_COUNTERS_TABLE_NAME: 'rate-limit-counters',
};

const FILES: Record<string, string> = {
  'taxonomy.json': JSON.stringify(DEFAULT_TAXONOMY_CONFIG),
  'i18n-config.json': JSON.stringify({
    defaultLocale: 'de',
    enabled: [{ locale: 'de', label: 'Deutsch' }],
  }),
  'tour-providers.json': JSON.stringify({ providers: [] }),
};

/** Environment state of the Lambda; selects the guard/init outcome. */
type Variant = 'open' | 'unauthorized' | 'rateLimited' | 'unavailable';

/** Expected HTTP status of a variant that ends before the request reaches the handler. */
const VARIANT_STATUS: Partial<Record<Variant, number>> = {
  unauthorized: 401,
  rateLimited: 429,
  unavailable: 503,
};

const awsError = (name: string) => Object.assign(new Error(name), { name });

function sources(variant: Variant) {
  const ssmValues: Record<string, string> = {
    '/oe/test/default-currency': 'EUR',
    '/oe/test/search-provider': 'dynamodb',
    '/oe/test/access-mode': variant === 'unauthorized' ? 'api-keys' : 'open',
    '/oe/test/rate-limit': '{"requests":60,"windowSeconds":60}',
  };
  const ssm = new SSMClient({ region: 'eu-central-1' });
  const s3 = new S3Client({ region: 'eu-central-1' });
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
  const dynamo = {
    send: jest.fn(async (command: { constructor: { name: string } }) => {
      const name = command.constructor.name;
      if (name === 'UpdateCommand' && variant === 'rateLimited') {
        throw awsError('ConditionalCheckFailedException');
      }
      return name === 'QueryCommand' ? { Items: [] } : {};
    }),
  } as unknown as DynamoDBDocumentClient;
  return { ssm, s3, dynamo };
}

const envOf = (variant: Variant) =>
  variant === 'unavailable' ? { ...ENV, LISTINGS_TABLE_NAME: undefined } : ENV;

/** Search and detail calls of both interfaces; `status` is the outcome in variant `open`. */
interface Call {
  interface: 'api' | 'mcp';
  endpoint: string;
  status: number;
  api?: Partial<ListingsRequest>;
  mcp?: { name: string; arguments: Record<string, unknown> };
}

const CALLS: Call[] = [
  { interface: 'api', endpoint: 'search', status: 200, api: { resource: '/listings' } },
  {
    interface: 'api',
    endpoint: 'search',
    status: 400,
    api: { resource: '/listings', queryStringParameters: { priceMin: 'x' } },
  },
  {
    interface: 'api',
    endpoint: 'detail',
    status: 404,
    api: { resource: '/listings/{id}', pathParameters: { id: 'gone-1' } },
  },
  // MCP reports invalid arguments and NOT_FOUND as tool errors inside a 200 response.
  {
    interface: 'mcp',
    endpoint: 'search_listings',
    status: 200,
    mcp: { name: 'search_listings', arguments: {} },
  },
  {
    interface: 'mcp',
    endpoint: 'search_listings',
    status: 200,
    mcp: { name: 'search_listings', arguments: { priceMin: 'x' } },
  },
  {
    interface: 'mcp',
    endpoint: 'get_listing',
    status: 200,
    mcp: { name: 'get_listing', arguments: { id: 'gone-1' } },
  },
];

const VARIANTS: Variant[] = ['open', 'unauthorized', 'rateLimited', 'unavailable'];

function handlers(metrics: Metrics) {
  const api = Object.fromEntries(
    VARIANTS.map((v) => [v, createListingsHandlerFromEnv(envOf(v), sources(v), metrics)]),
  ) as Record<Variant, ReturnType<typeof createListingsHandlerFromEnv>>;
  const mcp = Object.fromEntries(
    VARIANTS.map((v) => [v, createMcpHandlerFromEnv(envOf(v), sources(v), metrics)]),
  ) as Record<Variant, ReturnType<typeof createMcpHandlerFromEnv>>;
  return { api, mcp };
}

const identity = { identity: { sourceIp: '192.0.2.1' } };

async function send(h: ReturnType<typeof handlers>, call: Call, variant: Variant) {
  if (call.interface === 'api') {
    return h.api[variant]({ requestContext: identity, ...call.api });
  }
  const request: McpRequest = {
    httpMethod: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: call.mcp }),
    requestContext: identity,
  };
  return h.mcp[variant](request);
}

afterEach(() => jest.restoreAllMocks());

describe('RequestLatency emission for search and detail calls (Req 11.4)', () => {
  it('emits exactly one data point with the correct dimensions per request', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            call: fc.constantFrom(...CALLS),
            variant: fc.constantFrom(...VARIANTS),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        async (requests) => {
          const { metrics, points } = captureEmf();
          try {
            const h = handlers(metrics);
            for (const { call, variant } of requests) {
              const res = await send(h, call, variant);
              expect(res.statusCode).toBe(VARIANT_STATUS[variant] ?? call.status);
            }
            const emitted = points();
            expect(emitted).toEqual(
              requests.map(({ call }) => ({
                namespace: 'OpenEstateTest',
                dimensionSets: [['interface', 'endpoint']],
                interface: call.interface,
                endpoint: call.endpoint,
                latencyMs: expect.any(Number),
                unit: 'Milliseconds',
              })),
            );
            for (const p of emitted) expect(p.latencyMs as number).toBeGreaterThanOrEqual(0);
          } finally {
            jest.restoreAllMocks();
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});
