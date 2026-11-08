// Feature: duplicate-detection, Property 4: Taxonomie-Bindung
import { contentRules, prepareContent } from '@open-estate/core';
import {
  BINDABLE_ATTRIBUTES,
  validateTaxonomy,
  type BindableAttribute,
  type NestedTaxonomyConfig,
} from '@open-estate/shared';
import fc from 'fast-check';
import { z } from 'zod';

/**
 * For any taxonomy configuration with arbitrary Merkmalslisten: unknown or repeated codes fail
 * the validation with exactly one violation per group and code (Req 2.4). Otherwise
 * `prepareContent` removes from every content exactly the bindable Objektmerkmale the group of
 * its listing type does not allow, names exactly those (in catalog order, without values),
 * leaves every other field unchanged, and a group without a list allows all of them
 * (Req 2.1, 2.2, 2.5).
 *
 * **Validates: Requirements 2.1, 2.2, 2.4, 2.5**
 */

const UNKNOWN_CODES = ['balcony', 'garage', 'Floor', 'address.street'] as const;

const arbAttributeList: fc.Arbitrary<string[] | undefined> = fc.option(
  fc.array(fc.constantFrom(...BINDABLE_ATTRIBUTES, ...UNKNOWN_CODES), { maxLength: 10 }),
  { nil: undefined },
);

/** 1–3 groups with unique codes and unique types; attribute lists arbitrary. */
const arbConfig: fc.Arbitrary<NestedTaxonomyConfig> = fc
  .array(arbAttributeList, { minLength: 1, maxLength: 3 })
  .map((lists) => ({
    groups: lists.map((attributes, index) => ({
      code: `g${index}`,
      types: [`t${index}a`, `t${index}b`],
      ...(attributes !== undefined && { attributes }),
    })),
  }));

/** Reference model of Req 2.4: one entry per (kind, group, code). */
function expectedViolations(config: NestedTaxonomyConfig): string[] {
  const known = new Set<string>(BINDABLE_ATTRIBUTES);
  const expected = new Set<string>();
  for (const group of config.groups) {
    const list = group.attributes ?? [];
    for (const code of list) {
      if (!known.has(code)) expected.add(JSON.stringify(['UNKNOWN_ATTRIBUTE', group.code, code]));
      else if (list.filter((c) => c === code).length > 1) {
        expected.add(JSON.stringify(['DUPLICATE_ATTRIBUTE', group.code, code]));
      }
    }
  }
  return [...expected].sort();
}

/** Valid value per merkmal; the binding must not look at values at all. */
const VALUES: Readonly<Record<BindableAttribute, unknown>> = {
  'address.unit': 'Whg. 3',
  floor: 2,
  totalFloors: 5,
  yearBuilt: 1999,
  plotArea: '500.00',
  bedrooms: 2,
  bathrooms: 1,
  parcelId: 'Flur 3/12',
};

/** Content with a chosen listing type and a subset of merkmale, plus unrelated fields. */
function candidateWith(listingType: string, present: readonly BindableAttribute[]) {
  const candidate: Record<string, unknown> = {
    listingType,
    title: 'unchanged',
    address: { city: 'Kiel', postalCode: '24103' },
  };
  for (const attribute of present) {
    if (attribute === 'address.unit') {
      (candidate['address'] as Record<string, unknown>)['unit'] = VALUES[attribute];
    } else {
      candidate[attribute] = VALUES[attribute];
    }
  }
  return candidate;
}

const has = (content: Record<string, unknown>, attribute: BindableAttribute): boolean =>
  attribute === 'address.unit'
    ? Object.hasOwn(content['address'] as Record<string, unknown>, 'unit')
    : Object.hasOwn(content, attribute);

/** Accepts any object: the property is about the binding, not about the listing schema. */
const anySchema = z.record(z.string(), z.unknown());

describe('Property 4: Taxonomie-Bindung', () => {
  it('validates Merkmalslisten and drops exactly the merkmale a group does not allow', () => {
    fc.assert(
      fc.property(
        arbConfig,
        fc.nat({ max: 5 }),
        fc.subarray([...BINDABLE_ATTRIBUTES]),
        (config, typePick, present) => {
          const expected = expectedViolations(config);
          const result = validateTaxonomy(config);
          expect(result.success).toBe(expected.length === 0);
          if (!result.success) {
            const actual = result.violations
              .map((v) => JSON.stringify([v.violation, v.group, v.code]))
              .sort();
            expect(actual).toEqual(expected);
            return;
          }

          const taxonomy = result.taxonomy;
          const types = taxonomy.groups.flatMap((g) => g.types);
          const listingType = types[typePick % types.length] ?? 't0a';
          const group = config.groups.find((g) => g.types.includes(listingType));
          const allowed = new Set<string>(group?.attributes ?? BINDABLE_ATTRIBUTES);

          const rules = contentRules({ tourProviders: { providers: [] }, taxonomy });
          const prepared = prepareContent(candidateWith(listingType, present), anySchema, rules);
          expect(prepared.ok).toBe(true);
          if (!prepared.ok) return;

          const expectedDropped = BINDABLE_ATTRIBUTES.filter(
            (attribute) => present.includes(attribute) && !allowed.has(attribute),
          );
          expect(prepared.droppedAttributes).toEqual(expectedDropped);
          for (const attribute of BINDABLE_ATTRIBUTES) {
            const kept = present.includes(attribute) && allowed.has(attribute);
            expect(has(prepared.content, attribute)).toBe(kept);
          }
          // Every other field is untouched.
          expect(prepared.content['title']).toBe('unchanged');
          expect(prepared.content['listingType']).toBe(listingType);
          expect(prepared.content['address']).toMatchObject({ city: 'Kiel', postalCode: '24103' });
        },
      ),
      { numRuns: 100 },
    );
  });
});
