// Framework-free rendering model of a version diff (design: "Diff", Req 7.8, 8.6). Entries come
// from `GET /listings/{id}/diff` in the API representation (amounts as decimal strings).
import type { DiffEntrySchema, DiffPath } from '@open-estate/shared';
import type { z } from 'zod';

export type ApiDiffEntry = z.output<typeof DiffEntrySchema>;

/** One changed value with its old and/or new value as text (Req 7.8: old and new highlighted). */
export interface DiffRow {
  /** Readable path, e.g. `offers[0].price`, `address.city`, `status`. */
  readonly path: string;
  readonly op: ApiDiffEntry['op'];
  /** Value before the change (`change`, `remove`). */
  readonly oldText?: string;
  /** Value after the change (`add`, `change`). */
  readonly newText?: string;
}

/**
 * Readable path: object keys joined by `.`, array indices as `[n]`. The leading `content` segment
 * is dropped — Listing_Inhalt has no field named like the other versioned parts (`status`,
 * `customId`, `agencyId`), so the path stays unambiguous.
 */
export function formatDiffPath(path: DiffPath): string {
  const segments = path[0] === 'content' ? path.slice(1) : path;
  let out = '';
  for (const segment of segments) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? segment : `.${segment}`;
  }
  return out === '' ? String(path[0] ?? '') : out;
}

/** A diff value as text: strings as delivered, other scalars via `String`, structures as JSON. */
export function formatDiffValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return String(value);
  return JSON.stringify(value);
}

export function toDiffRows(entries: readonly ApiDiffEntry[]): DiffRow[] {
  return entries.map((entry): DiffRow => {
    const path = formatDiffPath(entry.path);
    switch (entry.op) {
      case 'add':
        return { path, op: 'add', newText: formatDiffValue(entry.value) };
      case 'remove':
        return { path, op: 'remove', oldText: formatDiffValue(entry.oldValue) };
      case 'change':
        return {
          path,
          op: 'change',
          oldText: formatDiffValue(entry.oldValue),
          newText: formatDiffValue(entry.value),
        };
    }
  });
}

/**
 * Rows of the restore confirmation (Req 8.2, 8.6): only the Listing_Inhalt is restored, so changes
 * of status, Custom_Id and owning agency between the versions are not shown.
 */
export function restoreDiffRows(entries: readonly ApiDiffEntry[]): DiffRow[] {
  return toDiffRows(entries.filter((entry) => entry.path[0] === 'content'));
}
