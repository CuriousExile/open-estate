import {
  formValuesFromQuery,
  isSearchLayoutChange,
  isSearchQuery,
  searchQueryParams,
} from '../src/app/search/search-url';
import {
  INITIAL_SEARCH_FORM_VALUES,
  validateSearchForm,
} from '../src/app/search/validate-search-form';

describe('search URL', () => {
  it('treats a URL with an offer type as a search; ?country alone is not one', () => {
    expect(isSearchQuery({ offerType: 'SALE' })).toBe(true);
    expect(isSearchQuery({ country: 'TH' })).toBe(false);
    expect(isSearchQuery({})).toBe(false);
    expect(formValuesFromQuery({ country: 'TH' })).toBeUndefined();
  });

  it('reads all form fields and ignores unknown parameters', () => {
    expect(
      formValuesFromQuery({
        offerType: 'RENT',
        city: 'Berlin',
        group: 'house',
        priceMin: '500',
        roomsMin: '2.0',
        roomsMax: '4',
        areaMin: '40',
        postalCode: '10115',
        hasTour: 'true',
        country: 'DE',
        foo: 'bar',
      }),
    ).toEqual({
      ...INITIAL_SEARCH_FORM_VALUES,
      offerType: 'RENT',
      city: 'Berlin',
      group: 'house',
      priceMin: '500',
      roomsMin: '2',
      roomsMax: '4',
      areaMin: '40',
      postalCode: '10115',
      hasTour: true,
    });
  });

  it('takes the first of repeated parameters and keeps invalid input for validation', () => {
    const values = formValuesFromQuery({ offerType: 'LEASE', priceMin: ['x', '5'], hasTour: '1' });
    expect(values?.offerType).toBeNull();
    expect(values?.priceMin).toBe('x');
    expect(values?.hasTour).toBe(false);
  });

  it('round-trips a validated search through the URL', () => {
    const values = {
      ...INITIAL_SEARCH_FORM_VALUES,
      offerType: 'RENT' as const,
      city: 'Hamburg',
      priceMax: '1250,5',
      roomsMin: '3',
      postalCode: ' 20457 ',
      hasTour: true,
    };
    const result = validateSearchForm(values);
    if (!('params' in result)) throw new Error('expected a valid search');
    const query = searchQueryParams(result.params);
    expect(query).toEqual({
      offerType: 'RENT',
      city: 'Hamburg',
      priceMax: '1250.5',
      roomsMin: '3',
      postalCode: '20457',
      hasTour: 'true',
    });
    const back = formValuesFromQuery(query);
    expect(back).toBeDefined();
    if (back !== undefined) expect(validateSearchForm(back)).toEqual(result);
  });

  it('omits non-form parameters such as country and paging', () => {
    expect(searchQueryParams({ offerType: 'SALE', country: 'DE', pageToken: 't' })).toEqual({
      offerType: 'SALE',
    });
  });

  it('detects a switch between start page and searched layout', () => {
    expect(isSearchLayoutChange({}, { offerType: 'SALE' })).toBe(true);
    expect(isSearchLayoutChange({ offerType: 'SALE' }, {})).toBe(true);
    expect(isSearchLayoutChange({ offerType: 'SALE' }, { offerType: 'RENT' })).toBe(false);
    expect(isSearchLayoutChange({}, { country: 'TH' })).toBe(false);
  });
});
