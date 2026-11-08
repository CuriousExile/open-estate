// Feature: duplicate-detection, Property 6: Eigenschaften der Bewertung
import fc from 'fast-check';
import {
  buildProfile,
  DEFAULT_DUPLICATE_CONFIG,
  ListingContent,
  MATCH_REASONS,
  publicDetailUrl,
  scoreMatch,
  type ListingContentInput,
} from '../../src';
import { arbRealisticInput, TAXONOMY } from '../arbitraries/duplicates';

/**
 * For any pair of listings `scoreMatch(a, b)` equals `scoreMatch(b, a)`, repeated calls give the
 * same result, the value lies in [0, 1] and every reason comes from the catalog. The result does
 * not depend on anything outside the Listing_Inhalt: neither on the listing id (which decides the
 * derived Öffentliche_Detail_URL as source URL) nor on the order of media or Sprachfassungen
 * (Req 3.1).
 *
 * **Validates: Requirements 3.1, 3.7, 3.10**
 */

const config = DEFAULT_DUPLICATE_CONFIG;
const ORIGIN = 'https://portal.example';

const profileOf = (input: ListingContentInput, listingId?: string) =>
  buildProfile(ListingContent.parse(input), {
    taxonomy: TAXONOMY,
    config,
    ...(listingId !== undefined && { derivedSourceUrl: publicDetailUrl(ORIGIN, listingId) }),
  });

/** Same content, but stored with a derived source URL and shuffled lists. */
function reshaped(input: ListingContentInput, listingId: string): ListingContentInput {
  return {
    ...input,
    sourceUrl: publicDetailUrl(ORIGIN, listingId),
    media: [...input.media].reverse(),
    translations: [...input.translations].reverse(),
  };
}

describe('Property 6: Eigenschaften der Bewertung', () => {
  it('is symmetric, deterministic, bounded and independent of non-content data', () => {
    fc.assert(
      fc.property(
        arbRealisticInput(),
        arbRealisticInput(),
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (first, second, idA, idB) => {
          const a = profileOf(first);
          const b = profileOf(second);
          const forward = scoreMatch(a, b, config);
          const backward = scoreMatch(b, a, config);

          // Symmetric and deterministic.
          expect(backward.score).toBe(forward.score);
          expect(backward.duplicate).toBe(forward.duplicate);
          expect(backward.reasons).toEqual(forward.reasons);
          expect(scoreMatch(a, b, config)).toEqual(forward);

          // Bounded, with reasons from the catalog in catalog order.
          expect(forward.score).toBeGreaterThanOrEqual(0);
          expect(forward.score).toBeLessThanOrEqual(1);
          for (const reason of forward.reasons) expect(MATCH_REASONS).toContain(reason);
          const order = forward.reasons.map((reason) => MATCH_REASONS.indexOf(reason));
          expect([...order].sort((x, y) => x - y)).toEqual(order);

          // Independent of the listing id (derived source URL) and of list order.
          const derivedA = profileOf(reshaped(first, idA), idA);
          const derivedB = profileOf(reshaped(second, idB), idB);
          const derived = scoreMatch(derivedA, derivedB, config);
          const withoutSourceUrl = scoreMatch(
            profileOf({ ...first, sourceUrl: publicDetailUrl(ORIGIN, 'x') }, 'x'),
            profileOf({ ...second, sourceUrl: publicDetailUrl(ORIGIN, 'y') }, 'y'),
            config,
          );
          expect(derived).toEqual(withoutSourceUrl);
        },
      ),
      { numRuns: 100 },
    );
  });
});
