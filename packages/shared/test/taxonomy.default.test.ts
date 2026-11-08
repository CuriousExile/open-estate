import {
  allowedAttributes,
  assertValidTaxonomy,
  BINDABLE_ATTRIBUTES,
  DEFAULT_TAXONOMY_CONFIG,
  typesOfGroup,
  validateTaxonomy,
  type BindableAttribute,
} from '../src';

// Default taxonomy shipped with the repository (Req 15.2).
const REQUIRED: Record<string, readonly string[]> = {
  apartment: ['apartment_unit', 'condominium', 'penthouse', 'loft'],
  house: ['single_family', 'villa', 'terraced', 'semi_detached'],
  land: [],
  commercial: [],
};

describe('DEFAULT_TAXONOMY_CONFIG', () => {
  it('is valid', () => {
    expect(validateTaxonomy(DEFAULT_TAXONOMY_CONFIG).success).toBe(true);
  });

  const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);

  it.each(Object.entries(REQUIRED))('contains group %s with its required types', (group, types) => {
    const actual = typesOfGroup(taxonomy, group);
    expect(actual).toBeDefined();
    expect(actual).toEqual(expect.arrayContaining([...types]));
  });

  it('has at least one type in every group', () => {
    for (const group of taxonomy.groups) {
      expect(group.types.length).toBeGreaterThanOrEqual(1);
    }
  });

  // Objektmerkmale per group (duplicate-detection Req 2.3).
  const EXPECTED_ATTRIBUTES: Record<string, readonly BindableAttribute[]> = {
    apartment: ['address.unit', 'floor', 'totalFloors', 'yearBuilt', 'bedrooms', 'bathrooms'],
    house: ['totalFloors', 'yearBuilt', 'plotArea', 'bedrooms', 'bathrooms', 'parcelId'],
    land: ['plotArea', 'parcelId'],
    commercial: ['address.unit', 'floor', 'totalFloors', 'yearBuilt', 'plotArea', 'parcelId'],
  };

  it.each(Object.entries(EXPECTED_ATTRIBUTES))(
    'allows exactly the documented Objektmerkmale for group %s',
    (group, attributes) => {
      const groupEntry = taxonomy.groups.find((g) => g.code === group);
      expect(groupEntry?.attributes).toEqual([...attributes]);
      // Every type of the group resolves to the same set.
      for (const type of groupEntry?.types ?? []) {
        expect([...(allowedAttributes(taxonomy, type) ?? [])].sort()).toEqual(
          [...attributes].sort(),
        );
      }
    },
  );

  it('has no Objektmerkmal outside the bindable ones', () => {
    for (const group of taxonomy.groups) {
      expect(BINDABLE_ATTRIBUTES).toEqual(expect.arrayContaining([...group.attributes]));
    }
  });

  it('resolves an unknown listing type to no merkmal set', () => {
    expect(allowedAttributes(taxonomy, 'not_in_taxonomy')).toBeUndefined();
  });
});

describe('Objektmerkmale in the taxonomy configuration', () => {
  it('allows every bindable merkmal for a group without a list (Req 2.2)', () => {
    const taxonomy = assertValidTaxonomy({ groups: [{ code: 'g', types: ['t'] }] });
    expect(taxonomy.groups[0]?.attributes).toEqual([...BINDABLE_ATTRIBUTES]);
    expect(allowedAttributes(taxonomy, 't')?.size).toBe(BINDABLE_ATTRIBUTES.length);
  });

  it('allows an empty list, which forbids every bindable merkmal', () => {
    const taxonomy = assertValidTaxonomy({ groups: [{ code: 'g', types: ['t'], attributes: [] }] });
    expect(allowedAttributes(taxonomy, 't')?.size).toBe(0);
  });

  it('reports an unknown merkmal with its group (Req 2.4)', () => {
    const result = validateTaxonomy({
      groups: [{ code: 'g', types: ['t'], attributes: ['floor', 'balcony'] }],
    });
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.violations).toEqual([
      expect.objectContaining({ violation: 'UNKNOWN_ATTRIBUTE', code: 'balcony', group: 'g' }),
    ]);
  });

  it('reports a repeated merkmal of the same group, but not across groups (Req 2.4)', () => {
    const result = validateTaxonomy({
      groups: [
        { code: 'g', types: ['t'], attributes: ['floor', 'floor'] },
        { code: 'h', types: ['u'], attributes: ['floor'] },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.violations).toEqual([
      expect.objectContaining({ violation: 'DUPLICATE_ATTRIBUTE', code: 'floor', group: 'g' }),
    ]);
  });

  it('reports merkmal violations of several groups separately', () => {
    const result = validateTaxonomy({
      groups: [
        { code: 'g', types: ['t'], attributes: ['balcony'] },
        { code: 'h', types: ['u'], attributes: ['balcony'] },
      ],
    });
    expect(result.success ? [] : result.violations).toHaveLength(2);
  });
});
