import {
  createAccessGuard,
  createListingService,
  createSearchService,
  InMemoryApiKeyStore,
  InMemoryRateLimitCounterStore,
  InMemorySearchProvider,
  StaticAccessConfigSource,
  type AccessConfig,
  type AccessGuard,
  type SearchService,
} from '@open-estate/core';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  type ErrorResponse,
  type LocaleConfig,
} from '@open-estate/shared';
import { buildOpenApiDocument } from '@open-estate/api';
import { createMcpHandler, SERVER_INFO, type McpRequest } from '@open-estate/mcp';
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import { exampleListing } from '../../shared/test/arbitraries/listing';

// MCP_Server protocol behaviour (Req 19.1, 19.2, 19.9, 19.10): tool schemas against the generated
// OpenAPI document, the `initialize` handshake in stateless JSON mode and the JSON-RPC/HTTP edge
// cases of `POST /mcp`. Tool results and guard errors are covered in mcp-handler.test.ts.

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const locales: LocaleConfig = {
  defaultLocale: 'de',
  enabled: [
    { locale: 'de', label: 'Deutsch' },
    { locale: 'en', label: 'English' },
  ],
};
const schemas = buildSchemas(taxonomy, locales);
const OPEN: AccessConfig = { mode: 'open', rateLimit: { requests: 1000, windowSeconds: 60 } };
const ACCEPT = 'application/json, text/event-stream';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

interface JsonSchemaObject {
  type: string;
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
}

interface Tool {
  name: string;
  inputSchema: JsonSchemaObject;
}

interface Param {
  name: string;
  in: string;
  required?: boolean;
  schema: Record<string, unknown>;
}

function setup(options: { access?: AccessConfig; guard?: AccessGuard; deadlineMs?: number } = {}) {
  const provider = new InMemorySearchProvider([exampleListing('id-000')]);
  const search: SearchService = createSearchService({
    provider,
    taxonomy,
    tourProviders: { providers: [] },
    defaultCurrency: 'EUR',
  });
  const guard =
    options.guard ??
    createAccessGuard({
      config: new StaticAccessConfigSource(options.access ?? OPEN),
      apiKeys: new InMemoryApiKeyStore([]),
      counters: new InMemoryRateLimitCounterStore(),
    });
  const admit = jest.spyOn(guard, 'admit');
  const searchSpy = jest.spyOn(search, 'search');
  const mcp = createMcpHandler({
    guard,
    schemas,
    taxonomy,
    search,
    listings: createListingService({ provider, taxonomy }),
    ...(options.deadlineMs !== undefined && { deadlineMs: options.deadlineMs }),
  });

  function send(event: Partial<McpRequest> & { body?: string | null }) {
    return mcp({
      httpMethod: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: ACCEPT },
      requestContext: { identity: { sourceIp: '192.0.2.1' } },
      ...event,
    });
  }
  async function post(message: unknown) {
    const res = await send({ body: JSON.stringify(message) });
    return { ...res, json: (res.body === '' ? undefined : JSON.parse(res.body)) as unknown };
  }
  async function rpc(id: number | string, method: string, params?: Record<string, unknown>) {
    const res = await post({ jsonrpc: '2.0', id, method, ...(params && { params }) });
    return { ...res, json: res.json as JsonRpcResponse };
  }
  return { send, post, rpc, admit, searchSpy };
}

afterEach(() => jest.restoreAllMocks());

