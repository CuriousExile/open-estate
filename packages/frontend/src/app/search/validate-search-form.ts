// Framework-free validation of the search form (design: SearchFormComponent; Req 4.7, 7.1, 7.2,
// 12.10). Uses `parseSearchQuery` from `shared`, i.e. exactly the rules of Search_API and MCP_Server,
// plus two frontend-only rules: the offer type is mandatory and a room count starts at 1.
import {
  LISTING_BOUNDS,
  MINOR_UNIT_SCALE,
  OFFER_TYPES,
  parseSearchQuery,
  SEARCH_QUERY_BOUNDS,
  type ApiError,
  type OfferType,
} from '@open-estate/shared';
import type { SearchParams } from '../api/api-client';
import { FALLBACK_SEARCH_META, type SearchMeta } from './search-meta';

/** Form fields in visual order; the first invalid one receives focus after submit. */
export const SEARCH_FORM_FIELDS = [
  'offerType',
  'city',
  'priceMin',
  'priceMax',
  'roomsMin',
  'roomsMax',
  'areaMin',
  'areaMax',
  'group',
  'hasTour',
] as const;
export type SearchFormField = (typeof SEARCH_FORM_FIELDS)[number];

/** Raw form state: inputs as typed (empty string = no filter), never modified by validation. */
export interface SearchFormValues {
  /** Mandatory choice (Req 12.10); `null` only if the control was cleared programmatically. */
  offerType: OfferType | null;
  priceMin: string;
  priceMax: string;
  roomsMin: string;
  roomsMax: string;
  areaMin: string;
  areaMax: string;
  city: string;
  /** Group code or `''`. */
  group: string;
  hasTour: boolean;
}

/** Initial state: offer type `SALE` preselected (Req 12.10), no other filter. */
export const INITIAL_SEARCH_FORM_VALUES: SearchFormValues = {
  offerType: 'SALE',
  priceMin: '',
  priceMax: '',
  roomsMin: '',
  roomsMax: '',
  areaMin: '',
  areaMax: '',
  city: '',
  group: '',
  hasTour: false,
};

export interface SearchFormError {
  field: SearchFormField;
  /** Transloco key of the message; the field itself is named by `search.field.<field>`. */
  messageKey: string;
  /** Interpolation parameters of the message (bounds from `LISTING_BOUNDS`). */
  params?: Readonly<Record<string, number>>;
}

export type SearchFormResult = { params: SearchParams } | { errors: SearchFormError[] };

const DECIMAL_FIELDS = [
  'priceMin',
  'priceMax',
  'roomsMin',
  'roomsMax',
  'areaMin',
  'areaMax',
] as const;

export const ROOM_FIELDS = ['roomsMin', 'roomsMax'] as const;

/**
 * Lowest room count of the search form. The API accepts 0 (e.g. plots); a room filter below one
 * room is meaningless for a person searching, so the form starts at 1 (frontend-only rule).
 */
export const SEARCH_FORM_ROOMS_MIN = 1;

const B = LISTING_BOUNDS;
const PRICE_PARAMS = {
  min: B.money.minMinor / MINOR_UNIT_SCALE,
  max: B.money.maxMinor / MINOR_UNIT_SCALE,
};
export const ROOMS_PARAMS = { min: SEARCH_FORM_ROOMS_MIN, max: B.rooms.max, step: B.rooms.step };
const AREA_PARAMS = {
  min: B.area.minMinor / MINOR_UNIT_SCALE,
  max: B.area.maxMinor / MINOR_UNIT_SCALE,
};

/**
 * Decimal input → API representation: surrounding whitespace removed and a decimal comma accepted
 * ("1,5" → "1.5"). Everything else is left to the schema, so e.g. thousands separators are rejected.
 */
export function normalizeDecimal(input: string): string {
  return input.trim().replace(',', '.');
}

/** Form values → raw query in API representation; empty inputs are omitted. */
function toRawQuery(values: SearchFormValues): SearchParams {
  const query: SearchParams = {};
  if (values.offerType !== null) query.offerType = values.offerType;
  for (const field of DECIMAL_FIELDS) {
    const value = normalizeDecimal(values[field]);
    if (value !== '') query[field] = value;
  }
  if (values.city !== '') query.city = values.city;
  if (values.group !== '') query.group = values.group;
  if (values.hasTour) query.hasTour = true;
  return query;
}

