import {
  convertBounds,
  decodeCursor,
  encodeCursor,
  err,
  exchangeCurrencies,
  ok,
  queryHash,
  typesOfGroup,
  type ApiError,
  type ExchangeRatesConfig,
  type LocalePreference,
  type LocalizedListing,
  type Result,
  type SearchQuery,
  type Taxonomy,
  type TourProvidersConfig,
} from '@open-estate/shared';
import { localize } from './localize';
import { normalizeCity } from './search-document';
import type {
  IntRange,
  OfferCondition,
  PriceCondition,
  PriceConditions,
  ResolvedQuery,
  SearchProvider,
} from './search-provider';
import { NO_SUSPENDED_AGENCIES, type SuspendedAgencies } from './suspended-agencies';
import { NO_USAGE, type UsageRecorder } from '../usage/usage-line';

// SearchService (design: "Domänenkern", "Indexierungs-Strategie und Ordnung"). Expected request
// errors (`INVALID_PAGE_TOKEN`) are returned as `Result`, like `parseSearchQuery` and the
// AccessGuard; provider failures stay exceptions and are mapped to 503 by the adapters.

export interface Page<T> {
  items: T[];
  /** Opaque cursor of the next page; set iff more matching listings follow (Req 1.7). */
  nextPageToken?: string;
}

export interface SearchService {
  search(
    query: SearchQuery,
    prefs: readonly LocalePreference[],
  ): Promise<Result<Page<LocalizedListing>, ApiError[]>>;
}

export interface SearchServiceDeps {
  provider: SearchProvider;
  /** Validated taxonomy loaded at init; groups are resolved against it per request (Req 15.5). */
  taxonomy: Taxonomy;
  /** Current tour allow-list; `hasTour` is resolved against it per request (Req 16.9). */
  tourProviders: TourProvidersConfig;
  /** ISO 4217 code used when a price filter has no `currency` (Req 12.9). */
  defaultCurrency: string;
  /**
   * Static exchange rates (`exchange-rates.json`) for `convertCurrency=true`; without them a price
   * filter only matches offers in its own currency.
   */
  exchangeRates?: ExchangeRatesConfig | undefined;
  /**
   * Suspended agencies, resolved per request into `excludeAgencies` (Req 1.9). Defaults to none
   * (no `Agencies` table, e.g. local development).
   */
  suspendedAgencies?: SuspendedAgencies;
  /** Search impressions of every successful page (Req 13.4); defaults to none. */
  usage?: UsageRecorder;
}

/**
 * Hash binding a cursor to its query. `lang` and `pageToken` are excluded: neither changes the
 * result set or its order (language only selects title/description per listing), so switching the
 * language while paging must keep the cursor valid.
 */
export function searchQueryHash(query: SearchQuery): string {
  const filters: Record<string, unknown> = { ...query };
  delete filters['lang'];
  return queryHash({ ...filters, pageSize: query.pageSize });
}

function range(min: number | undefined, max: number | undefined): IntRange | undefined {
  if (min === undefined && max === undefined) return undefined;
  return { ...(min !== undefined && { min }), ...(max !== undefined && { max }) };
}

const toHalf = (rooms: number | undefined): number | undefined =>
  rooms === undefined ? undefined : Math.round(rooms * 2);

export function createSearchService(deps: SearchServiceDeps): SearchService {
  const { provider, taxonomy, defaultCurrency, exchangeRates } = deps;
  const suspendedAgencies = deps.suspendedAgencies ?? NO_SUSPENDED_AGENCIES;
  const usage = deps.usage ?? NO_USAGE;
  const allowedTourHosts = [
    ...new Set(
      deps.tourProviders.providers.flatMap((p) => p.hostnames.map((h) => h.toLowerCase())),
    ),
  ].sort();

  function offerCondition(q: SearchQuery): OfferCondition {
    if (q.offerType === undefined) return {};
    const price = range(q.priceMin, q.priceMax);
    return {
      offerType: q.offerType,
      ...(price && { price: priceConditions(price, q.currency ?? defaultCurrency, q) }),
    };
  }

  /**
   * The requested currency first; with `convertCurrency=true` and a rate for it, also every other
   * configured currency with the converted bounds (empty converted ranges are left out).
   */
  function priceConditions(price: IntRange, currency: string, q: SearchQuery): PriceConditions {
    const requested: PriceCondition = { ...price, currency };
    if (q.convertCurrency !== true || exchangeRates === undefined) return [requested];
    const converted = exchangeCurrencies(exchangeRates)
      .filter((code) => code !== currency)
      .flatMap((code) => {
        const bounds = convertBounds(exchangeRates, price, currency, code);
        return bounds === undefined ? [] : [{ ...bounds, currency: code }];
      });
    return [requested, ...converted];
  }

  function listingTypes(q: SearchQuery): readonly string[] | undefined {
    // Unknown groups are rejected by `parseSearchQuery`; `?? []` keeps an unknown code matchless.
    if (q.group !== undefined) return typesOfGroup(taxonomy, q.group) ?? [];
    return q.types;
  }

  function resolve(
    q: SearchQuery,
    after: string | undefined,
    suspended: ReadonlySet<string>,
  ): ResolvedQuery {
    const roomsHalf = range(toHalf(q.roomsMin), toHalf(q.roomsMax));
    const areaMinor = range(q.areaMin, q.areaMax);
    const types = listingTypes(q);
    return {
      ...offerCondition(q),
      ...(roomsHalf && { roomsHalf }),
      ...(areaMinor && { areaMinor }),
      ...(q.city !== undefined && { cityNorm: normalizeCity(q.city) }),
      ...(q.postalCode !== undefined && { postalCode: q.postalCode }),
      ...(q.country !== undefined && { country: q.country }),
      ...(types !== undefined && { listingTypes: types }),
      // Only `hasTour=true` filters (Req 16.9); `false` means "no tour filter", not "without
      // tour". An empty allow-list yields no matches.
      ...(q.hasTour === true && { tourHosts: allowedTourHosts }),
      // Sorted for deterministic provider queries; omitted when no agency is suspended.
      ...(suspended.size > 0 && { excludeAgencies: [...suspended].sort() }),
      pageSize: q.pageSize,
      ...(after !== undefined && { after }),
    };
  }

  return {
    async search(query, prefs) {
      const hash = searchQueryHash(query);
      let after: string | undefined;
      if (query.pageToken !== undefined) {
        const cursor = decodeCursor(query.pageToken, hash);
        if (!cursor.ok) return err([cursor.error]);
        after = cursor.value.lastId;
      }

      const suspended = await suspendedAgencies.current();
      const result = await provider.search(resolve(query, after, suspended));
      const items = result.items.map((listing) => localize(listing, prefs, taxonomy));
      usage.record(
        'impression',
        result.items.map(({ id }) => {
          const agencyId = result.owners?.[id];
          return agencyId === undefined ? { id } : { id, agencyId };
        }),
      );
      return ok({
        items,
        ...(result.next && {
          nextPageToken: encodeCursor({ v: 1, lastId: result.next.lastId, queryHash: hash }),
        }),
      });
    },
  };
}
