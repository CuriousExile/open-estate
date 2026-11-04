import { hostOf } from '@open-estate/core';
import { HttpsUrl, LISTING_BOUNDS } from '@open-estate/shared';
import type { DroppedMediaKind } from '../run-logger';
import { isRecord, type Candidate } from './pii-filter';

export interface MediaDrop {
  readonly kind: DroppedMediaKind;
  /** Position in the delivered list. */
  readonly index: number;
  readonly reason: string;
  /** Only for tours rejected because of their host (Req 16.4). */
  readonly url?: string;
}

export interface MediaTruncation {
  readonly kind: DroppedMediaKind;
  readonly droppedCount: number;
}

export interface MediaCleanupResult {
  readonly candidate: Candidate;
  readonly drops: readonly MediaDrop[];
  readonly truncations: readonly MediaTruncation[];
}

export const TOUR_HOST_NOT_ALLOWED = 'tour host is not on the tour allow-list';

/** Why `value` is not a storable https URL (Req 16.5), or `undefined` if it is one. */
export function urlProblem(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return 'URL is missing';
  if (value.length > LISTING_BOUNDS.url.max) {
    return `URL is longer than ${LISTING_BOUNDS.url.max} characters`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'URL is not absolute';
  }
  if (url.protocol !== 'https:') return 'URL scheme is not https';
  if (url.hostname === '') return 'URL has no host name';
  // Same check as the listing schema, so a kept URL never fails validation afterwards.
  if (!HttpsUrl.safeParse(value).success) return 'URL is not a valid https URL';
  return undefined;
}

/**
 * Removes invalid media and tours element by element instead of rejecting the listing, then keeps
 * the first 50 media / 10 tours in delivery order (Req 16.1, 16.2, 16.4, 16.5, 16.11). Tours keep
 * only hosts on the tour allow-list; `providerCode` is always derived from the host, a delivered
 * value is ignored. Elements are rebuilt from known fields only. Missing lists become `[]`
 * (a listing without media is valid); a non-list value is left for the schema to reject.
 *
 * @param tourHosts lower-cased host name → provider code (`tourHostIndex`)
 */
export function cleanMedia(
  candidate: Candidate,
  tourHosts: ReadonlyMap<string, string>,
): MediaCleanupResult {
  const drops: MediaDrop[] = [];
  const truncations: MediaTruncation[] = [];

  const clean = <T>(
    kind: DroppedMediaKind,
    value: unknown,
    max: number,
    accept: (element: unknown, index: number) => T | undefined,
  ): unknown => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return value;
    const kept = value.flatMap((element, index) => accept(element, index) ?? []);
    if (kept.length > max) truncations.push({ kind, droppedCount: kept.length - max });
    return kept.slice(0, max);
  };

  const media = clean('media', candidate['media'], LISTING_BOUNDS.media.max, (element, index) => {
    const url = isRecord(element) ? element['url'] : undefined;
    const reason = urlProblem(url);
    if (reason !== undefined) {
      drops.push({ kind: 'media', index, reason });
      return undefined;
    }
    return { url: url as string };
  });

  const tours = clean('tour', candidate['tours'], LISTING_BOUNDS.tours.max, (element, index) => {
    const url = isRecord(element) ? element['url'] : undefined;
    const reason = urlProblem(url);
    if (reason !== undefined) {
      drops.push({ kind: 'tour', index, reason });
      return undefined;
    }
    const host = hostOf(url as string);
    const providerCode = host === undefined ? undefined : tourHosts.get(host);
    if (providerCode === undefined) {
      drops.push({ kind: 'tour', index, reason: TOUR_HOST_NOT_ALLOWED, url: url as string });
      return undefined;
    }
    return { url: url as string, providerCode };
  });

  return { candidate: { ...candidate, media, tours }, drops, truncations };
}
