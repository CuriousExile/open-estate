import type { LocationsDocument } from '@open-estate/shared';
import type { SearchProvider } from './search-provider';
import { NO_SUSPENDED_AGENCIES, type SuspendedAgencies } from './suspended-agencies';

// LocationService (`GET /locations`): countries and cities of the public listings with counts,
// for the country selector and the city autocomplete. Same visibility as the search: only
// `ACTIVE` listings, owners of suspended agencies excluded (Req 1.9).

export interface LocationService {
  locations(): Promise<LocationsDocument>;
}

export interface LocationServiceDeps {
  provider: Pick<SearchProvider, 'locations'>;
  /** Suspended agencies; defaults to none. */
  suspendedAgencies?: SuspendedAgencies;
}

export function createLocationService({
  provider,
  suspendedAgencies = NO_SUSPENDED_AGENCIES,
}: LocationServiceDeps): LocationService {
  return {
    async locations() {
      const suspended = await suspendedAgencies.current();
      return provider.locations(
        suspended.size > 0 ? { excludeAgencies: [...suspended].sort() } : {},
      );
    },
  };
}
