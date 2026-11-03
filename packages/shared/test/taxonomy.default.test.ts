import {
  assertValidTaxonomy,
  DEFAULT_TAXONOMY_CONFIG,
  typesOfGroup,
  validateTaxonomy,
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
});