describe('tools/list schemas equal the OpenAPI parameters (Req 19.2)', () => {
  const openApi = buildOpenApiDocument({
    schemas,
    taxonomy,
    locales,
    defaultCurrency: 'EUR',
    tourProviders: { providers: [] },
  });
  const params = (path: string) =>
    ((openApi.paths?.[path]?.get?.parameters ?? []) as Param[]).filter((p) => p.in !== 'header');

  async function listedTools(): Promise<Record<string, Tool>> {
    const res = await setup().rpc(1, 'tools/list');
    const tools = res.json.result?.['tools'] as Tool[];
    return Object.fromEntries(tools.map((t) => [t.name, t]));
  }

  /** Name, location, required flag and schema of every parameter, as the MCP tool states them. */
  function asParameters(tool: Tool, location: (name: string) => string) {
    return Object.entries(tool.inputSchema.properties).map(([name, schema]) => ({
      name,
      in: location(name),
      required: tool.inputSchema.required?.includes(name) ?? false,
      schema,
    }));
  }

  const fromOpenApi = (p: Param) => ({
    name: p.name,
    in: p.in,
    required: p.required ?? false,
    schema: p.schema,
  });

  it('search_listings: every query parameter of GET /listings, same type, default and range', async () => {
    const tool = (await listedTools())['search_listings'];
    if (tool === undefined) throw new Error('search_listings missing');

    expect(tool.inputSchema.type).toBe('object');
    expect(asParameters(tool, () => 'query')).toEqual(params('/listings').map(fromOpenApi));

    // The equality above is only meaningful if the schemas carry the constraints of Req 19.2.
    const keywords = new Set(
      Object.values(tool.inputSchema.properties).flatMap((schema) => Object.keys(schema)),
    );
    for (const keyword of [
      'type',
      'enum',
      'default',
      'minimum',
      'maximum',
      'multipleOf',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
      'pattern',
      'x-minimum',
      'x-maximum',
    ]) {
      expect([keyword, keywords.has(keyword)]).toEqual([keyword, true]);
    }
    const types = new Set(Object.values(tool.inputSchema.properties).map((s) => s['type']));
    expect([...types].sort()).toEqual(['array', 'boolean', 'integer', 'number', 'string']);
  });

  it('get_listing: path id (required) and query lang of GET /listings/{id}', async () => {
    const tool = (await listedTools())['get_listing'];
    if (tool === undefined) throw new Error('get_listing missing');

    // The path parameter becomes a required property of the tool input.
    const location = (name: string) => (name === 'id' ? 'path' : 'query');
    expect(asParameters(tool, location)).toEqual(params('/listings/{id}').map(fromOpenApi));
    expect(tool.inputSchema.required).toEqual(['id']);
  });

  it('group is advertised as a one-element array, like the repeated query parameter', async () => {
    const tools = await listedTools();
    const group = tools['search_listings']?.inputSchema.properties['group'];

    expect(group).toEqual({
      type: 'array',
      items: { type: 'string', enum: schemas.enums.groups },
      minItems: 1,
      maxItems: 1,
    });
  });

  it('group accepts a plain string as well as the advertised array', async () => {
    const { rpc } = setup();
    const call = (group: unknown) =>
      rpc(1, 'tools/call', { name: 'search_listings', arguments: { group } });

    const asArray = await call(['apartment']);
    const asString = await call('apartment');

    expect(asArray.json.result?.['isError']).toBeUndefined();
    expect(asString.json.result).toEqual(asArray.json.result);
  });

  it('search_listings filters by country and rejects a lower-case code', async () => {
    const { rpc } = setup();
    const call = async (country: unknown) =>
      (await rpc(1, 'tools/call', { name: 'search_listings', arguments: { country } })).json
        .result as { isError?: boolean; structuredContent: Record<string, unknown> };
    const { country } = exampleListing('id-000').address;
    const other = country === 'TH' ? 'DE' : 'TH';

    expect((await call(country)).structuredContent['items']).toHaveLength(1);
    expect((await call(other)).structuredContent['items']).toEqual([]);
    const invalid = await call(country.toLowerCase());
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toEqual({
      errors: [expect.objectContaining({ code: 'INVALID_PARAMETER', field: 'country' })],
    });
  });
});

describe('initialize handshake in stateless JSON mode', () => {
  const initialize = (protocolVersion: string) => ({
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'test-agent', version: '1.0.0' },
  });

  it('answers with protocol version, serverInfo and the tools capability, without a session', async () => {
    const { rpc } = setup();

    const res = await rpc(1, 'initialize', initialize(LATEST_PROTOCOL_VERSION));

    expect(res.statusCode).toBe(200);
    expect(res.headers?.['content-type']).toBe('application/json');
    expect(res.headers?.['mcp-session-id']).toBeUndefined();
    expect(res.json).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    });
  });

  it.each(SUPPORTED_PROTOCOL_VERSIONS.filter((v) => v !== LATEST_PROTOCOL_VERSION))(
    'echoes the supported client version %s',
    async (version) => {
      const { rpc } = setup();

      const res = await rpc(1, 'initialize', initialize(version));

      expect(res.json.result?.['protocolVersion']).toBe(version);
    },
  );

  it('offers the latest version for an unsupported client version', async () => {
    const { rpc } = setup();

    const res = await rpc(1, 'initialize', initialize('1999-01-01'));

    expect(res.json.result?.['protocolVersion']).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('acknowledges notifications/initialized with 202 and no body', async () => {
    const { post } = setup();

    const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });

    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
  });

  it('serves tools/list without a prior initialize (each request stands alone)', async () => {
    const { rpc } = setup();

    const res = await rpc('no-init', 'tools/list');

    expect(res.json.id).toBe('no-init');
    expect(res.json.result?.['tools']).toHaveLength(3);
  });
});

