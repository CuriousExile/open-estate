import { ListingBase, type Listing } from '@open-estate/shared';
import { toSearchDocument, type SearchDocument } from './search-document';

// Key layout of the `Listings` table shared by infra (DataStack), writers (seed, indexer) and the
// DynamoDB provider (design: "Indexierungs-Strategie und Ordnung").

/** GSI that orders all listings by `id`: constant partition key, sort key `id`, projection ALL. */
export const LISTINGS_BY_ID_INDEX = 'byId';
/** Partition key attribute of {@link LISTINGS_BY_ID_INDEX}; every listing item must carry it. */
export const LISTINGS_BY_ID_PK_ATTRIBUTE = 'gsiPk';
/** Constant value of {@link LISTINGS_BY_ID_PK_ATTRIBUTE}. */
export const LISTINGS_BY_ID_PK_VALUE = 'L';

/**
 * GSI over the listings of one data source: partition key `source`, sort key `id` (infra 10.15).
 * Used by source-based deletion requests (Req 18.4, 18.9). Both attributes are top-level listing
 * attributes, so no extra item attribute is needed.
 */
export const LISTINGS_BY_SOURCE_INDEX = 'bySource';

/** Stored item: internal listing + flat search fields + `byId` partition key. */
export type ListingItem = Listing &
  SearchDocument & { [LISTINGS_BY_ID_PK_ATTRIBUTE]: typeof LISTINGS_BY_ID_PK_VALUE };

// Top-level keys present in both shapes. They must carry identical values; today that holds by
// construction (`id`, `listingType` are copied verbatim). Adding a further overlapping key breaks
// this assertion at compile time, so a collision cannot slip in silently.
type SharedKeys = keyof Listing & keyof SearchDocument;
const sharedKeysAreKnown: [SharedKeys] extends ['id' | 'listingType'] ? true : never = true;
void sharedKeysAreKnown;

/** Single source for the item layout of the `Listings` table (seed writer, indexer, provider). */
export function toListingItem(listing: Listing): ListingItem {
  return {
    ...listing,
    ...toSearchDocument(listing),
    [LISTINGS_BY_ID_PK_ATTRIBUTE]: LISTINGS_BY_ID_PK_VALUE,
  };
}

const LISTING_KEYS: ReadonlySet<string> = new Set(Object.keys(ListingBase.shape));

/**
 * Inverse of {@link toListingItem}: keeps only the listing's own top-level attributes and drops the
 * search fields and `gsiPk`. Not re-validated: the `Listing` schema parses the API representation
 * (decimal strings), not stored minor units, and every item is written by `toListingItem` from an
 * already validated listing — re-parsing would only cost latency on each search.
 */
export function fromListingItem(item: Record<string, unknown>): Listing {
  return Object.fromEntries(
    Object.entries(item).filter(([key]) => LISTING_KEYS.has(key)),
  ) as Listing;
}
