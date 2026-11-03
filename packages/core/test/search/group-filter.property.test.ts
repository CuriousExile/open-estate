// Feature: real-estate-platform, Property 3: Gruppenfilter ≡ Vereinigung ihrer Typen
import { createSearchService, InMemorySearchProvider, type SearchService } from '@open-estate/core';
import {
  assertValidTaxonomy,
  buildSchemas,
  parseSearchQuery,
  typeCodes,
  type Listing,
  type NestedTaxonomyConfig,
  type Taxonomy,
} from '@open-estate/shared';
import fc from 'fast-check';
import { arbListing } from '../../../shared/test/arbitraries';

/**
 * Property 3: for any valid taxonomy, listings and group g, `group=g` (with otherwise identical
 * filters) returns the same result sequence across all pages as `types` = all type codes of g;
 * and for any type set T, `types=T` returns exactly the listings whose type is in T.
 *
 * **Validates: Requirements 15.5, 15.6, 15.11**
 */

const RUNS = { numRuns: 100 };
const LOCALES = { defaultLocale: 'de', enabled: [{ locale: 'de', label: 'Deutsch' }] };

/**
 * Globally unique codes of 1–64 characters. A small alphabet with upper/lower case variants
 * yields codes that differ only in case, so the exact, case-sensitive match is exercised.
 */
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

/**
 * Valid two-level taxonomy (group → types). The first group always has a type, so listings can be
 * generated; other groups may be empty (their group filter must yield an empty result, Req 15.11).
 */
const arbTaxonomy: fc.Arbitrary<Taxonomy> = fc
  .tuple(
    fc.integer({ min: 1, max: 4 }),
    fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 4, maxLength: 4 }),
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

const arbListings = (taxonomy: Taxonomy): fc.Arbitrary<Listing[]> =>
  fc.uniqueArray(arbListing({ listingTypes: typeCodes(taxonomy) }), {
    selector: (l) => l.id,
    maxLength: 25,
  });

/** Further filters combined per AND with the taxonomy filter, plus the page size. */
const arbOtherFilters: fc.Arbitrary<Record<string, unknown>> = fc.record(
  {
    offerType: fc.constantFrom('SALE', 'RENT'),
    roomsMin: fc.integer({ min: 0, max: 99 }),
    pageSize: fc.integer({ min: 1, max: 50 }),
  },
  { requiredKeys: [] },
);

interface Scenario {
  taxonomy: Taxonomy;
  listings: Listing[];
}

const arbScenario: fc.Arbitrary<Scenario> = arbTaxonomy.chain((taxonomy) =>
  arbListings(taxonomy).map((listings) => ({ taxonomy, listings })),
);

function serviceFor({ taxonomy, listings }: Scenario): SearchService {
  return createSearchService({
    provider: new InMemorySearchProvider(listings),
    taxonomy,
    tourProviders: { providers: [] },
    defaultCurrency: 'EUR',
  });
}

/** Follows `nextPageToken` until exhausted and returns the ids of all pages in order. */
async function allIds(
  service: SearchService,
  taxonomy: Taxonomy,
  raw: Record<string, unknown>,
): Promise<string[]> {
  const schemas = buildSchemas(taxonomy, LOCALES);
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const parsed = parseSearchQuery({ ...raw, ...(pageToken && { pageToken }) }, schemas);
    if (!parsed.ok) throw new Error(`invalid query: ${JSON.stringify(parsed.error)}`);
    const result = await service.search(parsed.value, []);
    if (!result.ok) throw new Error(`search failed: ${JSON.stringify(result.error)}`);
    ids.push(...result.value.items.map((l) => l.id));
    pageToken = result.value.nextPageToken;
  } while (pageToken !== undefined);
  return ids;
}

/** Reference model: ids of listings with a type in `types`, ordered by `id ASC`. */
function expectedIds(listings: readonly Listing[], types: readonly string[]): string[] {
  return listings
    .filter((l) => types.includes(l.listingType))
    .map((l) => l.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

describe('Property 3: group filter ≡ union of its types', () => {
  it('group=g returns the same sequence as types=<all types of g> under identical filters', async () => {
    const arb = arbScenario.chain((scenario) =>
      fc.tuple(
        fc.constant(scenario),
        fc.constantFrom(...scenario.taxonomy.groups),
        arbOtherFilters,
      ),
    );
    await fc.assert(
      fc.asyncProperty(arb, async ([scenario, group, filters]) => {
        const service = serviceFor(scenario);
        const byGroup = await allIds(service, scenario.taxonomy, { ...filters, group: group.code });
        const typeOf = new Map(scenario.listings.map((l) => [l.id, l.listingType]));
        expect(byGroup.every((id) => group.types.includes(typeOf.get(id) ?? ''))).toBe(true);

        if (group.types.length === 0) {
          // A group without types matches nothing; the search still succeeds (Req 15.11).
          expect(byGroup).toEqual([]);
          return;
        }
        const byTypes = await allIds(service, scenario.taxonomy, {
          ...filters,
          types: [...group.types],
        });
        expect(byGroup).toEqual(byTypes);
      }),
      RUNS,
    );
  });

  it('types=T returns exactly the listings whose type is in T', async () => {
    const arb = arbScenario.chain((scenario) => {
      const codes = typeCodes(scenario.taxonomy);
      return fc.tuple(
        fc.constant(scenario),
        fc.shuffledSubarray(codes, { minLength: 1, maxLength: Math.min(codes.length, 50) }),
        fc.integer({ min: 1, max: 50 }),
      );
    });
    await fc.assert(
      fc.asyncProperty(arb, async ([scenario, types, pageSize]) => {
        const ids = await allIds(serviceFor(scenario), scenario.taxonomy, { types, pageSize });
        expect(ids).toEqual(expectedIds(scenario.listings, types));
      }),
      RUNS,
    );
  });
});
