import {
  err,
  isPublic,
  ok,
  type ApiError,
  type LocalePreference,
  type LocalizedListing,
  type Result,
  type Taxonomy,
} from '@open-estate/shared';
import { NO_USAGE, type UsageRecorder } from '../usage/usage-line';
import { localize } from './localize';
import type { SearchProvider } from './search-provider';
import { NO_SUSPENDED_AGENCIES, type SuspendedAgencies } from './suspended-agencies';

// ListingService (design: "Domänenkern", "Öffentliche Sichtbarkeit", Req 2.1, 2.2, 1.8, 1.9, 6.4).
// Same error style as the SearchService: `NOT_FOUND` is an expected outcome and returned as
// `Result`; provider failures are exceptions. Search_API and MCP_Server share this function.

export interface ListingService {
  get(
    id: string,
    prefs: readonly LocalePreference[],
  ): Promise<Result<LocalizedListing, ApiError[]>>;
}

export interface ListingServiceDeps {
  provider: SearchProvider;
  taxonomy: Taxonomy;
  /** Suspended agencies (Req 1.9); defaults to none. */
  suspendedAgencies?: SuspendedAgencies;
  /** Detail view of every successful call (Req 13.4); defaults to none. */
  usage?: UsageRecorder;
}

export function createListingService({
  provider,
  taxonomy,
  suspendedAgencies = NO_SUSPENDED_AGENCIES,
  usage = NO_USAGE,
}: ListingServiceDeps): ListingService {
  return {
    async get(id, prefs) {
      const stored = await provider.getById(id);
      // The suspended set is only needed for listings owned by an agency.
      const agencyId = stored?.visibility.agencyId;
      const suspended =
        agencyId === undefined ? new Set<string>() : await suspendedAgencies.current();
      // Unknown and non-public listings yield the identical error (Req 6.4).
      if (stored === null || !isPublic(stored.visibility, suspended)) {
        return err([{ code: 'NOT_FOUND', message: `Listing ${id} not found`, details: { id } }]);
      }
      const localized = localize(stored.listing, prefs, taxonomy);
      usage.record('detail', [
        agencyId === undefined ? { id: stored.listing.id } : { id: stored.listing.id, agencyId },
      ]);
      return ok(localized);
    },
  };
}
