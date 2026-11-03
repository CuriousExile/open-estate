// Feature: real-estate-platform, Property 39: MCP/API-Äquivalenz — For any Bestand und for any Eingabe (gültig oder ungültig) für Suche bzw. Detailabruf liefern search_listings/get_listing und GET /listings/GET /listings/{id} mit identischen Parametern dieselben Listings in derselben Reihenfolge, dieselben Feldwerte, Sprachauswahl und Paginierungsangaben bzw. dieselben Fehlercodes und Felder (inkl. NOT_FOUND).
import fc from 'fast-check';
import { createListingDetailHandler, createListingsHandler } from '@open-estate/api';
import {
  createAccessGuard,
  createListingService,
  createSearchService,
  InMemoryApiKeyStore,
  InMemoryRateLimitCounterStore,
  InMemorySearchProvider,
  StaticAccessConfigSource,
  type AccessConfig,
} from '@open-estate/core';
import { createMcpHandler } from '@open-estate/mcp';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  groupCodes,
  typeCodes,
  type ApiError,
  type Listing,
  type Offer,
} from '@open-estate/shared';
import { arbListing, LOCALE_POOL } from '../../shared/test/arbitraries/listing';

/**
 * API and MCP adapters over the same in-memory stock answer the same parameters with the same
 * body: success → `structuredContent` deep-equals the API JSON (items, order, field values,
 * `deliveredLocale`, `nextPageToken`, also on the following pages); failure → `isError` and the
 * same multiset of `(code, field, details)` as the API `errors` (incl. `NOT_FOUND`, `INVALID_ID`).
 *
 * Encoding of "the same parameters" (one generated value, two encodings):
 * - API: everything as query strings like API Gateway delivers them — numbers via `String(n)`,
 *   booleans as `"true"`/`"false"`, lists as repeated parameters (`multiValueQueryStringParameters`,
 *   last value also in `queryStringParameters`); detail `id` percent-encoded in the path.
 * - MCP: the types of the tool input schema — `pageSize`/`roomsMin`/`roomsMax` as numbers,
 *   `hasTour` as boolean, `group`/`types` as arrays, money/area as decimal strings.
 * - Ill-typed values (e.g. `pageSize: "ten"`) are the same string on both sides, since a query
 *   string cannot carry anything else. Language only via `lang` (MCP has no `Accept-Language`).
 *
 * **Validates: Requirements 19.3, 19.4, 19.6, 19.8**
 */

const RUNS = { numRuns: 100 };
/** Follow-up pages compared per successful search. */
const MAX_FOLLOW_PAGES = 3;

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const schemas = buildSchemas(taxonomy, {
  defaultLocale: 'de',
  enabled: [
    { locale: 'de', label: 'Deutsch' },
    { locale: 'en', label: 'English' },
  ],
});
const GROUPS = groupCodes(taxonomy);
const TYPES = typeCodes(taxonomy);

const OPEN: AccessConfig = { mode: 'open', rateLimit: { requests: 1_000_000, windowSeconds: 60 } };
const SOURCE_IP = '192.0.2.1';
const TOUR_HOST = 'tour.example';
const CITIES = ['Berlin', 'berlin', 'BERLIN', 'München', 'Köln'] as const;
const POSTAL_CODES = ['10115', '80331', '50667'] as const;
const CURRENCIES = ['EUR', 'USD'] as const;

// ---------------------------------------------------------------------------------------------
// Stock: generated listings with a small pool of filterable values, so filters actually match
// ---------------------------------------------------------------------------------------------

const arbStoredListing: fc.Arbitrary<Listing> = fc
  .tuple(
    arbListing(),
    fc.constantFrom(...CITIES),
    fc.constantFrom(...POSTAL_CODES),
    fc.constantFrom(...CURRENCIES),
    fc.boolean(),
  )
  .map(([listing, city, postalCode, currency, allowedTour]) => ({
    ...listing,
    address: { ...listing.address, city, postalCode },
    offers: listing.offers.map((o): Offer => ({ ...o, currency })),
    tours: listing.tours.map((t, i) =>
      allowedTour ? { ...t, url: `https://${TOUR_HOST}/t/${i}` } : t,
    ),
  }));

