import {
  createAccessGuard,
  createListingService,
  createSearchService,
  hashApiKey,
  InMemoryApiKeyStore,
  InMemoryRateLimitCounterStore,
  InMemorySearchProvider,
  StaticAccessConfigSource,
  type AccessConfig,
  type ApiKeyRecord,
  type SearchService,
} from '@open-estate/core';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  type ErrorResponse,
  type Listing,
} from '@open-estate/shared';
import { createListingsHandler } from '@open-estate/api';
import { createMcpHandler, TOOL_NAMES, type McpHandlerDeps } from '@open-estate/mcp';
import { exampleListing } from '../../shared/test/arbitraries/listing';

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
const SOURCE_IP = '192.0.2.1';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: { type: string; text: string }[];
}

function listings(count: number): Listing[] {
  return Array.from({ length: count }, (_, i) =>
    exampleListing(`id-${String(i).padStart(3, '0')}`),
  );
}

function setup(
  options: {
    stored?: readonly Listing[];
    access?: AccessConfig;
    search?: SearchService;
    deadlineMs?: number;
  } = {},
) {
  const provider = new InMemorySearchProvider(options.stored ?? []);
  // One counter store for both adapters, like the shared DynamoDB table (Req 17.1).
  const guard = createAccessGuard({
    config: new StaticAccessConfigSource(options.access ?? OPEN),
    apiKeys: new InMemoryApiKeyStore([KEY_RECORD]),
    counters: new InMemoryRateLimitCounterStore(),
    clock: () => NOW,
  });
  const search =
    options.search ??
    createSearchService({
      provider,
      taxonomy,
      tourProviders: { providers: [] },
      defaultCurrency: 'EUR',
    });
  const deps: McpHandlerDeps = {
    guard,
    schemas,
    taxonomy,
    search,
    listings: createListingService({ provider, taxonomy }),
    ...(options.deadlineMs !== undefined && { deadlineMs: options.deadlineMs }),
  };
  const mcp = createMcpHandler(deps);
  const api = createListingsHandler({ guard, schemas, search });

  let nextId = 1;
  async function rpc(method: string, params: Record<string, unknown> = {}, headers = {}) {
    const res = await mcp({
      httpMethod: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      requestContext: { identity: { sourceIp: SOURCE_IP } },
    });
    return { ...res, json: JSON.parse(res.body) as JsonRpcResponse };
  }
  async function callTool(name: string, args: Record<string, unknown> = {}, headers = {}) {
    const res = await rpc('tools/call', { name, arguments: args }, headers);
    return { ...res, tool: res.json.result as unknown as ToolResult };
  }
  async function apiSearch(query: Record<string, string> = {}) {
    const res = await api({
      queryStringParameters: query,
      requestContext: { identity: { sourceIp: SOURCE_IP } },
    });
    return { ...res, json: JSON.parse(res.body) as Record<string, unknown> };
  }
  return { rpc, callTool, apiSearch };
}

afterEach(() => jest.restoreAllMocks());

describe('POST /mcp: tools/list', () => {
  it('lists exactly the three read-only tools with API schema bounds (Req 19.1, 19.2)', async () => {
    const { rpc } = setup();

    const res = await rpc('tools/list');

    expect(res.statusCode).toBe(200);
    const tools = res.json.result?.['tools'] as {
      name: string;
      inputSchema: { properties: Record<string, Record<string, unknown>>; required?: string[] };
      annotations: { readOnlyHint: boolean };
    }[];
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    expect(tools.every((t) => t.annotations.readOnlyHint)).toBe(true);

    const [search, detail] = tools;
    expect(search?.inputSchema.properties['pageSize']).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 50,
      default: 20,
    });
    expect(search?.inputSchema.properties['offerType']).toEqual({
      type: 'string',
      enum: ['SALE', 'RENT'],
    });
    expect(search?.inputSchema.required).toBeUndefined();
    expect(detail?.inputSchema.required).toEqual(['id']);
  });
});

describe('POST /mcp: search_listings', () => {
  it('returns the same items and pagination as GET /listings (Req 19.3)', async () => {
    const { callTool, apiSearch } = setup({ stored: listings(25).reverse() });

    const first = await callTool('search_listings', { pageSize: 10, lang: 'en' });
    const apiFirst = await apiSearch({ pageSize: '10', lang: 'en' });

    expect(first.tool.isError).toBeUndefined();
    expect(first.tool.structuredContent).toEqual(apiFirst.json);
    expect(JSON.parse(first.tool.content[0]?.text ?? '')).toEqual(apiFirst.json);
    const token = first.tool.structuredContent?.['nextPageToken'] as string;
    expect(token).toEqual(expect.any(String));

    const second = await callTool('search_listings', {
      pageSize: 10,
      lang: 'en',
      pageToken: token,
    });
    const apiSecond = await apiSearch({ pageSize: '10', lang: 'en', pageToken: token });
    expect(second.tool.structuredContent).toEqual(apiSecond.json);
    expect((second.tool.structuredContent?.['items'] as Listing[]).map((l) => l.id)[0]).toBe(
      'id-010',
    );
  });

  it('applies the API default page size of 20', async () => {
    const { callTool } = setup({ stored: listings(25) });

    const res = await callTool('search_listings');

    expect(res.tool.structuredContent?.['items']).toHaveLength(20);
  });

  it('rejects invalid parameters with the API error codes and fields (Req 19.6)', async () => {
    const { callTool, apiSearch } = setup({ stored: listings(3) });

    const res = await callTool('search_listings', { pageSize: 0, priceMin: '100' });
    const api = await apiSearch({ pageSize: '0', priceMin: '100' });

    expect(res.statusCode).toBe(200);
    expect(res.tool.isError).toBe(true);
    expect(res.tool.structuredContent).toEqual({
      errors: (api.json as unknown as ErrorResponse).errors,
    });
    expect(
      (res.tool.structuredContent as unknown as ErrorResponse).errors.map((e) => e.code),
    ).toEqual(expect.arrayContaining(['INVALID_PAGE_SIZE', 'OFFER_TYPE_REQUIRED']));
  });
});