describe('unknown tool (Req 19.9)', () => {
  it.each(['Search_Listings', 'search_listings ', '', 'list_property_types\u0000'])(
    'rejects the near-miss name %j and echoes the request id',
    async (name) => {
      const { rpc, searchSpy } = setup();

      const res = await rpc(7, 'tools/call', { name, arguments: {} });

      expect(res.statusCode).toBe(200);
      expect(res.json).toEqual({
        jsonrpc: '2.0',
        id: 7,
        error: { code: -32602, message: expect.any(String), data: { code: 'UNKNOWN_TOOL' } },
      });
      expect(res.json.error?.message).toContain(name);
      expect(searchSpy).not.toHaveBeenCalled();
    },
  );
});

describe('deadline (Req 19.10)', () => {
  it('answers 503 SERVICE_UNAVAILABLE when the AccessGuard itself hangs', async () => {
    const hanging: AccessGuard = { admit: () => new Promise(() => undefined) };
    const { rpc, searchSpy } = setup({ guard: hanging, deadlineMs: 20 });

    const res = await rpc(1, 'tools/call', { name: 'search_listings', arguments: {} });

    expect(res.statusCode).toBe(503);
    expect(res.headers).toMatchObject({ 'Cache-Control': 'no-store' });
    expect(res.json as unknown as ErrorResponse).toEqual({
      errors: [{ code: 'SERVICE_UNAVAILABLE', message: expect.any(String) }],
    });
    expect(searchSpy).not.toHaveBeenCalled();
  });
});

describe('HTTP and JSON-RPC edge cases', () => {
  it.each(['GET', 'DELETE', 'PUT'])(
    'answers %s with 405 and Allow: POST, without consuming the rate limit',
    async (httpMethod) => {
      const { send, admit } = setup();

      const res = await send({ httpMethod, body: null });

      expect(res.statusCode).toBe(405);
      expect(res.headers).toMatchObject({ Allow: 'POST' });
      expect(JSON.parse(res.body)).toEqual({
        jsonrpc: '2.0',
        error: { code: -32000, message: expect.any(String) },
        id: null,
      });
      expect(admit).not.toHaveBeenCalled();
    },
  );

  it.each(['{"jsonrpc":"2.0","id":1,', 'not json', '{"jsonrpc":"2.0","id":1}}'])(
    'answers malformed JSON %j with a JSON-RPC parse error (-32700), not 5xx',
    async (body) => {
      const { send } = setup();

      const res = await send({ body });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({
        jsonrpc: '2.0',
        error: { code: -32700, message: expect.any(String) },
        id: null,
      });
    },
  );

  // JSON-RPC batches were removed in MCP 2025-06-18. One admission must not run several requests
  // (Req 17.1), so a batch is rejected as a whole after the guard and no entry is executed.
  const searchCall = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'search_listings', arguments: {} },
  };
  it.each<[string, unknown[]]>([
    [
      'three requests',
      [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, searchCall, { ...searchCall, id: 3 }],
    ],
    ['a single request', [searchCall]],
    ['an empty array', []],
  ])('rejects a batch of %s with -32600 without running any tool', async (_, batch) => {
    const access: AccessConfig = { mode: 'open', rateLimit: { requests: 1, windowSeconds: 60 } };
    const { post, admit, searchSpy } = setup({ access });

    const res = await post(batch);

    expect(res.statusCode).toBe(400);
    expect(res.json).toEqual({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Batch requests are not supported' },
      id: null,
    });
    expect(searchSpy).not.toHaveBeenCalled();
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it('rejects a base64-encoded batch as well', async () => {
    const { send, searchSpy } = setup();

    const res = await send({
      body: Buffer.from(JSON.stringify([searchCall])).toString('base64'),
      isBase64Encoded: true,
    });

    expect(res.statusCode).toBe(400);
    expect((JSON.parse(res.body) as JsonRpcResponse).error?.code).toBe(-32600);
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it('counts a rejected batch against the rate limit', async () => {
    const access: AccessConfig = { mode: 'open', rateLimit: { requests: 1, windowSeconds: 60 } };
    const { post, rpc, searchSpy } = setup({ access });

    await post([searchCall]);
    const next = await rpc(1, 'tools/call', { name: 'search_listings', arguments: {} });

    expect(next.statusCode).toBe(429);
    expect(searchSpy).not.toHaveBeenCalled();
  });
});
