import { decodeKeyCursor, encodeKeyCursor } from '../management/key-page';

// Parallel scans of the Duplikat_Abgleich (duplicate-detection design: "Duplikat_Abgleich"): every
// phase works on `segments` disjoint parts of a table, each continued with a cursor across
// invocations. DynamoDB provides this with `Segment`/`TotalSegments`; the in-memory fakes assign
// each key to a segment with a stable hash, so all segments together cover every item once.

/** Part of a parallel scan and where to continue in it. */
export interface ScanRequest {
  /** 0-based, `< segments`. */
  segment: number;
  segments: number;
  /** From the previous page; absent = start of the segment. */
  cursor?: string;
  /** Items per page (a hint; DynamoDB may return fewer). */
  limit: number;
}

export interface ScanPage<T> {
  items: T[];
  /** Absent when the segment is exhausted. */
  cursor?: string;
}

/** Segment of a key in the in-memory fakes (FNV-1a, stable across processes). */
export function segmentOf(key: string, segments: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % segments;
}

/**
 * In-memory page of a parallel scan: the items of `request.segment` in key order after the
 * cursor (the key of the last returned item). Like DynamoDB, all items of one partition
 * (`partitionOf`, default the key itself) fall into the same segment.
 */
export function scanInMemory<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  request: ScanRequest,
  partitionOf: (item: T) => string = keyOf,
): ScanPage<T> {
  const after =
    request.cursor === undefined ? undefined : String(decodeKeyCursor(request.cursor)['k']);
  const inSegment = items
    .filter((item) => segmentOf(partitionOf(item), request.segments) === request.segment)
    .sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))
    .filter((item) => after === undefined || keyOf(item) > after);
  const page = inSegment.slice(0, request.limit);
  const last = page.at(-1);
  return {
    items: page,
    ...(last !== undefined &&
      inSegment.length > page.length && { cursor: encodeKeyCursor({ k: keyOf(last) }) }),
  };
}

/** DynamoDB scan parameters of a request. */
export function scanParameters(request: ScanRequest): {
  Segment: number;
  TotalSegments: number;
  Limit: number;
  ExclusiveStartKey?: Record<string, unknown>;
} {
  return {
    Segment: request.segment,
    TotalSegments: request.segments,
    Limit: request.limit,
    ...(request.cursor !== undefined && { ExclusiveStartKey: decodeKeyCursor(request.cursor) }),
  };
}

/** Cursor of a DynamoDB scan page. */
export const scanCursor = (
  lastEvaluatedKey: Record<string, unknown> | undefined,
): { cursor?: string } =>
  lastEvaluatedKey === undefined ? {} : { cursor: encodeKeyCursor(lastEvaluatedKey) };
