import type { AccessGuard, LocationService } from '@open-estate/core';
import { guardedRoute, type ListingsHandler } from './listings-handler';

// `GET /locations` (Search_API): countries and cities that currently have public listings, with
// counts — the source of the frontend's country selector and city autocomplete. Same AccessGuard
// (access mode, API key, rate limit) and error handling as every other Search_API route. Query
// parameters are not specified and are ignored.

/**
 * Browsers may reuse the document for 5 minutes (as long as the DynamoDB provider caches its rows);
 * `private` keeps shared caches out because every request passes the AccessGuard.
 */
export const LOCATIONS_CACHE_CONTROL = 'private, max-age=300';

export interface LocationsHandlerDeps {
  guard: AccessGuard;
  locations: LocationService;
}

export function createLocationsHandler({
  guard,
  locations,
}: LocationsHandlerDeps): ListingsHandler {
  return guardedRoute('GET /locations', guard, async () => ({
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': LOCATIONS_CACHE_CONTROL,
    },
    body: JSON.stringify(await locations.locations()),
  }));
}