const arbStock = fc.uniqueArray(arbStoredListing, {
  maxLength: 12,
  selector: (l) => l.id,
});

// ---------------------------------------------------------------------------------------------
// Parameters: one generated value, encoded for API (query strings) and MCP (typed arguments)
// ---------------------------------------------------------------------------------------------

/** One parameter value in both encodings. */
interface Param {
  api: string | string[];
  mcp: unknown;
}

const same = (value: string): Param => ({ api: value, mcp: value });
const num = (value: number): Param => ({ api: String(value), mcp: value });
const bool = (value: boolean): Param => ({ api: String(value), mcp: value });
const list = (values: string[]): Param => ({ api: values, mcp: values });

const arbDecimal = (maxWhole: number): fc.Arbitrary<string> =>
  fc
    .tuple(fc.integer({ min: 0, max: maxWhole }), fc.option(fc.integer({ min: 0, max: 99 })))
    .map(([whole, cents]) => (cents === null ? `${whole}` : `${whole}.${cents}`));

const validMoney = fc
  .oneof(arbDecimal(2_000_000), fc.constantFrom('0.01', '999999999.99'))
  .map(same);
const invalidMoney = fc.constantFrom('0', '-5', '1.234', '1e3', 'abc', '1000000000').map(same);
const validArea = fc.oneof(arbDecimal(300), fc.constantFrom('1', '100000')).map(same);
const invalidArea = fc.constantFrom('0.5', '100000.01', 'x').map(same);
const validRooms = fc.integer({ min: 0, max: 199 }).map((n) => num(n / 2));
const invalidRooms = fc.oneof(fc.constantFrom(0.3, -1, 100).map(num), fc.constant(same('three')));
const validLang = fc.constantFrom('de', 'en', ...LOCALE_POOL).map(same);
const invalidLang = fc.constantFrom('', 'not a tag', 'x'.repeat(36)).map(same);

/** Values each field accepts on its own (cross-field rules can still fail, e.g. group + types). */
const VALID: Record<string, fc.Arbitrary<Param>> = {
  priceMin: validMoney,
  priceMax: validMoney,
  currency: fc.constantFrom(...CURRENCIES).map(same),
  roomsMin: validRooms,
  roomsMax: validRooms,
  areaMin: validArea,
  areaMax: validArea,
  city: fc.constantFrom(...CITIES).map(same),
  postalCode: fc.constantFrom(...POSTAL_CODES).map(same),
  group: fc.constantFrom(...GROUPS).map((g) => list([g])),
  types: fc.shuffledSubarray([...TYPES], { minLength: 1, maxLength: 3 }).map(list),
  hasTour: fc.boolean().map(bool),
  lang: validLang,
};

/** Values each field rejects (type, format, range, count, unknown code). */
const INVALID: Record<string, fc.Arbitrary<Param>> = {
  offerType: fc.constantFrom('sale', 'LEASE').map(same),
  priceMin: invalidMoney,
  priceMax: invalidMoney,
  currency: fc.constant(same('eur')),
  roomsMin: invalidRooms,
  roomsMax: invalidRooms,
  areaMin: invalidArea,
  areaMax: invalidArea,
  city: fc.constantFrom('', 'c'.repeat(201)).map(same),
  postalCode: fc.constantFrom('', '12345678901').map(same),
  group: fc.oneof(
    fc.constant(list(['no_such_group'])),
    fc.shuffledSubarray([...GROUPS], { minLength: 2, maxLength: 2 }).map(list),
  ),
  types: fc.oneof(
    fc.constant(list([''])),
    fc.constantFrom(...TYPES).map((t) => list([t, 'no_such_type'])),
  ),
  hasTour: fc.constant(same('yes')),
  lang: invalidLang,
  pageSize: fc.oneof(fc.constantFrom(0, 51, 2.5).map(num), fc.constant(same('ten'))),
  // Valid tokens come from following `nextPageToken`; generated ones are garbage.
  pageToken: fc
    .oneof(fc.string({ minLength: 1, maxLength: 20 }), fc.constantFrom('', 'x'.repeat(1025)))
    .map(same),
};

