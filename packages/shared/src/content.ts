import type { z } from 'zod';
import { canonicalJson } from './cursor';
import { ListingBase, refineListing } from './schema/listing';
import { sha256Hex } from './sha256';

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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Restricts `content` to {@link CONTENT_FIELDS}, so a full `Listing` (with id, provenance and
 * management data) can be passed without those fields leaking into paths or hash.
 */
function pickContent(content: ListingContent): Record<string, unknown> {
  const source = content as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of CONTENT_FIELDS) {
    if (source[field] !== undefined) picked[field] = source[field];
  }
  return picked;
}

/** Leaf values (scalar or list) keyed by content path; `undefined` values are absent. */
function collectLeaves(
  value: Record<string, unknown>,
  prefix: string,
  out: Map<string, unknown>,
): void {
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isPlainObject(child)) collectLeaves(child, path, out);
    else out.set(path, child);
  }
}

function contentLeaves(content: ListingContent): Map<ContentPath, unknown> {
  const leaves = new Map<ContentPath, unknown>();
  collectLeaves(pickContent(content), '', leaves);
  return leaves;
}

/**
 * Present content paths, sorted: paths to scalars or lists; objects are resolved recursively
 * and are no path of their own (an empty object such as `contact: {}` yields no path).
 */
export function contentPaths(content: ListingContent): ContentPath[] {
  return [...contentLeaves(content).keys()].sort();
}

/**
 * Content paths added, removed or changed from `before` to `after`, sorted. Lists are compared
 * as a whole. Values are compared via {@link canonicalJson}, the same normalization as
 * {@link contentHash}, so equal hashes imply no changed paths. `before` undefined (creation)
 * yields all paths of `after`.
 */
export function changedContentPaths(
  before: ListingContent | undefined,
  after: ListingContent,
): ContentPath[] {
  const a = before === undefined ? new Map<ContentPath, unknown>() : contentLeaves(before);
  const b = contentLeaves(after);
  const changed = new Set<ContentPath>();
  for (const [path, value] of b) {
    if (!a.has(path) || canonicalJson(a.get(path)) !== canonicalJson(value)) changed.add(path);
  }
  for (const path of a.keys()) if (!b.has(path)) changed.add(path);
  return [...changed].sort();
}

/**
 * Inhalts_Hash: SHA-256 (lowercase hex) over the {@link canonicalJson} of the Listing_Inhalt in
 * the internal representation (amounts and area in minor units); id, provenance and management
 * fields are excluded. Uses the pure {@link sha256Hex} (as the cursor hash does), so it is
 * synchronous and works in the browser as well as in Node.
 */
export function contentHash(content: ListingContent): string {
  return sha256Hex(new TextEncoder().encode(canonicalJson(pickContent(content))));
}
