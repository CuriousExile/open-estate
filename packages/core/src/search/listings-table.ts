import {
  CustomId,
  EntityId,
  FieldSourcesSchema,
  IsoDateTime,
  ListingBase,
  ListingStatusSchema,
  OriginSchema,
  VersionNumber,
  type FieldSources,
  type Listing,
  type ListingStatus,
  type Origin,
} from '@open-estate/shared';
import { z } from 'zod';
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

// Management attributes of a `Listings` item (design: "DynamoDB-Tabellen", listing management).
// They are stored next to the listing but are not part of the `Listing` schema: Search_API and MCP
// never see them because `fromListingItem` keeps only the listing's own attributes.

/** Verwaltungsdaten of a listing: status, owner, origin, Custom_Id, version, hash, Feldherkunft. */
export interface ListingManagement {
  status: ListingStatus;
  agencyId?: string;
  origin: Origin;
  customId?: string;
  /** Current version number; condition attribute of optimistic concurrency (Req 4.8). */
  version: number;
  /** Inhalts_Hash of the current Listing_Inhalt (`contentHash` from `shared`). */
  contentHash: string;
  /** Keys = `contentPaths(content)` after every write (Req 7.2). */
  fieldSources: FieldSources;
  /** ISO-8601 with offset; time of the current version. */
  updatedAt: string;
}

export const listingManagementSchema = z.object({
  status: ListingStatusSchema,
  agencyId: EntityId.optional(),
  origin: OriginSchema,
  customId: CustomId.optional(),
  version: VersionNumber,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  fieldSources: FieldSourcesSchema,
  updatedAt: IsoDateTime,
});

/** Stored item of a managed listing: listing item plus {@link ListingManagement}. */
export type ManagedListingItem = ListingItem & ListingManagement;

// Management attributes must not collide with listing or search attributes, otherwise one would
// overwrite the other in the flat item (compile-time check like `sharedKeysAreKnown`).
const managementKeysAreDisjoint: [keyof ListingManagement & keyof ListingItem] extends [never]
  ? true
  : never = true;
void managementKeysAreDisjoint;

/** Item layout of a managed listing; `gsiPk` and search fields come from {@link toListingItem}. */
export function toManagedListingItem(
  listing: Listing,
  management: ListingManagement,
): ManagedListingItem {
  const attributes: Partial<ListingManagement> = { ...management };
  // Absent optional attributes are omitted instead of being written as `undefined`.
  if (attributes.agencyId === undefined) delete attributes.agencyId;
  if (attributes.customId === undefined) delete attributes.customId;
  return { ...toListingItem(listing), ...(attributes as ListingManagement) };
}

/**
 * Splits a stored item into the public listing (as {@link fromListingItem}) and its validated
 * management attributes; malformed management data throws instead of being guessed.
 */
export function fromManagedListingItem(item: object): {
  listing: Listing;
  management: ListingManagement;
} {
  const management = listingManagementSchema.parse(item) as ListingManagement;
  return { listing: fromListingItem(item as Record<string, unknown>), management };
}