describe('POST /mcp: get_listing and list_property_types', () => {
  it('returns the localized listing', async () => {
    const { callTool } = setup({ stored: listings(2) });

    const res = await callTool('get_listing', { id: 'id-001' });

    expect(res.tool.isError).toBeUndefined();
    expect(res.tool.structuredContent?.['id']).toBe('id-001');
  });

  it('reports a missing listing as NOT_FOUND without listing data (Req 19.8)', async () => {
    const { callTool } = setup({ stored: listings(1) });

    const res = await callTool('get_listing', { id: 'missing' });

    expect(res.tool.isError).toBe(true);
    expect(res.tool.structuredContent).toEqual({
      errors: [{ code: 'NOT_FOUND', message: expect.any(String), details: { id: 'missing' } }],
    });
  });

  it('returns the full taxonomy (Req 19.5)', async () => {
    const { callTool } = setup();

    const res = await callTool('list_property_types');

    expect(res.tool.structuredContent).toEqual({ groups: DEFAULT_TAXONOMY_CONFIG.groups });
  });
});

describe('POST /mcp: errors', () => {
  it('rejects an unknown tool with a JSON-RPC error UNKNOWN_TOOL (Req 19.9)', async () => {
    const { rpc } = setup();

    const res = await rpc('tools/call', { name: 'delete_listing', arguments: {} });

    expect(res.json.result).toBeUndefined();
    expect(res.json.error).toMatchObject({ code: -32602, data: { code: 'UNKNOWN_TOOL' } });
  });

  it.each([
    [{}, 'API_KEY_MISSING'],
    [{ Authorization: 'Bearer wrong' }, 'API_KEY_INVALID'],
  ])('answers 401 without running the tool (Req 17.7): %j', async (headers, code) => {
    const access: AccessConfig = { ...OPEN, mode: 'api-keys' };
    const { callTool } = setup({ access, stored: listings(1) });

    const res = await callTool('search_listings', {}, headers);

    expect(res.statusCode).toBe(401);
    expect((res.json as unknown as ErrorResponse).errors).toEqual([
      { code, message: expect.any(String) },
    ]);
  });

  it('admits a valid API key', async () => {
    const access: AccessConfig = { ...OPEN, mode: 'api-keys' };
    const { callTool } = setup({ access, stored: listings(1) });

    const res = await callTool(
      'get_listing',
      { id: 'id-000' },
      { authorization: `Bearer ${API_KEY}` },
    );

    expect(res.statusCode).toBe(200);
    expect(res.tool.structuredContent?.['id']).toBe('id-000');
  });

  it('shares the rate limit with the Search_API and answers 429 (Req 17.1, 17.3)', async () => {
    const access: AccessConfig = { mode: 'open', rateLimit: { requests: 1, windowSeconds: 60 } };
    const { callTool, apiSearch } = setup({ access });

    expect((await apiSearch()).statusCode).toBe(200);
    const res = await callTool('search_listings');

    expect(res.statusCode).toBe(429);
    expect(res.headers?.['Retry-After']).toBe('45');
    expect(res.json).toEqual({
      errors: [
        { code: 'RATE_LIMITED', message: expect.any(String), details: { retryAfterSeconds: 45 } },
      ],
      retryAfterSeconds: 45,
    });
  });

  it('aborts after the deadline with SERVICE_UNAVAILABLE and no partial result (Req 19.10)', async () => {
    const hanging: SearchService = { search: () => new Promise(() => undefined) };
    const { callTool } = setup({ search: hanging, deadlineMs: 20 });

    const res = await callTool('search_listings');

    expect(res.statusCode).toBe(200);
    expect(res.tool).toEqual({
      isError: true,
      content: [{ type: 'text', text: expect.any(String) }],
      structuredContent: { errors: [{ code: 'SERVICE_UNAVAILABLE', message: expect.any(String) }] },
    });
  });

  it('maps a failing domain call to SERVICE_UNAVAILABLE', async () => {
    const failing: SearchService = { search: () => Promise.reject(new Error('boom')) };
    const { callTool } = setup({ search: failing });

    const res = await callTool('search_listings');

    expect(res.tool.isError).toBe(true);
    expect((res.tool.structuredContent as unknown as ErrorResponse).errors[0]?.code).toBe(
      'SERVICE_UNAVAILABLE',
    );
  });
});
