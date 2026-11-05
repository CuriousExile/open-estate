// Framework-free display model of a Diff (design: DiffViewComponent; Req 5.5, 7.8, 8.6). Shared by
// the listing form (409 conflict) and the listing workspace (version history, restore dialog).
import type { DiffResponse } from '@open-estate/shared';

type DiffEntry = DiffResponse['entries'][number];

/**
 * Field names with a label `portal.field.<name>`: Inhaltsfelder of the Listing_Inhalt, their
 * nested fields and the versioned management fields. Other names are shown as they are.
 */
export const DIFF_FIELD_NAMES = [
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
  'locale',
  'offerType',
  'price',
  'coldRent',
  'additionalCosts',
  'warmRent',
  'currency',
  'street',
  'postalCode',
  'city',
  'country',
  'lat',
  'lon',
  'url',
  'providerCode',
  'name',
  'phone',
  'email',
  'status',
  'customId',
  'agencyId',
] as const;

const NAME_SET: ReadonlySet<string> = new Set(DIFF_FIELD_NAMES);

/** One step of a field path: a field (translatable if `known`) or a 1-based list position. */
export type PathSegment =
  { kind: 'field'; name: string; known: boolean } | { kind: 'item'; position: number };

export interface DiffRow {
  /** Stable key for `@for` tracking. */
  key: string;
  op: DiffEntry['op'];
  segments: PathSegment[];
  /** Display text of the old value (`remove`, `change`). */
  oldValue?: string;
  /** Display text of the new value (`add`, `change`). */
  newValue?: string;
}

/** Display text of a value: strings and numbers as they are, structures as compact JSON. */
export function formatDiffValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function segments(path: readonly (string | number)[]): PathSegment[] {
  // Content paths start with `content`; it carries no information for the reader.
  const relevant = path[0] === 'content' ? path.slice(1) : path;
  return relevant.map((s) =>
    typeof s === 'number'
      ? { kind: 'item', position: s + 1 }
      : { kind: 'field', name: s, known: NAME_SET.has(s) },
  );
}

/** Rows of a Diff in the order of the API (deterministic paths). */
export function toDiffRows(entries: readonly DiffEntry[]): DiffRow[] {
  return entries.map((entry) => ({
    key: `${entry.op}:${JSON.stringify(entry.path)}`,
    op: entry.op,
    segments: segments(entry.path),
    ...(entry.op !== 'add' && { oldValue: formatDiffValue(entry.oldValue) }),
    ...(entry.op !== 'remove' && { newValue: formatDiffValue(entry.value) }),
  }));
}
