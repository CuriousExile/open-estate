// Feature: duplicate-detection, Property 8: Exakt_Duplikat
import fc from 'fast-check';
import {
  buildProfile,
  DEFAULT_DUPLICATE_CONFIG,
  ListingContent,
  publicDetailUrl,
  scoreMatch,
  type ListingContentInput,
} from '../../src';
import {
  arbRealisticInput,
  arbVariantOptions,
  formattingVariant,
  TAXONOMY,
} from '../arbitraries/duplicates';

/**
 * A copy of a listing that differs only in data outside the Listing_Inhalt (listing id and with
 * it the derived Öffentliche_Detail_URL as source URL), in the order of media and
 * Sprachfassungen, or in one of the spellings of Req 3.2 scores 1 with the single reason
 * `EXACT`. Two listings with an extra medium or another area are not Exakt_Duplikate, even
 * though they may still be duplicates.
 *
 * **Validates: Requirements 3.6**
 */

const config = DEFAULT_DUPLICATE_CONFIG;
const ORIGIN = 'https://portal.example';

const profileOf = (input: ListingContentInput, listingId?: string) =>
  buildProfile(ListingContent.parse(input), {
    taxonomy: TAXONOMY,
    config,
    ...(listingId !== undefined && { derivedSourceUrl: publicDetailUrl(ORIGIN, listingId) }),
  });

describe('Property 8: Exakt_Duplikat', () => {
  it('scores 1 with reason EXACT for a copy that differs only in spelling or non-content data', () => {
    fc.assert(
      fc.property(
        arbRealisticInput(),
        arbVariantOptions,
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (input, options, idA, idB) => {
          const original: ListingContentInput = {
            ...input,
            sourceUrl: publicDetailUrl(ORIGIN, idA),
          };
          const copy: ListingContentInput = {
            ...formattingVariant(input, options),
            sourceUrl: publicDetailUrl(ORIGIN, idB),
            translations: [...input.translations].reverse(),
          };

          const result = scoreMatch(profileOf(original, idA), profileOf(copy, idB), config);

          expect(result).toEqual({ duplicate: true, score: 1, reasons: ['EXACT'] });
        },
      ),
      { numRuns: 100 },
    );
  });

  it('does not call a listing with a changed Inhaltsfeld an Exakt_Duplikat', () => {
    fc.assert(
      fc.property(arbRealisticInput(), (input) => {
        const a = profileOf(input);
        const changed = profileOf({
          ...input,
          area: `${Number.parseInt(input.area as string, 10) + 1}.00`,
        });
        const withMedium = profileOf({
          ...input,
          media: [...input.media, { url: 'https://cdn.example/img/999.jpg' }],
        });

        expect(a.exactKey).not.toBe(changed.exactKey);
        expect(a.exactKey).not.toBe(withMedium.exactKey);
      }),
      { numRuns: 100 },
    );
  });
});
