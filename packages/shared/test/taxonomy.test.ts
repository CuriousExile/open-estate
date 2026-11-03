import {
  assertValidTaxonomy,
  groupOfType,
  TaxonomyConfig,
  TaxonomyValidationError,
  typesOfGroup,
  validateTaxonomy,
  type TaxonomyViolation,
} from '../src';

function violationsOf(config: TaxonomyConfig): Pick<TaxonomyViolation, 'violation' | 'code'>[] {
  const result = validateTaxonomy(config);
  expect(result.success).toBe(false);
  return result.success
    ? []
    : result.violations.map(({ violation, code }) => ({ violation, code }));
}

describe('TaxonomyConfig structure', () => {
  it('accepts the nested and the flat format', () => {
    expect(TaxonomyConfig.safeParse({ groups: [{ code: 'g', types: ['t'] }] }).success).toBe(true);
    expect(
      TaxonomyConfig.safeParse({ groups: [{ code: 'g' }], types: [{ code: 't', group: 'g' }] })
        .success,
    ).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(TaxonomyConfig.safeParse({ groups: [{ code: 'g', types: 't' }] }).success).toBe(false);
    expect(TaxonomyConfig.safeParse({ types: [{ code: 't', group: 'g' }] }).success).toBe(false);
  });
});

describe('validateTaxonomy', () => {
  it('normalizes a valid flat config to the nested form, preserving order', () => {
    const result = validateTaxonomy({
      groups: [{ code: 'house' }, { code: 'land' }],
      types: [
        { code: 'villa', group: 'house' },
        { code: 'building_plot', group: 'land' },
        { code: 'terraced', group: 'house' },
      ],
    });
    expect(result).toEqual({
      success: true,
      taxonomy: {
        groups: [
          { code: 'house', types: ['villa', 'terraced'] },
          { code: 'land', types: ['building_plot'] },
        ],
      },
    });
  });

  it('accepts codes of length 1 and 64', () => {
    const result = validateTaxonomy({ groups: [{ code: 'g', types: ['x'.repeat(64)] }] });
    expect(result.success).toBe(true);
  });

  it('reports duplicates across groups and types, within a group and across groups', () => {
    expect(
      violationsOf({
        groups: [
          { code: 'apartment', types: ['apartment', 'loft', 'loft'] },
          { code: 'house', types: ['villa'] },
          { code: 'commercial', types: ['villa'] },
        ],
      }),
    ).toEqual([
      { violation: 'DUPLICATE_CODE', code: 'apartment' },
      { violation: 'DUPLICATE_CODE', code: 'loft' },
      { violation: 'DUPLICATE_CODE', code: 'villa' },
    ]);
  });

  it('reports empty and too long codes', () => {
    const tooLong = 'x'.repeat(65);
    expect(violationsOf({ groups: [{ code: '', types: [tooLong] }] })).toEqual([
      { violation: 'INVALID_CODE_LENGTH', code: '' },
      { violation: 'INVALID_CODE_LENGTH', code: tooLong },
    ]);
  });

  it('reports types referencing an undefined group (flat format)', () => {
    expect(
      violationsOf({
        groups: [{ code: 'house' }],
        types: [
          { code: 'villa', group: 'house' },
          { code: 'office', group: 'commercial' },
          { code: 'loft', group: 'House' },
        ],
      }),
    ).toEqual([
      { violation: 'UNKNOWN_GROUP', code: 'office' },
      { violation: 'UNKNOWN_GROUP', code: 'loft' },
    ]);
  });

  it('collects all violations of different kinds at once', () => {
    const violations = violationsOf({
      groups: [{ code: 'house' }, { code: 'house' }],
      types: [
        { code: '', group: 'house' },
        { code: 'villa', group: 'missing' },
      ],
    });
    expect(violations).toHaveLength(3);
    expect(violations).toEqual(
      expect.arrayContaining([
        { violation: 'DUPLICATE_CODE', code: 'house' },
        { violation: 'INVALID_CODE_LENGTH', code: '' },
        { violation: 'UNKNOWN_GROUP', code: 'villa' },
      ]),
    );
  });
});

describe('assertValidTaxonomy', () => {
  it('throws an error naming every affected code and violation', () => {
    expect.assertions(3);
    try {
      assertValidTaxonomy({ groups: [{ code: 'g', types: ['g', ''] }] });
    } catch (error) {
      expect(error).toBeInstanceOf(TaxonomyValidationError);
      expect((error as TaxonomyValidationError).violations).toHaveLength(2);
      expect((error as Error).message).toContain('DUPLICATE_CODE g');
    }
  });
});

describe('typesOfGroup / groupOfType', () => {
  const taxonomy = assertValidTaxonomy({
    groups: [
      { code: 'house', types: ['villa', 'terraced'] },
      { code: 'land', types: [] },
    ],
  });

  it('resolves exact, case-sensitive codes', () => {
    expect(typesOfGroup(taxonomy, 'house')).toEqual(['villa', 'terraced']);
    expect(typesOfGroup(taxonomy, 'land')).toEqual([]);
    expect(typesOfGroup(taxonomy, 'House')).toBeUndefined();
    expect(groupOfType(taxonomy, 'terraced')).toBe('house');
    expect(groupOfType(taxonomy, 'Villa')).toBeUndefined();
  });
});
