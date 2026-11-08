import {
  CustomId,
  EntityId,
  FieldSourcesSchema,
  flagCodes,
  ListingFlagsSchema,
  type FlagCode,
  type ListingFlag,
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

/**
 * Sparse GSI that orders the publicly visible listings by `id`: constant partition key, sort key
 * `id`, projection ALL. Only `ACTIVE` listings carry the partition key, so inactive ones are
 * neither found by the DynamoDB provider nor indexed (design: "Öffentliche Sichtbarkeit").
 */
export const LISTINGS_BY_ID_INDEX = 'byId';
/** Partition key attribute of {@link LISTINGS_BY_ID_INDEX}; set only on `ACTIVE` listings. */
export const LISTINGS_BY_ID_PK_ATTRIBUTE = 'gsiPk';
/** Constant value of {@link LISTINGS_BY_ID_PK_ATTRIBUTE}. */
export const LISTINGS_BY_ID_PK_VALUE = 'L';

/**
 * GSI over the listings of one data source: partition key `source`, sort key `id` (infra 10.15).
 * Used by source-based deletion requests (Req 18.4, 18.9). Both attributes are top-level listing
 * attributes, so no extra item attribute is needed.
 */
export const LISTINGS_BY_SOURCE_INDEX = 'bySource';

/** Stored item: internal listing + flat search fields + `byId` partition key (`ACTIVE` only). */
export type ListingItem = Listing &
  SearchDocument & { [LISTINGS_BY_ID_PK_ATTRIBUTE]?: typeof LISTINGS_BY_ID_PK_VALUE };

/** Management data that decides the public visibility of an item (status, owning agency). */
export type ListingVisibility = Pick<ListingManagement, 'status' | 'agencyId'>;

// Top-level keys present in both shapes. They must carry identical values; today that holds by
// construction (`id`, `listingType` are copied verbatim). Adding a further overlapping key breaks
// this assertion at compile time, so a collision cannot slip in silently.
type SharedKeys = keyof Listing & keyof SearchDocument;
const sharedKeysAreKnown: [SharedKeys] extends ['id' | 'listingType'] ? true : never = true;
void sharedKeysAreKnown;

/**
 * Single source for the item layout of the `Listings` table (seed writer, indexer, provider).
 * Without management data (seeded and legacy imported listings) the listing is `ACTIVE` without
 * agency and therefore public.
 */
export function toListingItem(
  listing: Listing,
  visibility: ListingVisibility = { status: 'ACTIVE' },
): ListingItem {
  return {
    ...listing,
    ...toSearchDocument(listing, visibility.agencyId),
    ...(visibility.status === 'ACTIVE'
      ? { [LISTINGS_BY_ID_PK_ATTRIBUTE]: LISTINGS_BY_ID_PK_VALUE }
      : {}),
  };
}

/** Whether a stored item is in the sparse {@link LISTINGS_BY_ID_INDEX}, i.e. `ACTIVE`. */
export function isIndexedListingItem(item: Record<string, unknown>): boolean {
  return item[LISTINGS_BY_ID_PK_ATTRIBUTE] === LISTINGS_BY_ID_PK_VALUE;
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
  /**
   * Anlagezeitpunkt: time of version 1, never changed afterwards (duplicate-detection Req 4.3).
   * The writer always sets it; read it through {@link creationTime}, which falls back for items
   * written without it.
   */
  createdAt?: string;
  /** Markierungen (duplicate-detection Req 7); absent = none. */
  flags?: ListingFlag[];
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
  createdAt: IsoDateTime.optional(),
  flags: ListingFlagsSchema.optional(),
});

/**
 * Attribute holding the codes of `flags` (a list of strings), so list queries can filter by
 * Markierungscode with `contains` (duplicate-detection Req 7.5). Derived on every write by
 * {@link toManagedListingItem}, never set by callers, so it cannot drift from `flags`.
 */
export const LISTING_FLAG_CODES_ATTRIBUTE = 'flagCodes';

/**
 * Anlagezeitpunkt of a managed listing (duplicate-detection Req 4.3): `createdAt`, else the
 * provenance timestamp (items written without `createdAt`, e.g. test fixtures).
 */
export function creationTime({
  listing,
  management,
}: {
  listing: Pick<Listing, 'lastImportedAt'>;
  management: Pick<ListingManagement, 'createdAt'>;
}): string {
  return management.createdAt ?? listing.lastImportedAt;
}

/** Stored item of a managed listing: listing item plus {@link ListingManagement}. */
export type ManagedListingItem = ListingItem &
  ListingManagement & { [LISTING_FLAG_CODES_ATTRIBUTE]?: FlagCode[] };

// Management attributes must not collide with listing or search attributes, otherwise one would
// overwrite the other in the flat item (compile-time check like `sharedKeysAreKnown`). The only
// overlap is `agencyId`: the search document copies it verbatim from the management data
// (`toManagedListingItem` passes it to `toListingItem`), so both carry the same value.
const managementKeysAreDisjoint: [keyof ListingManagement & keyof ListingItem] extends ['agencyId']
  ? true
  : never = true;
void managementKeysAreDisjoint;

/**
 * Item layout of a managed listing; `gsiPk` (only when `ACTIVE`) and search fields come from
 * {@link toListingItem}.
 */
export function toManagedListingItem(
  listing: Listing,
  management: ListingManagement,
): ManagedListingItem {
  const attributes: Partial<ListingManagement> = { ...management };
  // Absent optional attributes are omitted instead of being written as `undefined`; an empty
  // flag list is stored as no attribute at all, so listings without flags look as before.
  if (attributes.agencyId === undefined) delete attributes.agencyId;
  if (attributes.customId === undefined) delete attributes.customId;
  if (attributes.createdAt === undefined) delete attributes.createdAt;
  const flags = attributes.flags ?? [];
  if (flags.length === 0) delete attributes.flags;
  return {
    ...toListingItem(listing, management),
    ...(attributes as ListingManagement),
    ...(flags.length > 0 && { [LISTING_FLAG_CODES_ATTRIBUTE]: flagCodes(flags) }),
  };
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
