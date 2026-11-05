import type { z } from 'zod';
import { ListingBase, refineListing } from './schema/listing';

// Listing_Inhalt (design: "Data Models"): all listing fields without id, provenance fields
// (`source`, `lastImportedAt`, `lastRunId`) and management data (status, agency, Custom_Id,
// field sources). The content-path functions and the Inhalts_Hash build on this (Task 1.4).

/** Top-level fields of the Listing_Inhalt. */
export const CONTENT_FIELDS = [
  'originalLocale',
  'title',
  'description',
  'translations',
  'offers',
  'listingType',
  'rooms',
  'area',
  'address',
  'geo',
  'sourceUrl',
  'media',
  'tours',
  'contact',
] as const;

export type ContentField = (typeof CONTENT_FIELDS)[number];

/** `pick` mask of {@link CONTENT_FIELDS}. */
export const CONTENT_MASK = Object.fromEntries(CONTENT_FIELDS.map((f) => [f, true])) as {
  readonly [K in ContentField]: true;
};

/** Listing_Inhalt fields without object-level refinements, so it can be extended. */
export const ListingContentBase = ListingBase.pick(CONTENT_MASK);

/** Listing_Inhalt schema: input = API representation, output = internal (minor units). */
export const ListingContent = refineListing(ListingContentBase);

/** Listing_Inhalt in the internal representation (amounts and area in minor units). */
export type ListingContent = z.output<typeof ListingContent>;
/** Listing_Inhalt in the API representation (amounts and area as decimal strings). */
export type ListingContentInput = z.input<typeof ListingContent>;

/**
 * Inhaltsfeld: dot-separated path to a scalar or a list; objects are resolved recursively
 * (e.g. `title`, `offers`, `address.city`, `geo.lat`, `contact.email`).
 */
export type ContentPath = string;
