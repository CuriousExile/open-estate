import { LISTING_BOUNDS } from '@open-estate/shared';
import { EXTRA_FILTERS, MAIN_BAR_FIELDS } from '../src/app/search/filters/extra-filters';
import {
  activeFilterCount,
  clearedFilterValues,
  filterErrors,
  filterFields,
  isFilterActive,
  pickFilterValues,
  registryFields,
  registryProblems,
  validateFilterDraft,
  validateWithFilters,
  type FilterDefinition,
} from '../src/app/search/filters/filter-registry';
import { parseSearchMeta } from '../src/app/search/search-meta';
import {
  INITIAL_SEARCH_FORM_VALUES,
  SEARCH_FORM_FIELDS,
  type SearchFormValues,
} from '../src/app/search/validate-search-form';

const META = parseSearchMeta({
  taxonomy: { groups: [{ code: 'house', types: ['villa'] }] },
  locales: ['en', 'de'],
});

const form = (overrides: Partial<SearchFormValues> = {}): SearchFormValues => ({
  ...INITIAL_SEARCH_FORM_VALUES,
  ...overrides,
});

function byId(id: string): FilterDefinition {
  const definition = EXTRA_FILTERS.find((f) => f.id === id);
  if (definition === undefined) throw new Error(`no filter ${id}`);
  return definition;
}

