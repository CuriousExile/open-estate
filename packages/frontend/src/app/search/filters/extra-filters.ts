// Filters of the "More filters" view, in display order. To add a filter: append a definition
// bound to a search form field that the Search_API supports (`SearchQuery` in
// packages/shared/src/schema/search.ts), add its translation keys to every i18n file, and — if
// the field is new to the form — to `SearchFormValues`/`SEARCH_FORM_FIELDS`. Rendering, the badge
// count, Reset, URL parameters and validation follow from the definition (docs/configuration.md).
import { LISTING_BOUNDS } from '@open-estate/shared';
import type { SearchFormField } from '../validate-search-form';
import type { FilterDefinition } from './filter-registry';

/** Fields of the main search bar; extra filters must not reuse them. */
export const MAIN_BAR_FIELDS: readonly SearchFormField[] = [
  'offerType',
  'city',
  'group',
  'priceMin',
  'priceMax',
  'roomsMin',
];

export const EXTRA_FILTERS: readonly FilterDefinition[] = [
  {
    id: 'area',
    kind: 'number-range',
    labelKey: 'search.field.area',
    min: 'areaMin',
    max: 'areaMax',
    unitKey: 'search.unit.area',
  },
  {
    id: 'roomsMax',
    kind: 'number',
    labelKey: 'search.field.roomsMax',
    hintKey: 'search.hint.roomsMax',
    field: 'roomsMax',
    unitKey: 'search.unit.rooms',
    placeholderKey: 'search.placeholder.any',
  },
  {
    id: 'postalCode',
    kind: 'text',
    labelKey: 'search.field.postalCode',
    hintKey: 'search.hint.postalCode',
    field: 'postalCode',
    maxLength: LISTING_BOUNDS.postalCode.max,
    autocomplete: 'postal-code',
    placeholderKey: 'search.placeholder.postalCode',
  },
  {
    id: 'hasTour',
    kind: 'toggle',
    labelKey: 'search.field.hasTour',
    hintKey: 'search.hint.hasTour',
    field: 'hasTour',
  },
];
