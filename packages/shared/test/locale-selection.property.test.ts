// Feature: real-estate-platform, Property 26: Sprachauswahl der API
import fc from 'fast-check';
import {
  assertValidTaxonomy,
  DEFAULT_TAXONOMY_CONFIG,
  resolvePreferences,
  selectLocalizedVersion,
  serialize,
  type Listing,
  type LocalePreference,
  type LocaleRequest,
  type LocalizedVersion,
} from '../src';
import { arbListing, LOCALE_POOL } from './arbitraries';

/**
 * Model-based test of the language selection against an independent reference model.
 * Search_API and MCP_Server both use `resolvePreferences` + `selectLocalizedVersion` + `serialize`,
 * so this property also covers "MCP selects the same language version" (Req 19.4).
 *
 * **Validates: Requirements 3.8, 14.3, 14.4, 14.5, 14.7, 14.8, 14.10, 19.4**
 */

const RUNS = { numRuns: 100 };
const TAXONOMY = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);

// ---------------------------------------------------------------------------------------------
// Reference model (direct specification implementation)
// ---------------------------------------------------------------------------------------------

function originalOf(listing: Listing): LocalizedVersion {
  return {
    title: listing.title,
    description: listing.description,
    deliveredLocale: listing.originalLocale,
  };
}

function translationsOf(listing: Listing): LocalizedVersion[] {
  return listing.translations.map((t) => ({
    title: t.title,
    description: t.description,
    deliveredLocale: t.locale,
  }));
}

/** All language versions of a listing; generated listings have case-insensitively unique locales. */
function versionsOf(listing: Listing): LocalizedVersion[] {
  return [originalOf(listing), ...translationsOf(listing)];
}

const language = (tag: string): string => (tag.split('-')[0] ?? '').toLowerCase();

/** Req 14.3–14.5: per preference exact (case-insensitive), then same primary subtag, else original. */
function expectedVersion(listing: Listing, tags: readonly string[]): LocalizedVersion {
  const original = originalOf(listing);
  const translations = translationsOf(listing);
  for (const tag of tags) {
    const exact = [original, ...translations].find(
      (v) => v.deliveredLocale.toLowerCase() === tag.toLowerCase(),
    );
    if (exact) return exact;
    if (language(original.deliveredLocale) === language(tag)) return original;
    const [smallest] = translations
      .filter((v) => language(v.deliveredLocale) === language(tag))
      .sort((a, b) => {
        const [la, lb] = [a.deliveredLocale.toLowerCase(), b.deliveredLocale.toLowerCase()];
        return la === lb ? 0 : la < lb ? -1 : 1;
      });
    if (smallest) return smallest;
  }
  return original;
}

interface HeaderEntry {
  tag: string;
  /** Weight in thousandths (0 = discarded). */
  q: number;
}

/** Tags of the header entries in evaluation order: q > 0, q descending, ties in appearance order. */
function expectedHeaderTags(entries: readonly HeaderEntry[]): string[] {
  const kept = entries.filter((e) => e.q > 0);
  const weights = [...new Set(kept.map((e) => e.q))].sort((a, b) => b - a);
  return weights.flatMap((q) => kept.filter((e) => e.q === q).map((e) => e.tag));
}

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

/** Same tag with randomly mixed upper/lower case per character. */
const arbMixedCase = (tag: string): fc.Arbitrary<string> =>
  fc
    .array(fc.boolean(), { minLength: tag.length, maxLength: tag.length })
    .map((upper) =>
      [...tag].map((c, i) => (upper[i] ? c.toUpperCase() : c.toLowerCase())).join(''),
    );

/** Languages/regions not in LOCALE_POOL; some share a primary subtag with pool entries. */
const OTHER_TAGS = [
  'ko',
  'ar',
  'hu',
  'he-IL',
  'ko-KR',
  'de-LU',
  'en-AU',
  'pt-PT',
  'fr-BE',
  'sr-Cyrl',
  'zh-CN',
];
const PRIMARY_SUBTAGS = [...new Set(LOCALE_POOL.map(language))];

/** Valid preference tags, biased towards the listing's own locales and their languages. */
function arbTag(listing: Listing): fc.Arbitrary<string> {
  const own = versionsOf(listing).map((v) => v.deliveredLocale);
  return fc
    .oneof(
      fc.constantFrom(...own),
      // Same primary subtag as an own locale, but a region no listing has → subtag fallback.
      fc.constantFrom(...own).map((locale) => `${language(locale)}-ZZ`),
      fc.constantFrom(...LOCALE_POOL),
      fc.constantFrom(...PRIMARY_SUBTAGS),
      fc.constantFrom(...OTHER_TAGS),
    )
    .chain(arbMixedCase);
}

function arbHeaderEntries(listing: Listing): fc.Arbitrary<HeaderEntry[]> {
  return fc.array(fc.record({ tag: arbTag(listing), q: fc.integer({ min: 0, max: 1000 }) }), {
    maxLength: 6,
  });
}

