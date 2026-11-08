import {
  CONTENT_FIELDS,
  duplicateFlagOf,
  formatDecimal,
  isOlder,
  publicDetailUrl,
  withDuplicateFlag,
  type Listing,
  type ListingContent,
  type ListingContentInput,
  type ListingView,
  type Offer,
  type Principal,
} from '@open-estate/shared';
import { creationTime } from '../search/listings-table';
import type { ManagedListing } from './listing-store';

// Management_API representation of a stored listing (`ListingView`, Req 4.13) and the conversion
// of a Listing_Inhalt from the internal (minor units) to the API representation (decimal strings).

function offerToInput(offer: Offer): ListingContentInput['offers'][number] {
  if (offer.offerType === 'SALE') {
    return { offerType: 'SALE', price: formatDecimal(offer.price), currency: offer.currency };
  }
  return {
    offerType: 'RENT',
    coldRent: formatDecimal(offer.coldRent),
    currency: offer.currency,
    ...(offer.additionalCosts !== undefined && {
      additionalCosts: formatDecimal(offer.additionalCosts),
    }),
    ...(offer.warmRent !== undefined && { warmRent: formatDecimal(offer.warmRent) }),
  };
}

/**
 * Listing_Inhalt in the API representation: amounts and area as decimal strings, restricted to
 * the content fields (a full `Listing` may be passed). Parsing the result with the content schema
 * yields the input again, so restored snapshots can be re-validated against the current rules.
 */
export function contentToInput(content: ListingContent | Listing): ListingContentInput {
  const source = content as Record<string, unknown>;
  const picked = Object.fromEntries(
    CONTENT_FIELDS.flatMap((field) =>
      source[field] === undefined ? [] : [[field, structuredClone(source[field])]],
    ),
  ) as ListingContent;
  return {
    ...picked,
    offers: picked.offers.map(offerToInput),
    area: formatDecimal(picked.area),
    // Objektmerkmal `plotArea` is a decimal string in the API representation, too.
    ...(picked.plotArea !== undefined && { plotArea: formatDecimal(picked.plotArea) }),
  } as ListingContentInput;
}

/**
 * `ListingView` of a stored listing. `sourceUrlDerived`: `MANUAL` listing whose `sourceUrl` is the
 * Öffentliche_Detail_URL for `frontendOrigin` (Req 4.5). `droppedFields` only if non-empty.
 */
export function toListingView(
  { listing, management }: ManagedListing,
  frontendOrigin: string,
  droppedFields: readonly string[] = [],
): ListingView {
  return {
    id: listing.id,
    content: contentToInput(listing),
    status: management.status,
    origin: management.origin,
    ...(management.customId !== undefined && { customId: management.customId }),
    ...(management.agencyId !== undefined && { agencyId: management.agencyId }),
    version: management.version,
    updatedAt: management.updatedAt,
    fieldSources: structuredClone(management.fieldSources),
    createdAt: creationTime({ listing, management }),
    flags: structuredClone(management.flags ?? []),
    sourceUrlDerived:
      management.origin === 'MANUAL' &&
      listing.sourceUrl === publicDetailUrl(frontendOrigin, listing.id),
    source: listing.source,
    lastImportedAt: listing.lastImportedAt,
    lastRunId: listing.lastRunId,
    ...(droppedFields.length > 0 && { droppedFields: [...droppedFields] }),
  };
}

// ---------------------------------------------------------------------------------------------
// Isolation of Markierungen (duplicate-detection Req 7.6)
// ---------------------------------------------------------------------------------------------

/** Reads the listings a view names; only `get` is needed. */
export interface ReferencedListings {
  get(id: string): Promise<ManagedListing | null>;
}

/** Agency of an agency actor; `undefined` for Plattform_Admins, who see every id. */
function viewerAgency(viewer: Principal): string | null | undefined {
  if (viewer.kind === 'user' && viewer.role === 'PLATFORM_ADMIN') return undefined;
  return viewer.agencyId ?? null;
}

/**
 * The listings among `ids` that an agency actor may see: those currently owned by its agency. A
 * Markierung names listings of the listing's Prüfbereich when it is written, but a Treffer may
 * have moved to another agency since; until the next write or Duplikat_Abgleich renews it, the
 * foreign ids must not reach the actor.
 */
async function visibleListings(
  ids: readonly string[],
  agencyId: string | null,
  listings: ReferencedListings,
): Promise<Map<string, ManagedListing>> {
  const visible = new Map<string, ManagedListing>();
  for (const id of new Set(ids)) {
    const found = agencyId === null ? null : await listings.get(id);
    if (found !== null && found.management.agencyId === agencyId) visible.set(id, found);
  }
  return visible;
}

/**
 * `ListingView` as `viewer` may see it (Req 7.6): for agency actors, Treffer of other agencies are
 * left out of the Duplikat_Markierung; if the Original is one of them, the oldest remaining
 * Treffer is named instead, and without any remaining Treffer the Markierung is not shown.
 */
export async function scopeListingView(
  view: ListingView,
  viewer: Principal,
  listings: ReferencedListings,
): Promise<ListingView> {
  const agencyId = viewerAgency(viewer);
  const flag = duplicateFlagOf(view.flags);
  if (agencyId === undefined || flag === undefined) return view;
  const ids = [flag.originalId, ...flag.matches.map((match) => match.listingId)];
  const visible = await visibleListings(ids, agencyId, listings);
  if (visible.size === new Set(ids).size) return view;
  const matches = flag.matches.filter((match) => visible.has(match.listingId));
  if (matches.length === 0) return { ...view, flags: withDuplicateFlag(view.flags, null) };
  const oldest = [...visible.values()]
    .filter((listing) => matches.some((match) => match.listingId === listing.listing.id))
    .map((listing) => ({ listingId: listing.listing.id, createdAt: creationTime(listing) }))
    .reduce((a, b) => (isOlder(a, b) ? a : b));
  const originalId = visible.has(flag.originalId) ? flag.originalId : oldest.listingId;
  return { ...view, flags: withDuplicateFlag(view.flags, { ...flag, originalId, matches }) };
}

/**
 * Whether `viewer` may see a Statusbegründung naming `originalId` (Req 7.6): Plattform_Admins
 * always, agency actors while the Original belongs to their agency.
 */
export async function showsStatusReason(
  originalId: string,
  viewer: Principal,
  listings: ReferencedListings,
): Promise<boolean> {
  const agencyId = viewerAgency(viewer);
  if (agencyId === undefined) return true;
  return (await visibleListings([originalId], agencyId, listings)).has(originalId);
}
