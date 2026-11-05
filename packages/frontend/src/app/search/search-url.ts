// Framework-free mapping between a search and the start page URL (`/?offerType=SALE&city=…`), so
// searches are deep-linkable and the browser history restores them. The query parameters are the
// form fields (= `SearchParams` names, `SEARCH_FORM_FIELDS`); unknown parameters are ignored.
// Kept free of Angular for plain Jest tests.
import { OFFER_TYPES, type OfferType } from '@open-estate/shared';
import type { SearchParams } from '../api/api-client';
import { roomsChipValue } from './rooms-chips';
import {
  INITIAL_SEARCH_FORM_VALUES,
  SEARCH_FORM_FIELDS,
  type SearchFormValues,
} from './validate-search-form';

/** Router query parameters (`ActivatedRoute.queryParams`). */
export type QueryParams = Readonly<Record<string, unknown>>;

function first(value: unknown): string | undefined {
  const item = Array.isArray(value) ? (value as unknown[])[0] : value;
  return typeof item === 'string' ? item : undefined;
}

/**
 * A URL shows a search (and opens the page in the "searched" layout) when it names an offer
 * type — every search sent by the form does. `?country=XX` alone only preselects the country.
 */
export function isSearchQuery(query: QueryParams): boolean {
  return first(query['offerType']) !== undefined;
}

/**
 * Form values of a search URL, or `undefined` if the URL holds no search. Values are taken as
 * typed (validation happens like on submit); an unknown offer type becomes `null` so the form
 * reports it. `roomsMin` is normalized to its chip ("2.0" → "2").
 */
export function formValuesFromQuery(query: QueryParams): Required<SearchFormValues> | undefined {
  if (!isSearchQuery(query)) return undefined;
  const values: Required<SearchFormValues> = { ...INITIAL_SEARCH_FORM_VALUES };
  for (const field of SEARCH_FORM_FIELDS) {
    const text = first(query[field]);
    if (text === undefined) continue;
    switch (field) {
      case 'offerType':
        values.offerType = (OFFER_TYPES as readonly string[]).includes(text)
          ? (text as OfferType)
          : null;
        break;
      case 'hasTour':
        values.hasTour = text === 'true';
        break;
      case 'roomsMin':
        values.roomsMin = roomsChipValue(text);
        break;
      default:
        values[field] = text;
    }
  }
  return values;
}

/** Query parameters for the URL of a validated search (only form fields, in form order). */
export function searchQueryParams(params: SearchParams): Record<string, string> {
  const query: Record<string, string> = {};
  for (const field of SEARCH_FORM_FIELDS) {
    const value = params[field];
    if (value === undefined || value === '' || value === false) continue;
    query[field] = String(value);
  }
  return query;
}

/** Whether a navigation switches between the start (hero) and the "searched" layout. */
export function isSearchLayoutChange(from: QueryParams, to: QueryParams): boolean {
  return isSearchQuery(from) !== isSearchQuery(to);
}

/**
 * Query parameter of the listing opened from the results (`/?offerType=SALE&listing=<id>`): the
 * detail view survives a reload, and back/forward close and reopen it. Not a form field, so a new
 * search drops it.
 */
export const LISTING_QUERY_PARAM = 'listing';

/** Upper bound for an id taken from the URL (listing ids are far shorter). */
const MAX_LISTING_ID_LENGTH = 200;

/** Id of the listing opened in a search URL; `undefined` without a (plausible) one. */
export function listingIdFromQuery(query: QueryParams): string | undefined {
  if (!isSearchQuery(query)) return undefined;
  const id = first(query[LISTING_QUERY_PARAM])?.trim();
  return id === undefined || id === '' || id.length > MAX_LISTING_ID_LENGTH ? undefined : id;
}

/** Same form values (compared field by field), so opening a listing does not re-run the search. */
export function sameFormValues(
  a: Required<SearchFormValues> | undefined,
  b: Required<SearchFormValues> | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return SEARCH_FORM_FIELDS.every((field) => a[field] === b[field]);
}