/** Values of the chosen fields, generated independently. */
function fieldValues(
  fields: readonly string[],
  arbs: Record<string, fc.Arbitrary<Param>>,
): fc.Arbitrary<Record<string, Param>> {
  return fc
    .tuple(...fields.map((f) => arbs[f] as fc.Arbitrary<Param>))
    .map((values) => Object.fromEntries(fields.map((f, i) => [f, values[i] as Param])));
}

/**
 * A few valid filters (offerType mostly set, so price filters usually apply) and a small page
 * size so that paging happens; in about 40 % of the cases one or two fields are made invalid.
 */
const arbSearchParams: fc.Arbitrary<Record<string, Param>> = fc
  .tuple(
    fc.option(fc.constantFrom('SALE', 'RENT').map(same), { freq: 4 }),
    fc.option(fc.integer({ min: 1, max: 5 }).map(num), { freq: 5 }),
    fc.subarray(Object.keys(VALID), { maxLength: 4 }),
    fc.oneof(
      { arbitrary: fc.constant([]), weight: 3 },
      { arbitrary: fc.subarray(Object.keys(INVALID), { minLength: 1, maxLength: 2 }), weight: 2 },
    ),
  )
  .chain(([offerType, pageSize, validFields, invalidFields]) =>
    fc
      .tuple(fieldValues(validFields, VALID), fieldValues(invalidFields, INVALID))
      .map(([valid, invalid]) => ({
        ...(offerType !== null && { offerType }),
        ...(pageSize !== null && { pageSize }),
        ...valid,
        ...invalid,
      })),
  );

const arbLang = fc.oneof({ arbitrary: validLang, weight: 4 }, invalidLang);

function arbDetailParams(stock: readonly Listing[]): fc.Arbitrary<{ id: string; lang?: Param }> {
  const ids = stock.map((l) => l.id);
  const arbId = fc.oneof(
    ...(ids.length > 0 ? [{ arbitrary: fc.constantFrom(...ids), weight: 4 }] : []),
    { arbitrary: fc.string({ minLength: 1, maxLength: 20 }), weight: 1 },
    { arbitrary: fc.constantFrom('', 'i'.repeat(129)), weight: 1 },
  );
  return fc.record({ id: arbId, lang: arbLang }, { requiredKeys: ['id'] });
}

type Request =
  | { kind: 'search'; params: Record<string, Param> }
  | { kind: 'detail'; params: { id: string; lang?: Param } };

const arbScenario = arbStock.chain((stock) =>
  fc.tuple(
    fc.constant(stock),
    fc.array(
      fc.oneof(
        arbSearchParams.map((params): Request => ({ kind: 'search', params })),
        arbDetailParams(stock).map((params): Request => ({ kind: 'detail', params })),
      ),
      { minLength: 1, maxLength: 3 },
    ),
  ),
);

/** API Gateway REST shape: all values in the multi-value map, the last one in the single map. */
function apiQuery(params: Record<string, Param>) {
  const single: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  for (const [key, { api }] of Object.entries(params)) {
    const values = typeof api === 'string' ? [api] : api;
    multi[key] = values;
    single[key] = values[values.length - 1] ?? '';
  }
  return { queryStringParameters: single, multiValueQueryStringParameters: multi };
}

function mcpArgs(params: Record<string, Param>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).map(([key, { mcp }]) => [key, mcp]));
}

// ---------------------------------------------------------------------------------------------
// Both adapters over one stock
// ---------------------------------------------------------------------------------------------

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

interface Answer {
  ok: boolean;
  body: Record<string, unknown>;
}

