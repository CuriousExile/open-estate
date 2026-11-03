import type { AccessGuard, ListingService } from '@open-estate/core';
import {
  err,
  parseDetailQuery,
  resolvePreferences,
  type ApiError,
  type Schemas,
} from '@open-estate/shared';
import {
  collectQuery,
  errorResponse,
  guardedRoute,
  headerValue,
  okResponse,
  type ListingsHandler,
  type ListingsRequest,
} from './listings-handler';

// `GET /listings/{id}` (design: "Search_API", "Request-Pfade"): AccessGuard → parseDetailQuery
// (`id` from the path, `lang` from the query) → language preferences → ListingService →
// the full listing in the same API representation as the search (Req 2.1, 14.3, 14.7).

export interface ListingDetailHandlerDeps {
  guard: AccessGuard;
  /** Built once at init from the loaded taxonomy and locales. */
  schemas: Schemas;
  listings: ListingService;
}

const MALFORMED_ID: ApiError = {
  code: 'INVALID_ID',
  message: 'The listing id is not validly percent-encoded.',
  field: 'id',
};

/**
 * Listing id from the path. API Gateway REST passes path parameters as received (still
 * percent-encoded), so the id is decoded here; a malformed encoding is an invalid id (Req 2.3).
 * A missing parameter becomes `''` and is rejected by the schema (empty id, Req 2.3).
 */
export function pathListingId(event: ListingsRequest): { id: string; malformed: boolean } {
  const raw = event.pathParameters?.['id'] ?? '';
  try {
    return { id: decodeURIComponent(raw), malformed: false };
  } catch {
    return { id: raw, malformed: true };
  }
}

/** Validates path id and query together and collects all violations (design: "Prinzipien"). */
function parseRequest(event: ListingsRequest, schemas: Schemas) {
  const { id, malformed } = pathListingId(event);
  const query = parseDetailQuery({ ...collectQuery(event), id }, schemas);
  if (!malformed) return query;
  const others = query.ok ? [] : query.error.filter((e) => e.field !== 'id');
  return err([MALFORMED_ID, ...others]);
}

export function createListingDetailHandler({
  guard,
  schemas,
  listings,
}: ListingDetailHandlerDeps): ListingsHandler {
  return guardedRoute('GET /listings/{id}', guard, async (event) => {
    // `id` from the path wins over a query parameter of the same name.
    const query = parseRequest(event, schemas);
    if (!query.ok) return errorResponse(query.error);

    // `lang` overrides `Accept-Language`; the header never fails (Req 14.6, 14.8).
    const prefs = resolvePreferences({
      lang: query.value.lang,
      acceptLanguage: headerValue(event, 'Accept-Language'),
    });
    if (!prefs.ok) return errorResponse([prefs.error]);

    const listing = await listings.get(query.value.id, prefs.value);
    if (!listing.ok) return errorResponse(listing.error);
    return okResponse(listing.value);
  });
}
