import { BINDABLE_ATTRIBUTES, DEFAULT_TAXONOMY_CONFIG, LISTING_BOUNDS } from '@open-estate/shared';
import { FALLBACK_SEARCH_META, parseSearchMeta } from '../src/app/search/search-meta';
import {
  INITIAL_SEARCH_FORM_VALUES,
  normalizeDecimal,
  ROOMS_PARAMS,
  SEARCH_FORM_FIELDS,
  SEARCH_FORM_ROOMS_MIN,
  validateSearchForm,
  type SearchFormValues,
} from '../src/app/search/validate-search-form';

const META = parseSearchMeta({
  taxonomy: {
    groups: [
      { code: 'apartment', types: ['loft', 'penthouse'] },
      { code: 'house', types: ['villa'] },
    ],
  },
  locales: ['en', 'de'],
  defaultCurrency: 'EUR',
  tourProviders: ['my.matterport.com'],
});

const form = (overrides: Partial<SearchFormValues> = {}): SearchFormValues => ({
  ...INITIAL_SEARCH_FORM_VALUES,
  ...overrides,
});

/** Fields with errors, in reported order. */
function errorFields(values: SearchFormValues, meta = META): string[] {
  const result = validateSearchForm(values, meta);
  return 'errors' in result ? result.errors.map((e) => e.field) : [];
}

describe('validateSearchForm', () => {
  it('defaults to offer type SALE without other filters', () => {
    expect(INITIAL_SEARCH_FORM_VALUES.offerType).toBe('SALE');
    expect(validateSearchForm(form(), META)).toEqual({ params: { offerType: 'SALE' } });
  });

  it('maps all filters to API parameters (decimals as strings, empty inputs omitted)', () => {
    const result = validateSearchForm(
      form({
        offerType: 'RENT',
        priceMin: '500',
        priceMax: ' 1250,5 ',
        roomsMin: '1.5',
        roomsMax: '',
        areaMin: '40',
        areaMax: '120.25',
        city: 'Berlin',
        group: 'house',
        hasTour: true,
      }),
      META,
    );
    expect(result).toEqual({
      params: {
        offerType: 'RENT',
        priceMin: '500',
        priceMax: '1250.5',
        roomsMin: '1.5',
        areaMin: '40',
        areaMax: '120.25',
        city: 'Berlin',
        group: 'house',
        hasTour: true,
      },
    });
  });

  it('requires an offer type', () => {
    expect(validateSearchForm(form({ offerType: null }), META)).toEqual({
      errors: [{ field: 'offerType', messageKey: 'search.error.offerType' }],
    });
  });

  it.each([
    ['priceMin', String(LISTING_BOUNDS.money.minMinor / 100), '0'],
    ['priceMax', String(LISTING_BOUNDS.money.maxMinor / 100), '1000000000'],
    ['areaMin', String(LISTING_BOUNDS.area.minMinor / 100), '0.99'],
    ['areaMax', String(LISTING_BOUNDS.area.maxMinor / 100), '100000.01'],
    ['roomsMin', String(SEARCH_FORM_ROOMS_MIN), '0.5'],
    ['roomsMax', String(LISTING_BOUNDS.rooms.max), '100'],
  ] as const)(
    'accepts the bound of %s and rejects the value beyond it',
    (field, valid, invalid) => {
      expect(errorFields(form({ [field]: valid }))).toEqual([]);
      expect(errorFields(form({ [field]: invalid }))).toEqual([field]);
    },
  );

  it('starts the room filter at one room, also for the maximum (frontend-only rule)', () => {
    const tooFew = { field: 'roomsMax', messageKey: 'search.error.rooms', params: ROOMS_PARAMS };
    expect(validateSearchForm(form({ roomsMax: '0' }), META)).toEqual({ errors: [tooFew] });
    expect(ROOMS_PARAMS).toEqual({ min: 1, max: 99.5, step: 0.5 });
    // A schema error on the field wins over the room rule.
    expect(errorFields(form({ roomsMin: '-1' }))).toEqual(['roomsMin']);
  });

  it('accepts rooms only in steps of 0.5', () => {
    expect(errorFields(form({ roomsMin: '2.5', roomsMax: '3' }))).toEqual([]);
    const result = validateSearchForm(form({ roomsMin: '2.25' }), META);
    expect(result).toEqual({
      errors: [
        {
          field: 'roomsMin',
          messageKey: 'search.error.rooms',
          params: { min: 1, max: 99.5, step: 0.5 },
        },
      ],
    });
  });

  it.each([['abc'], ['1.234'], ['1e3'], ['1.000,00']])('rejects malformed price %p', (value) => {
    expect(errorFields(form({ priceMin: value }))).toEqual(['priceMin']);
  });

  it('rejects text longer than the listing bounds', () => {
    expect(errorFields(form({ city: 'x'.repeat(LISTING_BOUNDS.city.max) }))).toEqual([]);
    expect(
      errorFields(
        form({
          city: 'x'.repeat(LISTING_BOUNDS.city.max + 1),
        }),
      ),
    ).toEqual(['city']);
  });

  it.each([
    ['priceMin', 'priceMax', '2000', '1000'],
    ['roomsMin', 'roomsMax', '4', '2'],
    ['areaMin', 'areaMax', '100', '50.5'],
  ] as const)('rejects %s > %s on the min field', (min, max, minValue, maxValue) => {
    expect(validateSearchForm(form({ [min]: minValue, [max]: maxValue }), META)).toEqual({
      errors: [{ field: min, messageKey: 'search.error.range' }],
    });
    expect(errorFields(form({ [min]: maxValue, [max]: maxValue }))).toEqual([]);
  });

  it('reports all invalid fields in form order, one error per field', () => {
    expect(
      errorFields(
        form({ offerType: null, areaMax: 'x', priceMin: '-1', roomsMin: '3', roomsMax: '1' }),
      ),
    ).toEqual(['offerType', 'priceMin', 'roomsMin', 'areaMax']);
  });

  it('accepts a group from /meta', () => {
    expect(validateSearchForm(form({ group: 'house' }), META)).toEqual({
      params: { offerType: 'SALE', group: 'house' },
    });
  });

  it('has no property-type field any more (only the group stays in the form)', () => {
    expect(SEARCH_FORM_FIELDS).not.toContain('types');
    expect(Object.keys(INITIAL_SEARCH_FORM_VALUES)).not.toContain('types');
  });

  it('rejects unknown taxonomy codes', () => {
    expect(validateSearchForm(form({ group: 'castle' }), META)).toEqual({
      errors: [{ field: 'group', messageKey: 'search.error.unknownCode' }],
    });
  });

  it('never modifies the form values', () => {
    const values = form({ priceMin: ' 1,5 ', group: 'house', roomsMin: 'x' });
    const copy = structuredClone(values);
    validateSearchForm(values, META);
    expect(values).toEqual(copy);
  });

  it('works without /meta: other filters validate, taxonomy codes are unknown', () => {
    expect(validateSearchForm(form({ city: 'Hamburg', hasTour: true }))).toEqual({
      params: { offerType: 'SALE', city: 'Hamburg', hasTour: true },
    });
    expect(errorFields(form({ group: 'house' }), FALLBACK_SEARCH_META)).toEqual(['group']);
  });
});

