// Feature: real-estate-platform, Property 8: Einheitliche Fehlerstruktur
import type { S3Client } from '@aws-sdk/client-s3';
import type { SSMClient } from '@aws-sdk/client-ssm';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import fc from 'fast-check';
import {
  createListingDetailHandler,
  createListingsHandler,
  createListingsHandlerFromEnv,
  createRouter,
  LISTINGS_ROUTES,
  type ListingsRequest,
} from '@open-estate/api';
import {
  createAccessGuard,
  createListingService,
  createSearchService,
  hashApiKey,
  InMemoryApiKeyStore,
  InMemoryRateLimitCounterStore,
  InMemorySearchProvider,
  ServiceUnavailableError,
  StaticAccessConfigSource,
  type AccessConfig,
  type ApiKeyRecord,
  type ListingService,
  type SearchService,
} from '@open-estate/core';
import {
  createMcpHandler,
  createMcpHandlerFromEnv,
  TOOL_NAMES,
  type McpRequest,
} from '@open-estate/mcp';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
} from '@open-estate/shared';
import { exampleListing } from '../../shared/test/arbitraries/listing';

/**
 * Every failing request to Search_API or MCP_Server carries at least one error with a catalog
 * code and a non-empty human-readable message.
 *
 * **Validates: Requirements 3.4, 2.2**
 */

const RUNS = { numRuns: 100 };

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
const NOW = 60_000 * 29_000_000 + 15_000;
const RATE_LIMIT = { requests: 1000, windowSeconds: 60 };
const SOURCE_IP = '192.0.2.1';
const STORED_ID = 'home-1';

