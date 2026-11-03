import {
  err,
  ok,
  type ApiError,
  type LocalePreference,
  type LocalizedListing,
  type Result,
  type Taxonomy,
} from '@open-estate/shared';
import { localize } from './localize';
import type { SearchProvider } from './search-provider';

// ListingService (design: "Domänenkern", Req 2.1, 2.2). Same error style as the SearchService:
// `NOT_FOUND` is an expected outcome and returned as `Result`; provider failures are exceptions.

export interface ListingService {
  get(
    id: string,
    prefs: readonly LocalePreference[],
  ): Promise<Result<LocalizedListing, ApiError[]>>;
}

export interface ListingServiceDeps {
  provider: SearchProvider;
  taxonomy: Taxonomy;
}

export function createListingService({ provider, taxonomy }: ListingServiceDeps): ListingService {
  return {
    async get(id, prefs) {
      const listing = await provider.getById(id);
      if (listing === null) {
        return err([{ code: 'NOT_FOUND', message: `Listing ${id} not found`, details: { id } }]);
      }
      return ok(localize(listing, prefs, taxonomy));
    },
  };
}
