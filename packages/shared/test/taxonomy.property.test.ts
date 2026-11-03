// Feature: real-estate-platform, Property 24: Taxonomie-Validierung
// **Validates: Requirements 15.1, 15.4**
import fc from 'fast-check';
import {
  validateTaxonomy,
  type FlatTaxonomyConfig,
  type NestedTaxonomyConfig,
  type TaxonomyConfig,
  type TaxonomyViolationKind,
} from '../src';

const RUNS = { numRuns: 100 };

// Codes: a small shared pool makes duplicates across groups and types likely; invalid lengths
// (empty, 65+) are mixed in deliberately.
const arbPoolCode = fc.constantFrom('apartment', 'house', 'villa', 'land', 'g', 'x'.repeat(64));
const arbValidCode = fc.string({ minLength: 1, maxLength: 64 });
const arbInvalidCode = fc.oneof(fc.constant(''), fc.string({ minLength: 65, maxLength: 80 }));
const arbCode = fc.oneof(
  { weight: 4, arbitrary: arbPoolCode },
  { weight: 3, arbitrary: arbValidCode },
  { weight: 1, arbitrary: arbInvalidCode },
);

const arbNested: fc.Arbitrary<NestedTaxonomyConfig> = fc.record({
  groups: fc.array(fc.record({ code: arbCode, types: fc.array(arbCode, { maxLength: 4 }) }), {
    maxLength: 4,
  }),
});

// Flat format: type references are either a defined group (by index) or an arbitrary code that
// may be unknown.
const arbFlat: fc.Arbitrary<FlatTaxonomyConfig> = fc
  .record({
    groups: fc.array(arbCode, { maxLength: 4 }),
    types: fc.array(
      fc.record({
        code: arbCode,
        ref: fc.oneof(
          fc.nat({ max: 3 }).map((i) => ({ index: i })),
          arbCode,
        ),
      }),
      { maxLength: 6 },
    ),
  })
  .map(({ groups, types }) => ({
    groups: groups.map((code) => ({ code })),
    types: types.map(({ code, ref }) => ({
      code,
      group: typeof ref === 'string' ? ref : (groups[ref.index % groups.length] ?? 'missing-group'),
    })),
  }));

const arbConfig: fc.Arbitrary<TaxonomyConfig> = fc.oneof(arbNested, arbFlat);

/** Independent reference model: expected set of "violation code" keys. */
function expectedViolations(config: TaxonomyConfig): string[] {
  const groupCodes = config.groups.map((g) => g.code);
  const types: { code: string; group: string }[] =
    'types' in config
      ? config.types
      : config.groups.flatMap((g) => g.types.map((code) => ({ code, group: g.code })));
  const all = [...groupCodes, ...types.map((t) => t.code)];

  const expected = new Set<string>();
  const add = (kind: TaxonomyViolationKind, code: string): void => {
    expected.add(JSON.stringify([kind, code]));
  };
  for (const code of all) {
    if (code.length === 0 || code.length > 64) add('INVALID_CODE_LENGTH', code);
    if (all.filter((c) => c === code).length > 1) add('DUPLICATE_CODE', code);
  }
  for (const type of types) {
    if (!groupCodes.includes(type.group)) add('UNKNOWN_GROUP', type.code);
  }
  return [...expected].sort();
}

/** Reference normalization: nested groups in config order, types in config order. */
function expectedTaxonomy(config: TaxonomyConfig): { code: string; types: string[] }[] {
  if (!('types' in config))
    return config.groups.map((g) => ({ code: g.code, types: [...g.types] }));
  // Only called for valid configs: group codes are unique and every type references one of them.
  const buckets = new Map<string, string[]>(config.groups.map((g) => [g.code, []]));
  for (const type of config.types) buckets.get(type.group)?.push(type.code);
  return config.groups.map((g) => ({ code: g.code, types: buckets.get(g.code) ?? [] }));
}

function typeCodesOf(config: TaxonomyConfig): string[] {
  return 'types' in config
    ? config.types.map((t) => t.code)
    : config.groups.flatMap((g) => g.types);
}

describe('Property 24: Taxonomie-Validierung', () => {
  it('succeeds iff there are no violations; otherwise reports exactly every affected code and kind', () => {
    fc.assert(
      fc.property(arbConfig, (config) => {
        const expected = expectedViolations(config);
        const result = validateTaxonomy(config);

        expect(result.success).toBe(expected.length === 0);
        if (!result.success) {
          // One entry per (kind, code); no extra, none missing.
          const actual = result.violations.map((v) => JSON.stringify([v.violation, v.code])).sort();
          expect(actual).toEqual(expected);
        } else {
          expect(result.taxonomy.groups).toEqual(expectedTaxonomy(config));
        }
      }),
      RUNS,
    );
  });

  it('normalizes valid configs: every type in exactly one group, order preserved', () => {
    const arbValid = fc.uniqueArray(arbValidCode, { minLength: 1, maxLength: 10 }).chain((codes) =>
      fc
        .record({
          groupCount: fc.integer({ min: 1, max: codes.length }),
          assignment: fc.array(fc.nat(), { minLength: codes.length, maxLength: codes.length }),
          flat: fc.boolean(),
        })
        .map(({ groupCount, assignment, flat }): TaxonomyConfig => {
          const groups = codes.slice(0, groupCount);
          const types = codes.slice(groupCount).map((code, i) => ({
            code,
            group: groups[(assignment[i] ?? 0) % groupCount] ?? groups[0] ?? '',
          }));
          return flat
            ? { groups: groups.map((code) => ({ code })), types }
            : {
                groups: groups.map((code) => ({
                  code,
                  types: types.filter((t) => t.group === code).map((t) => t.code),
                })),
              };
        }),
    );

    fc.assert(
      fc.property(arbValid, (config) => {
        const result = validateTaxonomy(config);
        expect(result.success).toBe(true);
        if (!result.success) return;

        const groups = result.taxonomy.groups;
        expect(groups.map((g) => g.code)).toEqual(config.groups.map((g) => g.code));
        expect(groups).toEqual(expectedTaxonomy(config));
        // Each type appears in exactly one group.
        const assigned = groups.flatMap((g) => g.types);
        expect([...assigned].sort()).toEqual([...typeCodesOf(config)].sort());
        expect(new Set(assigned).size).toBe(assigned.length);
      }),
      RUNS,
    );
  });
});
