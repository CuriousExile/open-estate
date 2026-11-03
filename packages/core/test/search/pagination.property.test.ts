// Feature: real-estate-platform, Property 4: Seitengröße und Folgeseiten-Verweis
import { createSearchService, InMemorySearchProvider, searchQueryHash } from '@open-estate/core';
import {
  assertValidTaxonomy,
  buildSchemas,
  decodeCursor,
  DEFAULT_TAXONOMY_CONFIG,
  parseSearchQuery,
  type Listing,
  type SearchQuery,
} from '@open-estate/shared';
import fc from 'fast-check';
import { arbListing } from '../../../shared/test/arbitraries';

/**
 * Property 4: for any set of listings, any optional `offerType` filter (so the hit set is a
 * subset) and any `pageSize` ∈ [1, 50] or none (default 20), paging through the SearchService
 * yields pages of at most `pageSize` listings, and `nextPageToken` is present exactly when
 * matching listings remain undelivered. Each token is bound to the query hash.
 *
 * **Validates: Requirements 1.5, 1.6, 1.7**
 */

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const schemas = buildSchemas(taxonomy, {
  defaultLocale: 'de',
  enabled: [{ locale: 'de', label: 'Deutsch' }],
});

function parse(raw: Record<string, unknown>): SearchQuery {
  const parsed = parseSearchQuery(raw, schemas);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}

// Unique ids; up to 70 listings so the default page size (20) regularly needs several pages.
// `size: 'max'` lifts fast-check's default length cap (~10), which would never exceed 20.
const arbListings = fc.uniqueArray(arbListing(), {
  maxLength: 70,
  size: 'max',
  selector: (l) => l.id,
});

const arbFilter = fc.option(fc.constantFrom('SALE', 'RENT'), { nil: undefined });

// `undefined` = no pageSize given; small sizes are over-represented to get many pages.
const arbPageSize = fc.option(
  fc.oneof(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 50 })),
  { nil: undefined },
);

const matches = (listing: Listing, offerType: string | undefined): boolean =>
  offerType === undefined || listing.offers.some((o) => o.offerType === offerType);

describe('Property 4: Seitengröße und Folgeseiten-Verweis', () => {
  it('pages hold at most pageSize listings and nextPageToken ⇔ undelivered hits remain', async () => {
    await fc.assert(
      fc.asyncProperty(arbListings, arbFilter, arbPageSize, async (listings, offerType, size) => {
        const service = createSearchService({
          provider: new InMemorySearchProvider(listings),
          taxonomy,
          tourProviders: { providers: [] },
          defaultCurrency: 'EUR',
        });
        const raw: Record<string, unknown> = {
          ...(offerType !== undefined && { offerType }),
          ...(size !== undefined && { pageSize: size }),
        };
        const first = parse(raw);
        const expectedSize = size ?? 20;
        expect(first.pageSize).toBe(expectedSize);

        const hash = searchQueryHash(first);
        const total = listings.filter((l) => matches(l, offerType)).length;
        const delivered = new Set<string>();
        let pageToken: string | undefined;

        // Each non-final page delivers ≥ 1 listing, so total + 1 iterations bound the loop.
        for (let page = 0; page <= total; page++) {
          const query = pageToken === undefined ? first : parse({ ...raw, pageToken });
          const result = await service.search(query, []);
          if (!result.ok) throw new Error(JSON.stringify(result.error));
          const { items, nextPageToken } = result.value;

          expect(items.length).toBeLessThanOrEqual(expectedSize);
          for (const item of items) delivered.add(item.id);

          expect(nextPageToken !== undefined).toBe(delivered.size < total);
          if (nextPageToken === undefined) break;
          expect(decodeCursor(nextPageToken, hash).ok).toBe(true);
          pageToken = nextPageToken;
        }

        expect(delivered.size).toBe(total);
      }),
      { numRuns: 100 },
    );
  });
});
