// Framework-free logic of the result list (design: ResultListComponent; Req 7.3, 7.4, 7.6, 7.7).
// Kept free of Angular imports so it can be unit-tested with plain Jest.
import { SEARCH_QUERY_BOUNDS, type LocalizedListing, type OfferType } from '@open-estate/shared';
import type {
  ApiResult,
  ClientError,
  RequestOptions,
  SearchPage,
  SearchParams,
} from '../api/api-client';
import {
  formatMoney,
  formatNumber,
  formatPrice,
  offerAmount,
  selectOffer,
  type DisplayCurrency,
} from '../listing/listing-format';

// Moved to ../listing/listing-format (shared with the detail view); re-exported for existing importers.
export { formatMoney, formatNumber, offerAmount, selectOffer };

/** Listings per result page (Req 7.3). */
export const RESULT_PAGE_SIZE = SEARCH_QUERY_BOUNDS.pageSize.default;

/** One row of the result list, formatted for the active locale (Req 7.4). */
export interface ResultRow {
  readonly listing: LocalizedListing;
  readonly id: string;
  readonly title: string;
  /** Locale of the delivered title (Req 14.7); set as `lang` on the title. */
  readonly titleLocale: string;
  /** Offer type of the shown offer — the filtered one. Label via `offerType.<code>`. */
  readonly offerType: OfferType | undefined;
  readonly city: string;
  /** Amount with currency of the shown offer; `undefined` if the listing has no offer. */
  readonly price: string | undefined;
  /** Original amount if `price` is converted into the display currency (approximate). */
  readonly priceOriginal?: string;
  readonly rooms: string;
  readonly area: string;
  /** Listing type code; label via `taxonomy.type.<code>`. */
  readonly listingType: string;
}

export function toResultRow(
  listing: LocalizedListing,
  offerType: OfferType | undefined,
  locale: string,
  display?: DisplayCurrency,
): ResultRow {
  const offer = selectOffer(listing, offerType);
  const price = offer && formatPrice(offerAmount(offer), offer.currency, locale, display);
  return {
    listing,
    id: listing.id,
    title: listing.title,
    titleLocale: listing.deliveredLocale,
    offerType: offer?.offerType ?? offerType,
    city: listing.address.city,
    price: price?.value,
    ...(price?.original !== undefined && { priceOriginal: price.original }),
    rooms: formatNumber(listing.rooms, locale),
    area: formatNumber(listing.area, locale),
    listingType: listing.listingType,
  };
}

/** Translation key and parameters of a human-readable error message (Req 7.7). */
export interface ResultErrorMessage {
  readonly key: string;
  readonly params?: Readonly<Record<string, number>>;
}

/** Message for a failed search; `undefined` for a search cancelled by a newer one. */
export function resultErrorMessage(error: ClientError): ResultErrorMessage | undefined {
  switch (error.kind) {
    case 'aborted':
      return undefined;
    case 'timeout':
      return { key: 'results.error.timeout', params: { seconds: error.timeoutMs / 1000 } };
    case 'network':
      return { key: 'results.error.network' };
    case 'invalid-response':
      return { key: 'results.error.server' };
    case 'api':
      if (error.status === 429) {
        return error.retryAfterSeconds === undefined
          ? { key: 'results.error.rateLimited' }
          : { key: 'results.error.rateLimitedRetry', params: { seconds: error.retryAfterSeconds } };
      }
      return { key: error.status < 500 ? 'results.error.request' : 'results.error.server' };
  }
}

export type SearchPageFn = (
  params: SearchParams,
  options: RequestOptions,
) => Promise<ApiResult<SearchPage>>;

/** Snapshot of the result list. Loaded pages are kept, so going back needs no request. */
export interface ResultListState {
  /** `true` once a search was started; before that nothing is shown. */
  readonly searched: boolean;
  /** Offer type filtered by the search that produced the pages. */
  readonly offerType: OfferType | undefined;
  readonly pages: readonly SearchPage[];
  /** Index of the shown page in `pages`. */
  readonly pageIndex: number;
  readonly loading: boolean;
  /** Error of the last request; the shown page (if any) stays visible. */
  readonly error: ClientError | undefined;
}

export const INITIAL_RESULT_STATE: ResultListState = {
  searched: false,
  offerType: undefined,
  pages: [],
  pageIndex: 0,
  loading: false,
  error: undefined,
};

/** Page currently shown, if loaded. */
export function currentPage(state: ResultListState): SearchPage | undefined {
  return state.pages[state.pageIndex];
}

/** "No results" notice (Req 7.6): first page loaded and empty. */
export function isEmptyResult(state: ResultListState): boolean {
  return state.pageIndex === 0 && currentPage(state)?.items.length === 0;
}

export function hasNextPage(state: ResultListState): boolean {
  return (
    state.pages.length > state.pageIndex + 1 || currentPage(state)?.nextPageToken !== undefined
  );
}

export interface ResultLoader {
  /** Starts a new search; cancels a running one and discards the loaded pages. */
  search(params: SearchParams): void;
  /** Shows the next page (cached or fetched with `nextPageToken`). */
  next(): void;
  previous(): void;
  /** Repeats the last failed request. */
  retry(): void;
  /** Cancels a running request (e.g. on destroy). */
  cancel(): void;
}

/**
 * Loads result pages of {@link RESULT_PAGE_SIZE} listings and reports every state change to
 * `onChange`. Only the latest request counts: an older answer arriving later is ignored.
 */
export function createResultLoader(
  fetchPage: SearchPageFn,
  onChange: (state: ResultListState) => void,
): ResultLoader {
  let state = INITIAL_RESULT_STATE;
  let params: SearchParams = {};
  let controller: AbortController | undefined;
  let lastRequest: { pageIndex: number; pageToken: string | undefined } | undefined;

  const update = (patch: Partial<ResultListState>): void => {
    state = { ...state, ...patch };
    onChange(state);
  };

  async function load(pageIndex: number, pageToken: string | undefined): Promise<void> {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    lastRequest = { pageIndex, pageToken };
    update({ loading: true, error: undefined });

    const result = await fetchPage(
      { ...params, pageSize: RESULT_PAGE_SIZE, ...(pageToken !== undefined && { pageToken }) },
      { signal: current.signal },
    );
    if (controller !== current) return; // superseded by a newer request
    controller = undefined;
    if (!result.ok) {
      update({ loading: false, error: result.error });
      return;
    }
    lastRequest = undefined;
    update({
      loading: false,
      pages: [...state.pages.slice(0, pageIndex), result.value],
      pageIndex,
    });
  }

  return {
    search(next) {
      params = next;
      update({ ...INITIAL_RESULT_STATE, searched: true, offerType: next.offerType });
      void load(0, undefined);
    },
    next() {
      if (state.loading || !hasNextPage(state)) return;
      const pageIndex = state.pageIndex + 1;
      if (state.pages[pageIndex] !== undefined) {
        update({ pageIndex, error: undefined });
        return;
      }
      void load(pageIndex, currentPage(state)?.nextPageToken);
    },
    previous() {
      if (state.pageIndex === 0) return;
      controller?.abort();
      controller = undefined;
      lastRequest = undefined;
      update({ pageIndex: state.pageIndex - 1, loading: false, error: undefined });
    },
    retry() {
      if (state.loading || lastRequest === undefined) return;
      void load(lastRequest.pageIndex, lastRequest.pageToken);
    },
    cancel() {
      controller?.abort();
      controller = undefined;
    },
  };
}
