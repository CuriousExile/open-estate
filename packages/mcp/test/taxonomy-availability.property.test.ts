// Feature: real-estate-platform, Property 25: Taxonomie ist überall vollständig verfügbar
import fc from 'fast-check';
import {
  buildMetaDocument,
  buildOpenApiDocument,
  createListingsHandler,
  type DiscoveryInput,
} from '@open-estate/api';
import {
  createAccessGuard,
  createListingService,
  createSearchService,
  InMemoryApiKeyStore,
  InMemoryRateLimitCounterStore,
  InMemorySearchProvider,
  StaticAccessConfigSource,
} from '@open-estate/core';
import { createMcpHandler } from '@open-estate/mcp';
import {
  assertValidTaxonomy,
  buildSchemas,
  groupCodes,
  OFFER_TYPES,
  parseSearchQuery,
  typeCodes,
  type LocaleConfig,
  type NestedTaxonomyConfig,
  type Taxonomy,
} from '@open-estate/shared';

/**
 * Property 25: for any valid taxonomy, the generated API_Schema, `/meta` and `list_property_types`
 * contain exactly its group and type codes, every type code appears under exactly one group, and
 * every code is a valid filter value; the API_Schema also enumerates offer types and enabled
 * locales.
 *
 * **Validates: Requirements 3.7, 15.3, 15.9, 19.5**
 */

const RUNS = { numRuns: 100 };
const SOURCE_IP = '192.0.2.1';

/** Small alphabet with case variants, so codes differing only in case are exercised. */
const arbCode = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.string({
      unit: fc.constantFrom('a', 'A', 'b', 'B', '_'),
      minLength: 1,
      maxLength: 3,
    }),
  },
  { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 64 }) },
);

/** Valid two-level taxonomy (group → types); the first group always has a type. */
const arbTaxonomy: fc.Arbitrary<Taxonomy> = fc
  .tuple(
    fc.integer({ min: 1, max: 4 }),
    fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 4, maxLength: 4 }),
  )
  .chain(([groupCount, typeCounts]) => {
    const counts = typeCounts.slice(0, groupCount).map((n, i) => (i === 0 ? Math.max(n, 1) : n));
    const total = groupCount + counts.reduce((a, b) => a + b, 0);
    return fc
      .uniqueArray(arbCode, { minLength: total, maxLength: total })
      .map((codes): NestedTaxonomyConfig => {
        let next = groupCount;
        return {
          groups: counts.map((n, i) => ({
            code: codes[i] ?? '',
            types: codes.slice(next, (next += n)),
          })),
        };
      });
  })
  .map(assertValidTaxonomy);

const LOCALE_TAGS = ['de', 'en', 'en-GB', 'fr', 'es', 'it', 'nl', 'pt-BR'] as const;

/** Enabled locales (unique, ≥ 1) with the default among them. */
const arbLocales: fc.Arbitrary<LocaleConfig> = fc
  .uniqueArray(fc.constantFrom(...LOCALE_TAGS), { minLength: 1, maxLength: LOCALE_TAGS.length })
  .chain((tags) =>
    fc.constantFrom(...tags).map((defaultLocale) => ({
      defaultLocale,
      enabled: tags.map((locale) => ({ locale, label: `Label ${locale}` })),
    })),
  );

interface Groups {
  groups: { code: string; types: string[] }[];
}

const sorted = (values: Iterable<string>) => [...values].sort();

/** Exactly the taxonomy's groups, in order, each type under exactly one (its own) group. */
function expectSameGroups(actual: Groups, taxonomy: Taxonomy): void {
  expect(actual.groups.map((g) => g.code)).toEqual(groupCodes(taxonomy));
  const owners = new Map<string, string[]>();
  for (const g of actual.groups) {
    for (const t of g.types) owners.set(t, [...(owners.get(t) ?? []), g.code]);
  }
  expect(sorted(owners.keys())).toEqual(sorted(typeCodes(taxonomy)));
  for (const g of taxonomy.groups) {
    for (const t of g.types) expect(owners.get(t)).toEqual([g.code]);
  }
}

interface Param {
  name: string;
  in: string;
  schema: { items?: { enum?: string[] } };
  'x-enabled-locales'?: string[];
}