function setup(stock: readonly Listing[]) {
  const provider = new InMemorySearchProvider(stock);
  const guard = createAccessGuard({
    config: new StaticAccessConfigSource(OPEN),
    apiKeys: new InMemoryApiKeyStore([]),
    counters: new InMemoryRateLimitCounterStore(),
    clock: () => 0,
  });
  const search = createSearchService({
    provider,
    taxonomy,
    tourProviders: { providers: [{ code: 'tours', hostnames: [TOUR_HOST] }] },
    defaultCurrency: 'EUR',
  });
  const listings = createListingService({ provider, taxonomy });
  const mcp = createMcpHandler({ guard, schemas, taxonomy, search, listings });
  const apiSearch = createListingsHandler({ guard, schemas, search });
  const apiDetail = createListingDetailHandler({ guard, schemas, listings });
  const requestContext = { identity: { sourceIp: SOURCE_IP } };
  let rpcId = 1;

  async function callTool(name: string, args: Record<string, unknown>): Promise<Answer> {
    const res = await mcp({
      httpMethod: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId++,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
      requestContext,
    });
    expect(res.statusCode).toBe(200);
    const tool = (JSON.parse(res.body) as { result: ToolResult }).result;
    return { ok: tool.isError !== true, body: tool.structuredContent ?? {} };
  }

  function answer(res: { statusCode: number; body: string }): Answer {
    return {
      ok: res.statusCode === 200,
      body: JSON.parse(res.body) as Record<string, unknown>,
    };
  }

  return {
    search: async (params: Record<string, Param>) => ({
      api: answer(await apiSearch({ ...apiQuery(params), requestContext })),
      mcp: await callTool('search_listings', mcpArgs(params)),
    }),
    detail: async ({ id, lang }: { id: string; lang?: Param }) => {
      const query = lang === undefined ? {} : { lang };
      return {
        api: answer(
          await apiDetail({
            resource: '/listings/{id}',
            pathParameters: { id: encodeURIComponent(id) },
            ...apiQuery(query),
            requestContext,
          }),
        ),
        mcp: await callTool('get_listing', { id, ...mcpArgs(query) }),
      };
    },
  };
}

/** Order-insensitive comparable form of an error list: code, field and details. */
function errorKeys(body: Record<string, unknown>): string[] {
  const errors = (body['errors'] ?? []) as ApiError[];
  return errors.map((e) => JSON.stringify([e.code, e.field ?? null, e.details ?? null])).sort();
}

function expectEquivalent({ api, mcp }: { api: Answer; mcp: Answer }): void {
  expect(mcp.ok).toBe(api.ok);
  if (api.ok) {
    expect(mcp.body).toEqual(api.body);
    return;
  }
  // No listing data on errors: the tool result carries only `errors`.
  expect(Object.keys(mcp.body)).toEqual(['errors']);
  expect(errorKeys(mcp.body).length).toBeGreaterThan(0);
  expect(errorKeys(mcp.body)).toEqual(errorKeys(api.body));
}

describe('Property 39: MCP/API-Äquivalenz', () => {
  it('search_listings/get_listing answer like GET /listings and GET /listings/{id}', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async ([stock, requests]) => {
        const adapters = setup(stock);
        for (const request of requests) {
          if (request.kind === 'detail') {
            expectEquivalent(await adapters.detail(request.params));
            continue;
          }
          let params = request.params;
          let answers = await adapters.search(params);
          expectEquivalent(answers);
          // Follow the cursor on both sides with otherwise identical parameters.
          for (let page = 0; page < MAX_FOLLOW_PAGES; page++) {
            const token = answers.api.ok ? answers.api.body['nextPageToken'] : undefined;
            if (typeof token !== 'string') break;
            params = { ...params, pageToken: same(token) };
            answers = await adapters.search(params);
            expect(answers.api.ok).toBe(true);
            expectEquivalent(answers);
          }
        }
      }),
      RUNS,
    );
  });
});