const FIELD_SET: ReadonlySet<string> = new Set(SEARCH_FORM_FIELDS);

/** Form field of an API error. */
function formField(error: ApiError): SearchFormField {
  // Only form fields are sent, so every schema issue belongs to one of them.
  return error.field !== undefined && FIELD_SET.has(error.field)
    ? (error.field as SearchFormField)
    : 'offerType';
}

function invalidValueMessage(field: SearchFormField): Omit<SearchFormError, 'field'> {
  switch (field) {
    case 'priceMin':
    case 'priceMax':
      return { messageKey: 'search.error.price', params: PRICE_PARAMS };
    case 'roomsMin':
    case 'roomsMax':
      return { messageKey: 'search.error.rooms', params: ROOMS_PARAMS };
    case 'areaMin':
    case 'areaMax':
      return { messageKey: 'search.error.area', params: AREA_PARAMS };
    case 'city':
      return { messageKey: 'search.error.text', params: { max: B.city.max } };
    default:
      return { messageKey: 'search.error.invalid' };
  }
}

function toFormError(error: ApiError): SearchFormError {
  const field = formField(error);
  switch (error.code) {
    case 'INVALID_OFFER_TYPE':
    case 'OFFER_TYPE_REQUIRED':
      return { field: 'offerType', messageKey: 'search.error.offerType' };
    case 'INVALID_RANGE':
      return { field, messageKey: 'search.error.range' };
    case 'UNKNOWN_TAXONOMY_CODE':
      return { field, messageKey: 'search.error.unknownCode' };
    case 'INVALID_FILTER_COUNT':
      return { field, messageKey: 'search.error.count', params: SEARCH_QUERY_BOUNDS.group };
    default:
      return { field, ...invalidValueMessage(field) };
  }
}

/** One error per field (the first), in visual field order. */
function byField(errors: readonly SearchFormError[]): SearchFormError[] {
  const first = new Map<SearchFormField, SearchFormError>();
  for (const error of errors) if (!first.has(error.field)) first.set(error.field, error);
  return SEARCH_FORM_FIELDS.flatMap((field) => first.get(field) ?? []);
}

/**
 * Room fields below {@link SEARCH_FORM_ROOMS_MIN} that the schema accepted on their own (fields
 * with a schema error keep that error).
 */
export function roomsBelowFormMinimum(
  values: Pick<SearchFormValues, (typeof ROOM_FIELDS)[number]>,
  schemaErrorFields: ReadonlySet<string>,
): (typeof ROOM_FIELDS)[number][] {
  return ROOM_FIELDS.filter((field) => {
    const value = normalizeDecimal(values[field]);
    return value !== '' && !schemaErrorFields.has(field) && Number(value) < SEARCH_FORM_ROOMS_MIN;
  });
}

/**
 * Validates the form before any API call (Req 7.2): returns the `SearchParams` to send, or the
 * invalid fields with message keys. Rules are those of the shared `SearchQuery` schema (Req 4.7) —
 * bounds from `LISTING_BOUNDS`, rooms in steps of 0.5, Min ≤ Max, known taxonomy codes — plus the
 * mandatory offer type `SALE`|`RENT` (Req 12.10) and at least one room. `values` is never modified.
 */
export function validateSearchForm(
  values: SearchFormValues,
  meta: SearchMeta = FALLBACK_SEARCH_META,
): SearchFormResult {
  const query = toRawQuery(values);
  const errors: SearchFormError[] = [];
  if (values.offerType === null || !OFFER_TYPES.includes(values.offerType)) {
    errors.push({ field: 'offerType', messageKey: 'search.error.offerType' });
  }
  const parsed = parseSearchQuery({ ...query }, meta.schemas);
  const schemaErrors = parsed.ok ? [] : parsed.error.map(toFormError);
  errors.push(...schemaErrors);
  for (const field of roomsBelowFormMinimum(values, new Set(schemaErrors.map((e) => e.field)))) {
    errors.push({ field, messageKey: 'search.error.rooms', params: ROOMS_PARAMS });
  }
  return errors.length > 0 ? { errors: byField(errors) } : { params: query };
}
