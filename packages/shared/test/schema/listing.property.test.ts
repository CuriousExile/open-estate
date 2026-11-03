// Feature: real-estate-platform, Property 9: Listing-Serialisierungs-Round-Trip und Schema-Konformität
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import fc from 'fast-check';
import { z } from 'zod';
import {
  assertValidTaxonomy,
  DEFAULT_TAXONOMY_CONFIG,
  groupOfType,
  LocalizedListing,
  parse,
  selectLocalizedVersion,
  serialize,
  typeCodes,
  type Listing,
  type LocalePreference,
  type LocalizedVersion,
  type ParsedLocalizedListing,
} from '../../src';
import { arbListing, arbLocalizedVersion, LOCALE_POOL } from '../arbitraries';

/**
 * Property 9, formulated for the localized API view: `serialize(l, {taxonomy, version: v})`
 * delivers one language version without `translations`, so the exact round trip is
 *
 *   parse(JSON(serialize(l, v))) = view(l, v)
 *
 * where view(l, v) is l without `translations`, with `title`/`description`/`deliveredLocale`
 * taken from v, `group` derived from the taxonomy (absent for types outside the taxonomy) and
 * amounts/area in minor units (exactly as in l). v is either any language version of l or the
 * one `selectLocalizedVersion` picks for arbitrary preferences.
 *
 * In addition, the serialized representation validates against the JSON Schema generated from
 * `LocalizedListing` (`io: 'input'`, Draft 2020-12, checked with Ajv), and it contains every
 * required field and every optional field present in l (except `translations`) — the field
 * completeness of the detail retrieval at the serialization level.
 *
 * **Validates: Requirements 2.1, 3.3, 5.5**
 */

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);

/** Default taxonomy types plus a code outside the taxonomy (→ no `group`). */
const LISTING_TYPES = [...typeCodes(taxonomy), 'not_in_taxonomy'];

const jsonSchema = z.toJSONSchema(LocalizedListing, { io: 'input' });
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateJsonSchema = ajv.compile(jsonSchema);

/** Required top-level fields according to the generated JSON Schema. */
const REQUIRED_FIELDS: readonly string[] = jsonSchema.required ?? [];

/** Preference tags: pool locales (random casing), primary subtags only, and unknown languages. */
const arbPrefTag: fc.Arbitrary<string> = fc.oneof(
  fc
    .tuple(fc.constantFrom(...LOCALE_POOL), fc.boolean())
    .map(([tag, upper]) => (upper ? tag.toUpperCase() : tag.toLowerCase())),
  fc.constantFrom(...LOCALE_POOL).map((tag) => tag.split('-')[0] ?? tag),
  fc.constantFrom('xx', 'ko', 'ar-EG', 'he'),
);

const arbPrefs: fc.Arbitrary<LocalePreference[]> = fc.array(
  fc.record({ tag: arbPrefTag, q: fc.double({ min: 0.001, max: 1, noNaN: true }) }),
  { maxLength: 5 },
);

/** Listing plus a language version: any version of the listing or the selected one. */
const arbCase: fc.Arbitrary<{ listing: Listing; version: LocalizedVersion }> = arbListing({
  listingTypes: LISTING_TYPES,
}).chain((listing) =>
  fc.record({
    listing: fc.constant(listing),
    version: fc.oneof(
      arbLocalizedVersion(listing),
      arbPrefs.map((prefs) => selectLocalizedVersion(listing, prefs)),
    ),
  }),
);

/**
 * Expected localized view of `listing` for `version` (internal representation). Cloned because
 * fast-check may generate null-prototype objects, which `toStrictEqual` distinguishes from the
 * plain objects `parse` returns.
 */
function expectedView(listing: Listing, version: LocalizedVersion): ParsedLocalizedListing {
  const view: Partial<Listing> = structuredClone(listing);
  delete view.translations;
  const group = groupOfType(taxonomy, listing.listingType);
  return {
    ...(view as Omit<Listing, 'translations'>),
    title: version.title,
    description: version.description,
    deliveredLocale: version.deliveredLocale,
    ...(group !== undefined && { group }),
  };
}

describe('Property 9: listing serialization round trip and schema conformance', () => {
  it('parse(serialize(l, v)) equals the localized view, conforms to the JSON Schema and keeps all fields', () => {
    fc.assert(
      fc.property(arbCase, ({ listing, version }) => {
        const serialized = serialize(listing, { taxonomy, version });
        // The API transmits JSON; the round trip must survive the wire format.
        const wire: unknown = JSON.parse(JSON.stringify(serialized));

        // JSON Schema conformance of the API representation.
        const valid = validateJsonSchema(wire);
        expect(validateJsonSchema.errors ?? []).toEqual([]);
        expect(valid).toBe(true);

        // Exact round trip for the localized view.
        const parsed = parse(wire);
        expect(parsed).toStrictEqual({ ok: true, value: expectedView(listing, version) });

        // Field completeness: every required and every present optional field (except translations).
        const presentOptional = Object.entries(listing)
          .filter(([key, value]) => key !== 'translations' && value !== undefined)
          .map(([key]) => key);
        for (const field of new Set([...REQUIRED_FIELDS, ...presentOptional])) {
          expect(serialized).toHaveProperty([field]);
        }
        expect(serialized).not.toHaveProperty('translations');
      }),
      { numRuns: 100 },
    );
  });
});