function expectOpenApiEnums(input: DiscoveryInput, taxonomy: Taxonomy, locales: LocaleConfig) {
  const doc = JSON.parse(JSON.stringify(buildOpenApiDocument(input))) as {
    paths: Record<string, { get?: { parameters?: Param[] } }>;
    components: { schemas: Record<string, { enum?: string[]; default?: string }> };
  };
  const groups = sorted(groupCodes(taxonomy));
  const types = sorted(typeCodes(taxonomy));
  const enabled = sorted(locales.enabled.map((l) => l.locale));
  const { schemas } = doc.components;

  expect(sorted(schemas['PropertyGroup']?.enum ?? [])).toEqual(groups);
  expect(sorted(schemas['ListingType']?.enum ?? [])).toEqual(types);
  expect(sorted(schemas['OfferType']?.enum ?? [])).toEqual(sorted(OFFER_TYPES));
  expect(sorted(schemas['EnabledLocale']?.enum ?? [])).toEqual(enabled);
  expect(schemas['EnabledLocale']?.default).toBe(locales.defaultLocale);

  const params = Object.fromEntries(
    (doc.paths['/listings']?.get?.parameters ?? []).map((p) => [p.name, p]),
  );
  expect(sorted(params['group']?.schema.items?.enum ?? [])).toEqual(groups);
  expect(sorted(params['types']?.schema.items?.enum ?? [])).toEqual(types);
  expect(sorted(params['lang']?.['x-enabled-locales'] ?? [])).toEqual(enabled);
}

function setup(taxonomy: Taxonomy, locales: LocaleConfig) {
  const schemas = buildSchemas(taxonomy, locales);
  const provider = new InMemorySearchProvider([]);
  const guard = createAccessGuard({
    config: new StaticAccessConfigSource({
      mode: 'open',
      rateLimit: { requests: 1_000_000, windowSeconds: 60 },
    }),
    apiKeys: new InMemoryApiKeyStore([]),
    counters: new InMemoryRateLimitCounterStore(),
    clock: () => 0,
  });
  const search = createSearchService({
    provider,
    taxonomy,
    tourProviders: { providers: [] },
    defaultCurrency: 'EUR',
  });
  const mcp = createMcpHandler({
    guard,
    schemas,
    taxonomy,
    search,
    listings: createListingService({ provider, taxonomy }),
  });
  const api = createListingsHandler({ guard, schemas, search });
  const requestContext = { identity: { sourceIp: SOURCE_IP } };

  async function listPropertyTypes(): Promise<Groups> {
    const res = await mcp({
      httpMethod: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_property_types', arguments: {} },
      }),
      requestContext,
    });
    expect(res.statusCode).toBe(200);
    const result = (JSON.parse(res.body) as { result: Record<string, unknown> }).result;
    expect(result['isError']).toBeFalsy();
    return result['structuredContent'] as Groups;
  }

  async function apiStatus(query: Record<string, string>): Promise<number> {
    const res = await api({ queryStringParameters: query, requestContext });
    return res.statusCode;
  }

  return { schemas, listPropertyTypes, apiStatus };
}

describe('Property 25: Taxonomie ist überall vollständig verfügbar', () => {
  it('API_Schema, /meta and list_property_types expose exactly the taxonomy; every code filters', async () => {
    await fc.assert(
      fc.asyncProperty(arbTaxonomy, arbLocales, async (taxonomy, locales) => {
        const { schemas, listPropertyTypes, apiStatus } = setup(taxonomy, locales);
        const input: DiscoveryInput = {
          schemas,
          taxonomy,
          locales,
          defaultCurrency: 'EUR',
          tourProviders: { providers: [] },
        };

        expectOpenApiEnums(input, taxonomy, locales);
        const meta = buildMetaDocument(input);
        expectSameGroups(meta.taxonomy, taxonomy);
        expect(sorted(meta.offerTypes)).toEqual(sorted(OFFER_TYPES));
        expectSameGroups(await listPropertyTypes(), taxonomy);

        for (const group of groupCodes(taxonomy)) {
          expect(parseSearchQuery({ group }, schemas).ok).toBe(true);
          expect(await apiStatus({ group })).toBe(200);
        }
        for (const type of typeCodes(taxonomy)) {
          expect(parseSearchQuery({ types: [type] }, schemas).ok).toBe(true);
          expect(await apiStatus({ types: type })).toBe(200);
        }
      }),
      RUNS,
    );
  });
});
