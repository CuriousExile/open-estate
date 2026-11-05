import {
  CONTENT_FIELDS,
  formatDecimal,
  publicDetailUrl,
  type Listing,
  type ListingContent,
  type ListingContentInput,
  type ListingView,
  type Offer,
} from '@open-estate/shared';
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
    sourceUrlDerived:
      management.origin === 'MANUAL' &&
      listing.sourceUrl === publicDetailUrl(frontendOrigin, listing.id),
    source: listing.source,
    lastImportedAt: listing.lastImportedAt,
    lastRunId: listing.lastRunId,
    ...(droppedFields.length > 0 && { droppedFields: [...droppedFields] }),
  };
}