/** Same environment as the Lambda tests; the init property drops at least one entry. */
const ENV: Record<string, string> = {
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

const CATALOG: ReadonlySet<string> = new Set(ERROR_CODES);

// --- Arbitraries ------------------------------------------------------------------------------

type Access = 'missing-key' | 'invalid-key' | 'rate-limited';
type Failure = 'throws' | 'hangs';

/** A search argument fragment that alone already makes the query invalid. */
interface Fragment {
  key: string;
  api: string;
  mcp: unknown;
}

const arbInvalidFragment: fc.Arbitrary<Fragment> = fc.oneof(
  fc
    .oneof(fc.integer({ max: 0 }), fc.integer({ min: 51 }))
    .map((n) => ({ key: 'pageSize', api: String(n), mcp: n })),
  fc
    .stringMatching(/^[A-Z]{1,8}$/)
    .filter((s) => s !== 'SALE' && s !== 'RENT')
    .map((s) => ({ key: 'offerType', api: s, mcp: s })),
  fc.constantFrom('not a locale', '', '1234', 'x'.repeat(40)).map((s) => ({
    key: 'lang',
    api: s,
    mcp: s,
  })),
  fc.stringMatching(/^[a-z]{1,8}$/).map((s) => ({
    key: 'pageToken',
    api: `!!${s}`,
    mcp: `!!${s}`,
  })),
  fc.stringMatching(/^[a-z]{1,8}$/).map((s) => ({
    key: 'types',
    api: `zz_unknown_${s}`,
    mcp: [`zz_unknown_${s}`],
  })),
  // Price filter without offerType (OFFER_TYPE_REQUIRED).
  fc.nat({ max: 1_000_000 }).map((n) => ({ key: 'priceMin', api: String(n), mcp: String(n) })),
);

/** Merged fragments; on duplicate keys the last one wins, which is still invalid. */
const arbInvalidSearch = fc.array(arbInvalidFragment, { minLength: 1, maxLength: 4 }).map((fs) => ({
  api: Object.fromEntries(fs.map((f) => [f.key, f.api])) as Record<string, string>,
  mcp: Object.fromEntries(fs.map((f) => [f.key, f.mcp])) as Record<string, unknown>,
}));

/** Path id that is missing, empty, too long or malformed (API: raw path segment). */
const arbInvalidApiId = fc.oneof(
  fc.constantFrom(undefined, '', '%E0%A4%A', '%'),
  fc.integer({ min: 129, max: 300 }).map((n) => 'x'.repeat(n)),
);

/** Detail args with a missing, empty, too long or non-string id (MCP tool arguments). */
const arbInvalidMcpDetailArgs = fc.oneof(
  fc.constant({}),
  fc.constant({ id: '' }),
  fc.integer({ min: 129, max: 300 }).map((n) => ({ id: 'x'.repeat(n) })),
  fc.oneof(fc.integer(), fc.boolean(), fc.constant(null)).map((id) => ({ id })),
);

/** Valid id that is not stored. */
const arbUnknownId = fc.stringMatching(/^[a-z0-9-]{1,40}$/).filter((id) => id !== STORED_ID);

const arbAccess: fc.Arbitrary<Access> = fc.constantFrom(
  'missing-key',
  'invalid-key',
  'rate-limited',
);
const arbWrongKey = fc.stringMatching(/^[A-Za-z0-9]{1,32}$/).filter((k) => k !== API_KEY);

/** What a downstream call rejects with: Error subclasses and non-Error values. */
const arbCause: fc.Arbitrary<unknown> = fc.oneof(
  fc.string().map((m) => new Error(m)),
  fc.string().map((m) => new TypeError(m)),
  fc.string().map((m) => new ServiceUnavailableError(m)),
  fc.oneof(fc.string(), fc.integer(), fc.constant(null), fc.constant(undefined)),
);

const arbDroppedEnv = fc.subarray(Object.keys(ENV), { minLength: 1 });

type Scenario =
  | { kind: 'api-search-invalid'; query: Record<string, string> }
  | { kind: 'api-detail-invalid-id'; id: string | undefined }
  | { kind: 'api-detail-unknown-id'; id: string }
  | { kind: 'api-access'; route: 'search' | 'detail'; access: Access; wrongKey: string }
  | { kind: 'api-downstream'; route: 'search' | 'detail'; cause: unknown }
  | { kind: 'api-unknown-resource'; resource: string | undefined }
  | { kind: 'api-init'; dropped: string[] }
  | { kind: 'mcp-search-invalid'; args: Record<string, unknown> }
  | { kind: 'mcp-detail-invalid'; args: Record<string, unknown> }
  | { kind: 'mcp-detail-unknown-id'; id: string }
  | { kind: 'mcp-unknown-tool'; name: string }
  | { kind: 'mcp-access'; access: Access; wrongKey: string }
  | {
      kind: 'mcp-downstream';
      tool: 'search_listings' | 'get_listing';
      failure: Failure;
      cause: unknown;
    }
  | { kind: 'mcp-init'; dropped: string[] };

const arbScenario: fc.Arbitrary<Scenario> = fc.oneof(
  arbInvalidSearch.map((s) => ({ kind: 'api-search-invalid' as const, query: s.api })),
  arbInvalidApiId.map((id) => ({ kind: 'api-detail-invalid-id' as const, id })),
  arbUnknownId.map((id) => ({ kind: 'api-detail-unknown-id' as const, id })),
  fc.record({
    kind: fc.constant('api-access' as const),
    route: fc.constantFrom('search' as const, 'detail' as const),
    access: arbAccess,
    wrongKey: arbWrongKey,
  }),
  fc.record({
    kind: fc.constant('api-downstream' as const),
    route: fc.constantFrom('search' as const, 'detail' as const),
    cause: arbCause,
  }),
  fc
    .option(fc.string(), { nil: undefined })
    .filter((r) => r !== LISTINGS_ROUTES.search && r !== LISTINGS_ROUTES.detail)
    .map((resource) => ({ kind: 'api-unknown-resource' as const, resource })),
  arbDroppedEnv.map((dropped) => ({ kind: 'api-init' as const, dropped })),
  arbInvalidSearch.map((s) => ({ kind: 'mcp-search-invalid' as const, args: s.mcp })),
  arbInvalidMcpDetailArgs.map((args) => ({ kind: 'mcp-detail-invalid' as const, args })),
  arbUnknownId.map((id) => ({ kind: 'mcp-detail-unknown-id' as const, id })),
  fc
    .string()
    .filter((n) => !(TOOL_NAMES as readonly string[]).includes(n))
    .map((name) => ({ kind: 'mcp-unknown-tool' as const, name })),
  fc.record({
    kind: fc.constant('mcp-access' as const),
    access: arbAccess,
    wrongKey: arbWrongKey,
  }),
  fc.record({
    kind: fc.constant('mcp-downstream' as const),
    tool: fc.constantFrom('search_listings' as const, 'get_listing' as const),
    failure: fc.constantFrom<Failure>('throws', 'hangs'),
    cause: arbCause,
  }),
  arbDroppedEnv.map((dropped) => ({ kind: 'mcp-init' as const, dropped })),
);

// --- Harness ----------------------------------------------------------------------------------

/** Normalized failure: the error entries and, for HTTP-level errors, the status. */
interface Observed {
  errors: unknown;
  /** HTTP status that must match the first code; absent for tool and JSON-RPC errors. */
  status?: number;
}

function accessConfig(access: Access | undefined): AccessConfig {
  if (access === 'rate-limited')
    return { mode: 'open', rateLimit: { requests: 1, windowSeconds: 60 } };
  if (access === undefined) return { mode: 'open', rateLimit: RATE_LIMIT };
  return { mode: 'api-keys', rateLimit: RATE_LIMIT };
}

function authHeaders(access: Access | undefined, wrongKey: string): Record<string, string> {
  return access === 'invalid-key' ? { Authorization: `Bearer ${wrongKey}` } : {};
}

function rejecting(cause: unknown): () => Promise<never> {
  return () => Promise.reject(cause);
}

function deps(options: { access?: Access; search?: SearchService; listings?: ListingService }) {
  const provider = new InMemorySearchProvider([exampleListing(STORED_ID)]);
  const guard = createAccessGuard({
    config: new StaticAccessConfigSource(accessConfig(options.access)),
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
  const listings = options.listings ?? createListingService({ provider, taxonomy });
  return { guard, schemas, taxonomy, search, listings };
}

/** Offline AWS sources: every call fails, so the init can only end in 503. */
function offlineSources() {
  const send = rejecting(new Error('offline'));
  return {
    ssm: { send } as unknown as SSMClient,
    s3: { send } as unknown as S3Client,
    dynamo: { send } as unknown as DynamoDBDocumentClient,
  };
}

function withoutKeys(dropped: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(ENV).map(([k, v]) => [k, dropped.includes(k) ? undefined : v]),
  );
}

function apiEvent(
  route: 'search' | 'detail',
  extra: Partial<ListingsRequest> = {},
): ListingsRequest {
  return {
    resource: LISTINGS_ROUTES[route],
    ...(route === 'detail' && { pathParameters: { id: STORED_ID } }),
    requestContext: { identity: { sourceIp: SOURCE_IP } },
    ...extra,
  };
}

function apiRouter(d: ReturnType<typeof deps>) {
  return createRouter({
    [LISTINGS_ROUTES.search]: createListingsHandler(d),
    [LISTINGS_ROUTES.detail]: createListingDetailHandler(d),
  });
}

async function viaApi(
  handler: (e: ListingsRequest) => Promise<{ statusCode: number; body: string }>,
  event: ListingsRequest,
): Promise<Observed> {
  const res = await handler(event);
  const body = JSON.parse(res.body) as { errors?: unknown };
  return { errors: body.errors, status: res.statusCode };
}

let rpcId = 1;
function mcpEvent(method: string, params: Record<string, unknown>, headers = {}): McpRequest {
  return {
    httpMethod: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
    requestContext: { identity: { sourceIp: SOURCE_IP } },
  };
}

const toolCall = (name: string, args: Record<string, unknown> = {}, headers = {}) =>
  mcpEvent('tools/call', { name, arguments: args }, headers);

/** Maps any MCP response (HTTP error, tool error, JSON-RPC error) to its error entries. */
async function viaMcp(
  handler: (e: McpRequest) => Promise<{ statusCode: number; body: string }>,
  event: McpRequest,
): Promise<Observed> {
  const res = await handler(event);
  const body = JSON.parse(res.body) as {
    errors?: unknown;
    result?: { isError?: boolean; structuredContent?: { errors?: unknown } };
    error?: { message: string; data?: { code?: unknown } };
  };
  if (res.statusCode !== 200) return { errors: body.errors, status: res.statusCode };
  if (body.error !== undefined) {
    return { errors: [{ code: body.error.data?.code, message: body.error.message }] };
  }
  expect(body.result?.isError).toBe(true);
  return { errors: body.result?.structuredContent?.errors };
}

async function run(s: Scenario): Promise<Observed> {
  switch (s.kind) {
    case 'api-search-invalid':
      return viaApi(apiRouter(deps({})), apiEvent('search', { queryStringParameters: s.query }));
    case 'api-detail-invalid-id':
      return viaApi(
        apiRouter(deps({})),
        apiEvent('detail', { pathParameters: s.id === undefined ? null : { id: s.id } }),
      );
    case 'api-detail-unknown-id':
      return viaApi(apiRouter(deps({})), apiEvent('detail', { pathParameters: { id: s.id } }));
    case 'api-access': {
      const router = apiRouter(deps({ access: s.access }));
      // The first request uses up the limit of 1; it may succeed.
      if (s.access === 'rate-limited') await router(apiEvent(s.route));
      return viaApi(router, apiEvent(s.route, { headers: authHeaders(s.access, s.wrongKey) }));
    }
    case 'api-downstream': {
      const failing = rejecting(s.cause);
      const d =
        s.route === 'search'
          ? deps({ search: { search: failing } })
          : deps({ listings: { get: failing } });
      return viaApi(apiRouter(d), apiEvent(s.route));
    }
    case 'api-unknown-resource':
      return viaApi(apiRouter(deps({})), {
        ...apiEvent('search'),
        resource: s.resource,
      } as ListingsRequest);
    case 'api-init':
      return viaApi(
        createListingsHandlerFromEnv(withoutKeys(s.dropped), offlineSources()),
        apiEvent('search'),
      );
    case 'mcp-search-invalid':
      return viaMcp(createMcpHandler(deps({})), toolCall('search_listings', s.args));
    case 'mcp-detail-invalid':
      return viaMcp(createMcpHandler(deps({})), toolCall('get_listing', s.args));
    case 'mcp-detail-unknown-id':
      return viaMcp(createMcpHandler(deps({})), toolCall('get_listing', { id: s.id }));
    case 'mcp-unknown-tool':
      return viaMcp(createMcpHandler(deps({})), toolCall(s.name));
    case 'mcp-access': {
      const handler = createMcpHandler(deps({ access: s.access }));
      if (s.access === 'rate-limited') await handler(toolCall('list_property_types'));
      return viaMcp(handler, toolCall('search_listings', {}, authHeaders(s.access, s.wrongKey)));
    }
    case 'mcp-downstream': {
      const work =
        s.failure === 'hangs' ? () => new Promise<never>(() => undefined) : rejecting(s.cause);
      const d =
        s.tool === 'search_listings'
          ? deps({ search: { search: work } })
          : deps({ listings: { get: work } });
      const handler = createMcpHandler({ ...d, ...(s.failure === 'hangs' && { deadlineMs: 10 }) });
      return viaMcp(handler, toolCall(s.tool, { id: STORED_ID }));
    }
    case 'mcp-init':
      return viaMcp(
        createMcpHandlerFromEnv(withoutKeys(s.dropped), offlineSources()),
        toolCall('search_listings'),
      );
  }
}

function expectCatalogErrors({ errors, status }: Observed): void {
  expect(Array.isArray(errors)).toBe(true);
  const list = errors as { code?: unknown; message?: unknown }[];
  expect(list.length).toBeGreaterThanOrEqual(1);
  for (const error of list) {
    expect(typeof error.code === 'string' && CATALOG.has(error.code)).toBe(true);
    expect(typeof error.message).toBe('string');
    expect((error.message as string).trim()).not.toBe('');
  }
  if (status !== undefined) {
    const first = list[0]?.code as keyof typeof ERROR_HTTP_STATUS;
    expect(status).toBe(ERROR_HTTP_STATUS[first]);
  }
}

// --- Property ---------------------------------------------------------------------------------

afterEach(() => jest.restoreAllMocks());

describe('Property 8: Einheitliche Fehlerstruktur', () => {
  it('every failing Search_API or MCP_Server request returns catalog errors with a message', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        expectCatalogErrors(await run(scenario));
      }),
      RUNS,
    );
  });
});
