// Feature: duplicate-detection, Property 5: Normalisierungsinvarianz
import fc from 'fast-check';
import { buildProfile, DEFAULT_DUPLICATE_CONFIG, ListingContent, normalizeText } from '../../src';
import {
  arbRealisticInput,
  arbVariantOptions,
  formattingVariant,
  TAXONOMY,
} from '../arbitraries/duplicates';

/**
 * For any address and texts and for any of the spelling variants of Req 3.2 — case, Unicode
 * form, whitespace, punctuation, diacritics, "ß"/"ss", street suffix spellings and the house
 * number in `address.street` instead of `address.houseNumber` (Req 1.8) — the Merkmalsprofil of
 * the rewritten content equals the profile of the original. `normalizeText` is idempotent.
 *
 * **Validates: Requirements 1.8, 3.2**
 */

const config = DEFAULT_DUPLICATE_CONFIG;
const profileOf = (input: Parameters<typeof ListingContent.parse>[0]) =>
  buildProfile(ListingContent.parse(input), { taxonomy: TAXONOMY, config });

describe('Property 5: Normalisierungsinvarianz', () => {
  it('gives the same Merkmalsprofil for every spelling of the same listing', () => {
    fc.assert(
      fc.property(arbRealisticInput(), arbVariantOptions, (input, options) => {
        const variant = formattingVariant(input, options);

        expect(profileOf(variant)).toEqual(profileOf(input));
      }),
      { numRuns: 100 },
    );
  });

  it('normalizes text idempotently', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const once = normalizeText(text);
        expect(normalizeText(once)).toBe(once);
      }),
      { numRuns: 100 },
    );
  });
});