describe('normalizeDecimal', () => {
  it('trims and accepts a decimal comma', () => {
    expect(normalizeDecimal(' 1,5 ')).toBe('1.5');
    expect(normalizeDecimal('1.5')).toBe('1.5');
  });
});

describe('parseSearchMeta', () => {
  it('reads taxonomy (nested or flat), default currency and tour hosts', () => {
    expect(META.taxonomy?.groups.map((g) => g.code)).toEqual(['apartment', 'house']);
    expect(META.defaultCurrency).toBe('EUR');
    expect(META.tourProviders).toEqual(['my.matterport.com']);
    const flat = parseSearchMeta({
      taxonomy: { groups: [{ code: 'land' }], types: [{ code: 'plot', group: 'land' }] },
    });
    // A group without an `attributes` list allows every bindable Objektmerkmal (Req 2.2).
    expect(flat.taxonomy).toEqual({
      groups: [{ code: 'land', types: ['plot'], attributes: [...BINDABLE_ATTRIBUTES] }],
    });
    expect(parseSearchMeta({ taxonomy: DEFAULT_TAXONOMY_CONFIG }).taxonomy).toBeDefined();
  });

  it.each([
    ['missing', undefined],
    ['not an object', 'oops'],
    ['without taxonomy', { locales: ['en'] }],
    ['invalid taxonomy', { taxonomy: { groups: [{ code: 'a', types: ['a'] }] } }],
    ['empty taxonomy', { taxonomy: { groups: [] } }],
  ])('drops the taxonomy if /meta is %s', (_, raw) => {
    expect(parseSearchMeta(raw).taxonomy).toBeUndefined();
  });

  it('keeps a valid taxonomy if other parts are broken', () => {
    const meta = parseSearchMeta({
      taxonomy: { groups: [{ code: 'house', types: ['villa'] }] },
      locales: 42,
      defaultCurrency: 'euro',
      tourProviders: 'x',
    });
    expect(meta.taxonomy).toBeDefined();
    expect(meta.defaultCurrency).toBeUndefined();
    expect(meta.tourProviders).toBeUndefined();
  });
});
