import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Metrics } from '@open-estate/core';
import { DEFAULT_TAXONOMY_CONFIG } from '@open-estate/shared';
import { createMcpHandlerFromEnv, logger, mcpEndpoint, type McpRequest } from '@open-estate/mcp';
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
};

const REQUEST: McpRequest = {
  httpMethod: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'search_listings', arguments: {} },
  }),
  requestContext: { identity: { sourceIp: '192.0.2.1' } },
};

const awsError = (name: string) => Object.assign(new Error(name), { name });

/** Real SDK clients with stubbed `send`; no AWS calls are made. */
function setup(env: Record<string, string | undefined> = ENV, metrics?: Metrics) {
  const ssm = new SSMClient({ region: REGION });
  const s3 = new S3Client({ region: REGION });
  jest.spyOn(ssm, 'send').mockImplementation(async (command: unknown) => {
    if (!(command instanceof GetParametersCommand)) throw new Error('unexpected command');
    const names = command.input.Names ?? [];
    return {
      Parameters: names
        .filter((n) => SSM_VALUES[n] !== undefined)
        .map((n) => ({ Name: n, Value: SSM_VALUES[n] })),
    };
  });
  jest.spyOn(s3, 'send').mockImplementation(async (command: unknown) => {
    if (!(command instanceof GetObjectCommand)) throw new Error('unexpected command');
    const body = FILES[command.input.Key ?? ''];
    if (body === undefined) throw awsError('NoSuchKey');
    return { Body: { transformToString: async () => body } };
  });
  const dynamoSend = jest.fn(
    async (command: { constructor: { name: string }; input: { TableName?: string } }) =>
      command.constructor.name === 'QueryCommand' ? { Items: [] } : {},
  );
  const dynamo = { send: dynamoSend } as unknown as DynamoDBDocumentClient;
  const log = jest.spyOn(logger, 'error');
  return { handler: createMcpHandlerFromEnv(env, { ssm, s3, dynamo }, metrics), dynamoSend, log };
}

afterEach(() => jest.restoreAllMocks());

describe('createMcpHandlerFromEnv', () => {
  it('serves tool calls through the shared AccessGuard counters', async () => {
    const { handler, dynamoSend } = setup();

    const res = await handler(REQUEST);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).result.structuredContent).toEqual({ items: [] });
    expect(dynamoSend.mock.calls.map(([c]) => [c.constructor.name, c.input.TableName])).toEqual([
      ['UpdateCommand', 'rate-limit-counters'],
      ['QueryCommand', 'agencies'],
      ['QueryCommand', 'listings'],
    ]);
  });

  it('answers 503 without running a tool when the init failed', async () => {
    const { handler, dynamoSend, log } = setup({
      ...ENV,
      RATE_LIMIT_COUNTERS_TABLE_NAME: undefined,
    });

    const res = await handler(REQUEST);

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).errors[0].code).toBe('SERVICE_UNAVAILABLE');
    expect(dynamoSend).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'POST /mcp: init failed',
      expect.objectContaining({
        code: 'CONFIG_MISSING',
        names: ['RATE_LIMIT_COUNTERS_TABLE_NAME'],
      }),
    );
  });
});

const rpc = (method: string, params?: Record<string, unknown>): McpRequest => ({
  ...REQUEST,
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params && { params }) }),
});

describe('RequestLatency (Req 11.4)', () => {
  it('is emitted per request with interface=mcp and the tool as endpoint', async () => {
    const { metrics, points } = captureEmf();
    const { handler } = setup(ENV, metrics);

    const statuses = [
      await handler(REQUEST),
      await handler(rpc('tools/call', { name: 'get_listing', arguments: { id: 'gone-1' } })),
      await handler(rpc('tools/call', { name: 'list_property_types', arguments: {} })),
      await handler(rpc('tools/list')),
    ].map((r) => r.statusCode);

    expect(statuses).toEqual([200, 200, 200, 200]);
    expect(points()).toEqual(
      ['search_listings', 'get_listing', 'list_property_types', 'protocol'].map((endpoint) => ({
        namespace: 'OpenEstateTest',
        dimensionSets: [['interface', 'endpoint']],
        interface: 'mcp',
        endpoint,
        latencyMs: expect.any(Number),
        unit: 'Milliseconds',
      })),
    );
  });

  it('is emitted for 503 while the init failed', async () => {
    const { metrics, points } = captureEmf();
    const { handler } = setup({ ...ENV, RATE_LIMIT_COUNTERS_TABLE_NAME: undefined }, metrics);

    expect((await handler(REQUEST)).statusCode).toBe(503);
    expect(points()).toEqual([
      expect.objectContaining({ interface: 'mcp', endpoint: 'search_listings' }),
    ]);
  });

  it('maps everything but a known tool call to `protocol`', () => {
    const body = (value: unknown) => ({ body: JSON.stringify(value) });
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_listing' } };
    expect(mcpEndpoint(body(call))).toBe('get_listing');
    expect(
      mcpEndpoint({
        body: Buffer.from(JSON.stringify(call)).toString('base64'),
        isBase64Encoded: true,
      }),
    ).toBe('get_listing');
    expect(mcpEndpoint(body({ ...call, params: { name: 'drop_tables' } }))).toBe('protocol');
    expect(mcpEndpoint(body([call]))).toBe('protocol');
    expect(mcpEndpoint({ body: '{not json' })).toBe('protocol');
    expect(mcpEndpoint({ body: null })).toBe('protocol');
  });
});
