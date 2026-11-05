// Task 10.5 (Req 13.4, 14.1): the production-wired MCP handler writes the same usage lines as the
// Search_API (ids only, no IP, no API key) and emits `RequestCount` with `interface=mcp`.
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { hashApiKey, toListingItem, UsageLine } from '@open-estate/core';
import { DEFAULT_TAXONOMY_CONFIG } from '@open-estate/shared';
import { createMcpHandlerFromEnv, type McpRequest } from '@open-estate/mcp';
import { exampleListing } from '../../shared/test/arbitraries';
import { captureEmf } from '../../core/test/observability/emf-capture';

const REGION = 'eu-central-1';
const SOURCE_IP = '203.0.113.42';
const API_KEY = 'oe_live_mcp_0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const KEY_ID = 'key-mcp-1';

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
  '/oe/test/access-mode': 'api-keys',
  '/oe/test/rate-limit': '{"requests":60,"windowSeconds":60}',
};

const FILES: Record<string, string> = {
  'taxonomy.json': JSON.stringify(DEFAULT_TAXONOMY_CONFIG),
  'i18n-config.json': JSON.stringify({
    defaultLocale: 'de',
    enabled: [{ locale: 'de', label: 'Deutsch' }],
  }),
};

const OWNED = exampleListing('owned-1');
const AGENCY = 'agency-3';

const awsError = (name: string) => Object.assign(new Error(name), { name });

function setup() {
  const ssm = new SSMClient({ region: REGION });
  const s3 = new S3Client({ region: REGION });
  jest.spyOn(ssm, 'send').mockImplementation(async (command: unknown) => {
    if (!(command instanceof GetParametersCommand)) throw new Error('unexpected command');
    return {
      Parameters: (command.input.Names ?? []).map((n) => ({ Name: n, Value: SSM_VALUES[n] })),
    };
  });
  jest.spyOn(s3, 'send').mockImplementation(async (command: unknown) => {
    if (!(command instanceof GetObjectCommand)) throw new Error('unexpected command');
    const body = FILES[command.input.Key ?? ''];
    if (body === undefined) throw awsError('NoSuchKey');
    return { Body: { transformToString: async () => body } };
  });
  const item = toListingItem(OWNED, { status: 'ACTIVE', agencyId: AGENCY });
  const dynamo = {
    send: jest.fn(
      async (command: {
        constructor: { name: string };
        input: { TableName?: string; Key?: { id?: string } };
      }) => {
        const { name } = command.constructor;
        const table = command.input.TableName;
        if (name === 'QueryCommand' && table === 'api-keys') {
          return { Items: [{ keyId: KEY_ID, keyHash: hashApiKey(API_KEY), status: 'active' }] };
        }
        if (name === 'QueryCommand' && table === 'listings') return { Items: [item] };
        if (name === 'QueryCommand') return { Items: [] };
        if (name === 'GetCommand' && table === 'listings') {
          return command.input.Key?.id === OWNED.id ? { Item: item } : {};
        }
        return {};
      },
    ),
  } as unknown as DynamoDBDocumentClient;
  const { metrics, countPoints, lines } = captureEmf();
  const handler = createMcpHandlerFromEnv(ENV, { ssm, s3, dynamo }, metrics);
  const usageLines = () => lines().filter((line) => line.includes('"usage"'));
  return { handler, countPoints, usageLines };
}

const call = (name: string, args: Record<string, unknown>): McpRequest => ({
  httpMethod: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${API_KEY}`,
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  }),
  requestContext: { identity: { sourceIp: SOURCE_IP } },
});

afterEach(() => jest.restoreAllMocks());

describe('MCP usage line and RequestCount', () => {
  it('records impressions and detail views without IP or API key', async () => {
    const { handler, usageLines, countPoints } = setup();

    expect((await handler(call('search_listings', {}))).statusCode).toBe(200);
    expect((await handler(call('get_listing', { id: OWNED.id }))).statusCode).toBe(200);
    // NOT_FOUND is a tool error inside a 200 response: no detail view.
    expect((await handler(call('get_listing', { id: 'missing-1' }))).statusCode).toBe(200);

    const written = usageLines();
    expect(written.map((line) => UsageLine.parse(JSON.parse(line)))).toEqual([
      { usage: { kind: 'impression', items: [{ id: OWNED.id, agencyId: AGENCY }] } },
      { usage: { kind: 'detail', items: [{ id: OWNED.id, agencyId: AGENCY }] } },
    ]);
    for (const line of written) {
      for (const secret of [SOURCE_IP, API_KEY, KEY_ID, hashApiKey(API_KEY)]) {
        expect(line).not.toContain(secret);
      }
    }

    expect(countPoints().map((p) => [p.interface, p.endpoint, p.statusClass])).toEqual([
      ['mcp', 'search_listings', '2xx'],
      ['mcp', 'get_listing', '2xx'],
      ['mcp', 'get_listing', '2xx'],
    ]);
  });
});
