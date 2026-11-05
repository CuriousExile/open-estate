import type { ListingStatus } from './management';

// Public visibility (design: "Öffentliche Sichtbarkeit", Req 1.8, 1.9, 6.3, 6.4). Search_API and
// MCP_Server deliver exactly the listings for which `isPublic` holds; the stored status is never
// changed by an agency suspension.

/**
 * `true` iff the listing is `ACTIVE` and not owned by a suspended agency. Listings without an
 * owning agency are only governed by their status.
 */
export function isPublic(
  listing: { status: ListingStatus; agencyId?: string },
  suspendedAgencies: ReadonlySet<string>,
): boolean {
  return (
    listing.status === 'ACTIVE' &&
    !(listing.agencyId !== undefined && suspendedAgencies.has(listing.agencyId))
  );
}