/** Accept-Language header in the format `tag;q=x` (q = 1 also written without parameter). */
function arbHeader(listing: Listing): fc.Arbitrary<{ header: string; entries: HeaderEntry[] }> {
  return arbHeaderEntries(listing).chain((entries) =>
    fc
      .array(fc.boolean(), { minLength: entries.length, maxLength: entries.length })
      .map((omitQ) => ({
        entries,
        header: entries
          .map((e, i) =>
            e.q === 1000 && omitQ[i] ? e.tag : `${e.tag};q=${(e.q / 1000).toFixed(3)}`,
          )
          .join(', '),
      })),
  );
}

/** Any request: lang, Accept-Language, both or neither. */
function arbRequest(listing: Listing): fc.Arbitrary<LocaleRequest> {
  return fc.record(
    {
      lang: arbTag(listing),
      acceptLanguage: fc.oneof(
        arbHeader(listing).map((h) => h.header),
        fc.string(),
      ),
    },
    { requiredKeys: [] },
  );
}

const arbListingWithTags = arbListing().chain((listing) =>
  fc.tuple(fc.constant(listing), fc.array(arbTag(listing), { maxLength: 5 })),
);

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function preferences(req: LocaleRequest): LocalePreference[] {
  const result = resolvePreferences(req);
  if (!result.ok) throw new Error(`unexpected error for ${JSON.stringify(req)}`);
  return result.value;
}

/** Invariants: delivered locale exists and title/description come from that same version. */
function expectFromExistingVersion(listing: Listing, selected: LocalizedVersion): void {
  const source = versionsOf(listing).find((v) => v.deliveredLocale === selected.deliveredLocale);
  expect(source).toBeDefined();
  expect(selected).toEqual(source);
}

const prefsOf = (tags: readonly string[]): LocalePreference[] => tags.map((tag) => ({ tag, q: 1 }));

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

describe('Property 26: Sprachauswahl der API', () => {
  it('matches the reference model for any preference list and is deterministic', () => {
    fc.assert(
      fc.property(arbListingWithTags, ([listing, tags]) => {
        const selected = selectLocalizedVersion(listing, prefsOf(tags));
        expect(selected).toEqual(expectedVersion(listing, tags));
        expectFromExistingVersion(listing, selected);
        expect(selectLocalizedVersion(structuredClone(listing), prefsOf(tags))).toEqual(selected);
      }),
      RUNS,
    );
  });

  it('evaluates Accept-Language ranges by q and falls back to the original language', () => {
    const arb = arbListing().chain((listing) => fc.tuple(fc.constant(listing), arbHeader(listing)));
    fc.assert(
      fc.property(arb, ([listing, { header, entries }]) => {
        const selected = selectLocalizedVersion(listing, preferences({ acceptLanguage: header }));
        expect(selected).toEqual(expectedVersion(listing, expectedHeaderTags(entries)));
        expectFromExistingVersion(listing, selected);
      }),
      RUNS,
    );
  });

  it('uses only lang when set; no Accept-Language value changes the result', () => {
    const arb = arbListing().chain((listing) =>
      fc.tuple(
        fc.constant(listing),
        arbTag(listing),
        fc.oneof(
          arbHeader(listing).map((h) => h.header),
          fc.string(),
        ),
      ),
    );
    fc.assert(
      fc.property(arb, ([listing, lang, acceptLanguage]) => {
        const withHeader = selectLocalizedVersion(listing, preferences({ lang, acceptLanguage }));
        const withoutHeader = selectLocalizedVersion(listing, preferences({ lang }));
        expect(withHeader).toEqual(withoutHeader);
        expect(withHeader).toEqual(expectedVersion(listing, [lang]));
      }),
      RUNS,
    );
  });

  it('delivers the original language without any evaluable preference', () => {
    fc.assert(
      fc.property(arbListing(), (listing) => {
        expect(selectLocalizedVersion(listing, preferences({}))).toEqual(versionsOf(listing)[0]);
      }),
      RUNS,
    );
  });

  it('serializes language-neutral codes and originalLocale independently of the preference', () => {
    const arb = arbListing().chain((listing) =>
      fc.tuple(fc.constant(listing), arbRequest(listing), arbRequest(listing)),
    );
    fc.assert(
      fc.property(arb, ([listing, reqA, reqB]) => {
        const neutral = (req: LocaleRequest) => {
          const version = selectLocalizedVersion(listing, preferences(req));
          const api = serialize(listing, { taxonomy: TAXONOMY, version });
          // Req 14.7: delivered locale and its texts in own fields, original locale separately.
          expect({
            title: api.title,
            description: api.description,
            deliveredLocale: api.deliveredLocale,
          }).toEqual(version);
          return {
            originalLocale: api.originalLocale,
            offerTypes: api.offers.map((o) => o.offerType),
            group: api.group,
            listingType: api.listingType,
          };
        };
        const a = neutral(reqA);
        expect(neutral(reqB)).toEqual(a);
        expect(a).toMatchObject({
          originalLocale: listing.originalLocale,
          offerTypes: listing.offers.map((o) => o.offerType),
          listingType: listing.listingType,
        });
      }),
      RUNS,
    );
  });
});