describe('extra filter registry (More filters)', () => {
  it('is consistent: unique ids, each field owned once, no main bar field reused', () => {
    expect(registryProblems(EXTRA_FILTERS, MAIN_BAR_FIELDS)).toEqual([]);
    expect(EXTRA_FILTERS.map((f) => f.id)).toEqual(['area', 'roomsMax', 'postalCode', 'hasTour']);
  });

  it('only binds fields of the search form that the Search_API supports', () => {
    for (const field of registryFields(EXTRA_FILTERS)) expect(SEARCH_FORM_FIELDS).toContain(field);
    // Every form field is either in the main bar or in the registry.
    expect([...MAIN_BAR_FIELDS, ...registryFields(EXTRA_FILTERS)].sort()).toEqual(
      [...SEARCH_FORM_FIELDS].sort(),
    );
  });

  it('reports duplicate ids and fields used twice', () => {
    const dup: FilterDefinition[] = [
      { id: 'a', kind: 'toggle', labelKey: 'x', field: 'hasTour' },
      { id: 'a', kind: 'text', labelKey: 'x', field: 'city', maxLength: 5 },
    ];
    expect(registryProblems(dup, ['city'])).toEqual([
      'duplicate filter id "a"',
      'field "city" of "a" is already used by main bar',
    ]);
  });

  it('maps a range to two fields and other kinds to one', () => {
    const area = byId('area');
    expect(filterFields(area)).toEqual(['areaMin', 'areaMax']);
    expect(registryFields(EXTRA_FILTERS)).toEqual([
      'areaMin',
      'areaMax',
      'roomsMax',
      'postalCode',
      'hasTour',
    ]);
  });

  it('counts active filters for the badge (a range counts once, blanks do not count)', () => {
    expect(activeFilterCount(EXTRA_FILTERS, form())).toBe(0);
    expect(activeFilterCount(EXTRA_FILTERS, form({ city: 'Berlin', priceMin: '5' }))).toBe(0);
    expect(
      activeFilterCount(
        EXTRA_FILTERS,
        form({ areaMin: '40', areaMax: '90', hasTour: true, postalCode: '  ' }),
      ),
    ).toBe(2);
    const toggle = byId('hasTour');
    expect(isFilterActive(toggle, form({ hasTour: false }))).toBe(false);
  });

  it('picks the draft and resets it to empty values', () => {
    const values = form({ areaMin: '40', hasTour: true, city: 'Kiel' });
    expect(pickFilterValues(EXTRA_FILTERS, values)).toEqual({
      areaMin: '40',
      areaMax: '',
      roomsMax: '',
      postalCode: '',
      hasTour: true,
    });
    expect(clearedFilterValues(EXTRA_FILTERS)).toEqual({
      areaMin: '',
      areaMax: '',
      roomsMax: '',
      postalCode: '',
      hasTour: false,
    });
  });

  it('validates a draft with the shared schema, returning only the filters’ errors', () => {
    const values = form({ priceMin: 'abc' }); // main bar error: not the view's business
    expect(validateFilterDraft(EXTRA_FILTERS, values, { areaMin: '40' }, META)).toEqual([]);
    expect(
      validateFilterDraft(
        EXTRA_FILTERS,
        values,
        {
          areaMin: '100',
          areaMax: '50',
          postalCode: 'x'.repeat(LISTING_BOUNDS.postalCode.max + 1),
        },
        META,
      ).map((e) => [e.field, e.messageKey]),
    ).toEqual([
      ['areaMin', 'search.error.range'],
      ['postalCode', 'search.error.text'],
    ]);
  });

  it('checks the rooms maximum against the rooms chip of the main bar', () => {
    expect(
      validateFilterDraft(EXTRA_FILTERS, form({ roomsMin: '4' }), { roomsMax: '2' }, META),
    ).toEqual([]); // the range error belongs to roomsMin (main bar)
    expect(
      validateFilterDraft(EXTRA_FILTERS, form(), { roomsMax: '0.5' }, META).map((e) => e.field),
    ).toEqual(['roomsMax']);
  });

  it('runs custom rules of a definition in the draft and on submit', () => {
    const evenArea: FilterDefinition = {
      id: 'area',
      kind: 'number-range',
      labelKey: 'search.field.area',
      min: 'areaMin',
      max: 'areaMax',
      validate: (values) =>
        values.areaMin !== '' && Number(values.areaMin) % 2 === 1
          ? { field: 'areaMin', messageKey: 'search.error.invalid' }
          : undefined,
    };
    expect(validateFilterDraft([evenArea], form(), { areaMin: '41' }, META)).toEqual([
      { field: 'areaMin', messageKey: 'search.error.invalid' },
    ]);
    expect(validateWithFilters([evenArea], form({ areaMin: '42' }), META)).toEqual({
      params: { offerType: 'SALE', areaMin: '42' },
    });
    expect(
      validateWithFilters([evenArea], form({ areaMin: '41', city: 'x'.repeat(201) }), META),
    ).toEqual({
      errors: [
        { field: 'city', messageKey: 'search.error.text', params: { max: 200 } },
        { field: 'areaMin', messageKey: 'search.error.invalid' },
      ],
    });
  });

  it('supports select filters (choices from /meta) like the other kinds', () => {
    const group: FilterDefinition = {
      id: 'group',
      kind: 'select',
      labelKey: 'search.field.group',
      anyLabelKey: 'search.group.any',
      field: 'group',
      choices: (meta) =>
        meta.taxonomy?.groups.map((g) => ({
          value: g.code,
          labelKey: `taxonomy.group.${g.code}`,
        })) ?? [],
    };
    expect(group.kind === 'select' && group.choices(META)).toEqual([
      { value: 'house', labelKey: 'taxonomy.group.house' },
    ]);
    expect(activeFilterCount([group], form({ group: 'house' }))).toBe(1);
    expect(validateFilterDraft([group], form(), { group: 'castle' }, META)).toEqual([
      { field: 'group', messageKey: 'search.error.unknownCode' },
    ]);
  });

  it('selects the errors that belong to the view (e.g. to open it after a deep link)', () => {
    expect(
      filterErrors(EXTRA_FILTERS, [
        { field: 'priceMin', messageKey: 'a' },
        { field: 'postalCode', messageKey: 'b' },
      ]),
    ).toEqual([{ field: 'postalCode', messageKey: 'b' }]);
  });
});
