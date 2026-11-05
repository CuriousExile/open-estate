// Framework-free model of the listing overview (design: ListingTableComponent; Req 4.14, 5.2).
// Filters are validated with the `ListListingsQuery` schema of the Management_API; paging follows
// the opaque `nextPageToken` and remembers the tokens of earlier pages for "previous".
import { ListListingsQuery, LISTING_BOUNDS, MANAGEMENT_BOUNDS } from '@open-estate/shared';

/** Filter inputs as typed; `''` = no filter. */
export interface ListingFilterValues {
  q: string;
  status: string;
  origin: string;
  offerType: string;
  listingType: string;
  customId: string;
}

export const LISTING_FILTER_FIELDS = [
  'q',
  'status',
  'origin',
  'offerType',
  'listingType',
  'customId',
] as const satisfies readonly (keyof ListingFilterValues)[];
export type ListingFilterField = (typeof LISTING_FILTER_FIELDS)[number];

export const EMPTY_FILTERS: ListingFilterValues = {
  q: '',
  status: '',
  origin: '',
  offerType: '',
  listingType: '',
  customId: '',
};

export interface FilterError {
  field: ListingFilterField;
  messageKey: string;
  params?: Readonly<Record<string, number>>;
}

/** Query parameters of `GET /listings`; empty filters are omitted. */
export type ListingQuery = Partial<Record<ListingFilterField, string>>;

const TEXT_BOUNDS: Partial<Record<ListingFilterField, { min: number; max: number }>> = {
  q: MANAGEMENT_BOUNDS.titleQuery,
  customId: MANAGEMENT_BOUNDS.customId,
  listingType: LISTING_BOUNDS.listingType,
};

const FIELD_SET: ReadonlySet<string> = new Set(LISTING_FILTER_FIELDS);

/** Validates the filters with the API's query schema; returns the query or one error per field. */
export function validateFilters(
  values: ListingFilterValues,
): { ok: true; query: ListingQuery } | { ok: false; errors: FilterError[] } {
  const query: ListingQuery = {};
  for (const field of LISTING_FILTER_FIELDS) {
    const value = values[field].trim();
    if (value !== '') query[field] = value;
  }
  const result = ListListingsQuery.safeParse(query);
  if (result.success) return { ok: true, query };
  const errors = new Map<ListingFilterField, FilterError>();
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (typeof field !== 'string' || !FIELD_SET.has(field)) continue;
    const name = field as ListingFilterField;
    if (errors.has(name)) continue;
    const bounds = TEXT_BOUNDS[name];
    errors.set(
      name,
      bounds
        ? { field: name, messageKey: 'portal.listings.error.text', params: { ...bounds } }
        : { field: name, messageKey: 'portal.listings.error.invalid' },
    );
  }
  return { ok: false, errors: LISTING_FILTER_FIELDS.flatMap((f) => errors.get(f) ?? []) };
}

/**
 * Position in a token-paged list: `tokens[i]` is the token of page `i` (`undefined` for the first
 * page). Immutable; each step returns a new pager.
 */
export interface Pager {
  readonly tokens: readonly (string | undefined)[];
  readonly index: number;
}

export const FIRST_PAGE: Pager = { tokens: [undefined], index: 0 };

export const currentToken = (pager: Pager): string | undefined => pager.tokens[pager.index];

/** Next page with the `nextPageToken` of the current page; earlier tokens are kept. */
export function nextPage(pager: Pager, nextPageToken: string): Pager {
  return {
    tokens: [...pager.tokens.slice(0, pager.index + 1), nextPageToken],
    index: pager.index + 1,
  };
}

export function previousPage(pager: Pager): Pager {
  return pager.index === 0 ? pager : { tokens: pager.tokens, index: pager.index - 1 };
}

/** Date and time of the last change in the active locale; the raw value if unparseable. */
export function formatTimestamp(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}
