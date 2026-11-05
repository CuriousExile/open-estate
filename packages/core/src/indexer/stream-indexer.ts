import { isDeepStrictEqual } from 'node:util';
import type { AttributeValue as SdkAttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { Listing } from '@open-estate/shared';
import type {
  AttributeValue,
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from 'aws-lambda';
import { z } from 'zod';
import { fromListingItem, isIndexedListingItem } from '../search/listings-table';
import type { IndexDocument, IndexWriteFailure, SearchIndexWriter } from './search-index-writer';

// Mirrors the `Listings` table into the search index (design: "Indexierungs-Strategie und
// Ordnung"; Req 4.11 updates, 18.4/18.5 deletions). Stream view type: NEW_AND_OLD_IMAGES.
//
// Ordering: Lambda delivers one batch per shard, and all records of one item share a shard in
// stream order. Within a batch only the last record per id is applied (it carries the full latest
// state or the deletion). On any failure the response lists the first failed record and every
// record after it: Lambda resumes the shard at the lowest reported sequence number anyway, and
// listing the tail explicitly keeps the contract independent of that detail and never
// acknowledges a record that is ordered after an unapplied one. Replaying the tail is safe because
// every write is an idempotent full-state upsert or delete.
//
// Visibility (design: "Öffentliche Sichtbarkeit"; Req 4.15, 6.3, 6.5): only items carrying the
// sparse `byId` key (`ACTIVE` listings) are indexed. An image without it is applied like `REMOVE`,
// so deactivation deletes the document and reactivation upserts it again.
//
// Unchanged documents: when the state before the batch (old image of the id's first record) maps
// to the same operation as the final state — same document apart from the provenance touch
// `lastImportedAt`/`lastRunId`, or hidden both times — the id is skipped. An import run without
// content change thus causes no reindex; the index keeps the previous provenance values until the
// next real change (design: "Öffentliche Sichtbarkeit"). Because the comparison is anchored at
// the id's first record, a failure is reported from that record, so a replay compares against the
// last acknowledged state instead of a never-applied intermediate one.

/** Log entry without listing content: ids, counts and error categories only. */
export type IndexerLogEntry =
  | {
      readonly event: 'indexer.batch';
      readonly records: number;
      readonly upserts: number;
      readonly deletes: number;
      readonly skipped: number;
      readonly failedRecords: number;
    }
  | {
      readonly event: 'indexer.failure';
      readonly id: string | undefined;
      readonly sequenceNumber: string | undefined;
      readonly errorType: string;
    };

export interface StreamIndexerDeps<D extends IndexDocument> {
  readonly writer: SearchIndexWriter<D>;
  /** Single source of the index document (Task 18.1: `toOpenSearchDocument`). */
  readonly toDocument: (listing: Listing, agencyId?: string) => D;
  readonly log?: (entry: IndexerLogEntry) => void;
}

/** Error categories reported for records that are not written at all. */
export const INVALID_RECORD = 'INVALID_RECORD';
export const INVALID_IMAGE = 'INVALID_IMAGE';

/**
 * Fields the search document is derived from (stored representation: amounts and area in minor
 * units). A stored item lacking any of them is reported instead of crashing the batch.
 */
const minor = z.number().int().positive();
const StoredListingFields = z.object({
  id: z.string().min(1),
  listingType: z.string().min(1),
  rooms: z.number(),
  area: minor,
  address: z.object({ city: z.string(), postalCode: z.string(), country: z.string() }),
  offers: z
    .array(
      z.discriminatedUnion('offerType', [
        z.object({ offerType: z.literal('SALE'), price: minor, currency: z.string() }),
        z.object({ offerType: z.literal('RENT'), coldRent: minor, currency: z.string() }),
      ]),
    )
    .min(1),
  tours: z.array(z.object({ url: z.string() })),
  agencyId: z.string().min(1).optional(),
});

type Operation<D> =
  | { readonly kind: 'upsert'; readonly position: number; readonly doc: D }
  | { readonly kind: 'delete'; readonly position: number; readonly id: string }
  | { readonly kind: 'skip'; readonly position: number }
  | { readonly kind: 'invalid'; readonly position: number; readonly errorType: string };

/** Index state an item image maps to: its document, hidden (not indexed) or not derivable. */
type ImageState<D> =
  | { readonly kind: 'upsert'; readonly doc: D; readonly compared: unknown }
  | { readonly kind: 'delete' }
  | { readonly kind: 'invalid'; readonly errorType: string };

type ToDocument<D> = (listing: Listing, agencyId?: string) => D;

function keyId(record: DynamoDBRecord): string | undefined {
  return record.dynamodb?.Keys?.['id']?.S;
}

function toItem(image: Record<string, AttributeValue>): Record<string, unknown> {
  // The Lambda event and the SDK model the same wire format with slightly different types.
  return unmarshall(image as Record<string, SdkAttributeValue>);
}

function imageState<D extends IndexDocument>(
  image: Record<string, AttributeValue>,
  id: string,
  toDocument: ToDocument<D>,
): ImageState<D> {
  try {
    const item = toItem(image);
    if (item['id'] !== id) return { kind: 'invalid', errorType: INVALID_IMAGE };
    // Not in the sparse `byId` index (status not `ACTIVE`): not publicly visible.
    if (!isIndexedListingItem(item)) return { kind: 'delete' };
    const parsed = StoredListingFields.safeParse(item);
    if (!parsed.success) return { kind: 'invalid', errorType: INVALID_IMAGE };
    const listing = fromListingItem(item);
    // The document is a pure function of listing and agency, so comparing its inputs suffices.
    const compared = { ...listing, lastImportedAt: undefined, lastRunId: undefined };
    return {
      kind: 'upsert',
      doc: toDocument(listing, parsed.data.agencyId),
      compared: { listing: compared, agencyId: parsed.data.agencyId },
    };
  } catch {
    return { kind: 'invalid', errorType: INVALID_IMAGE };
  }
}

/** Final state of the id after its last record. */
function finalState<D extends IndexDocument>(
  record: DynamoDBRecord,
  id: string,
  toDocument: ToDocument<D>,
): ImageState<D> {
  if (record.eventName === 'REMOVE') return { kind: 'delete' };
  const image = record.dynamodb?.NewImage;
  if ((record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') || !image) {
    return { kind: 'invalid', errorType: INVALID_RECORD };
  }
  return imageState(image, id, toDocument);
}

/** State before the batch: old image of the id's first `MODIFY`/`REMOVE` record, if any. */
function previousState<D extends IndexDocument>(
  record: DynamoDBRecord,
  id: string,
  toDocument: ToDocument<D>,
): ImageState<D> | undefined {
  const image = record.dynamodb?.OldImage;
  if ((record.eventName !== 'MODIFY' && record.eventName !== 'REMOVE') || !image) return undefined;
  return imageState(image, id, toDocument);
}

function sameState<D>(a: ImageState<D> | undefined, b: ImageState<D>): boolean {
  if (a === undefined || a.kind === 'invalid' || a.kind !== b.kind) return false;
  return (
    a.kind === 'delete' || isDeepStrictEqual(a.compared, (b as { compared: unknown }).compared)
  );
}

function toOperation<D extends IndexDocument>(
  records: readonly DynamoDBRecord[],
  positions: { readonly first: number; readonly last: number },
  id: string,
  toDocument: ToDocument<D>,
): Operation<D> {
  const position = positions.first;
  const state = finalState(records[positions.last] as DynamoDBRecord, id, toDocument);
  if (state.kind === 'invalid') return { kind: 'invalid', position, errorType: state.errorType };
  if (sameState(previousState(records[position] as DynamoDBRecord, id, toDocument), state)) {
    return { kind: 'skip', position };
  }
  return state.kind === 'upsert'
    ? { kind: 'upsert', position, doc: state.doc }
    : { kind: 'delete', position, id };
}

async function guarded(
  ids: readonly string[],
  write: () => Promise<readonly IndexWriteFailure[]>,
): Promise<readonly IndexWriteFailure[]> {
  if (ids.length === 0) return [];
  try {
    return await write();
  } catch (error) {
    // Whole request failed (network, auth, throttling): every document of it is unapplied.
    const errorType = error instanceof Error ? error.name : 'UnknownError';
    return ids.map((id) => ({ id, errorType }));
  }
}

/** Applies one stream batch to the index and reports the records Lambda must redeliver. */
export async function indexStreamBatch<D extends IndexDocument>(
  event: DynamoDBStreamEvent,
  deps: StreamIndexerDeps<D>,
): Promise<DynamoDBBatchResponse> {
  const log = deps.log ?? (() => undefined);
  const records = event.Records;

  // Last record per id wins; records without a key cannot be applied at all.
  const positions = new Map<string, { first: number; last: number }>();
  const unkeyed: Operation<D>[] = [];
  records.forEach((record, position) => {
    const id = keyId(record);
    if (id === undefined) unkeyed.push({ kind: 'invalid', position, errorType: INVALID_RECORD });
    else positions.set(id, { first: positions.get(id)?.first ?? position, last: position });
  });

  const operations = [
    ...unkeyed,
    ...[...positions].map(([id, p]) => toOperation(records, p, id, deps.toDocument)),
  ];

  const upserts = operations.flatMap((op) => (op.kind === 'upsert' ? [op.doc] : []));
  const deletes = operations.flatMap((op) => (op.kind === 'delete' ? [op.id] : []));
  const [upsertFailures, deleteFailures] = await Promise.all([
    guarded(
      upserts.map((doc) => doc.id),
      () => deps.writer.upsert(upserts),
    ),
    guarded(deletes, () => deps.writer.delete(deletes)),
  ]);

  const failures: { position: number; errorType: string }[] = operations.flatMap((op) =>
    op.kind === 'invalid' ? [op] : [],
  );
  for (const failure of [...upsertFailures, ...deleteFailures]) {
    const position = positions.get(failure.id)?.first;
    if (position !== undefined) failures.push({ position, errorType: failure.errorType });
  }
  failures.sort((a, b) => a.position - b.position);

  for (const { position, errorType } of failures) {
    const record = records[position];
    log({
      event: 'indexer.failure',
      id: record && keyId(record),
      sequenceNumber: record?.dynamodb?.SequenceNumber,
      errorType,
    });
  }

  const first = failures[0]?.position;
  // An empty identifier makes Lambda retry the whole batch, the safe fallback.
  const batchItemFailures =
    first === undefined
      ? []
      : records
          .slice(first)
          .map((record) => ({ itemIdentifier: record.dynamodb?.SequenceNumber ?? '' }));

  log({
    event: 'indexer.batch',
    records: records.length,
    upserts: upserts.length,
    deletes: deletes.length,
    skipped: operations.filter((op) => op.kind === 'skip').length,
    failedRecords: batchItemFailures.length,
  });
  return { batchItemFailures };
}
