import type { AttributeValue as SdkAttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { Listing } from '@open-estate/shared';
import type { AttributeValue, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { ConfigError } from '../../src/config/config-error';
import { readIndexerConfig } from '../../src/indexer/indexer-config';
import type { IndexWriteFailure, SearchIndexWriter } from '../../src/indexer/search-index-writer';
import {
  INVALID_IMAGE,
  INVALID_RECORD,
  indexStreamBatch,
  type IndexerLogEntry,
} from '../../src/indexer/stream-indexer';
import { toListingItem } from '../../src/search/listings-table';
import {
  toOpenSearchDocument,
  type OpenSearchDocument,
} from '../../src/search/opensearch-search-provider';
import { listing } from '../search/fixtures';

/** In-memory index; ids in `failIds` are rejected per document, `throwOn` fails the request. */
class FakeWriter implements SearchIndexWriter<OpenSearchDocument> {
  readonly docs = new Map<string, OpenSearchDocument>();
  readonly upsertCalls: string[][] = [];
  readonly deleteCalls: string[][] = [];
  failIds = new Set<string>();
  throwOn: 'upsert' | 'delete' | undefined;

  async upsert(docs: readonly OpenSearchDocument[]): Promise<IndexWriteFailure[]> {
    this.upsertCalls.push(docs.map((d) => d.id));
    if (this.throwOn === 'upsert') throw new TypeError('connection reset');
    return docs.flatMap((doc) => {
      if (this.failIds.has(doc.id)) return [{ id: doc.id, errorType: 'mapper_parsing_exception' }];
      this.docs.set(doc.id, doc);
      return [];
    });
  }

  async delete(ids: readonly string[]): Promise<IndexWriteFailure[]> {
    this.deleteCalls.push([...ids]);
    if (this.throwOn === 'delete') throw new TypeError('connection reset');
    return ids.flatMap((id) => {
      if (this.failIds.has(id)) return [{ id, errorType: 'version_conflict_engine_exception' }];
      this.docs.delete(id);
      return [];
    });
  }
}

let seq = 0;

function image(item: Record<string, unknown>): Record<string, AttributeValue> {
  return marshall(item, { removeUndefinedValues: true }) as Record<
    string,
    SdkAttributeValue
  > as Record<string, AttributeValue>;
}

function record(
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE',
  id: string,
  newImage?: Record<string, unknown>,
  oldImage?: Record<string, unknown>,
): DynamoDBRecord {
  seq += 1;
  return {
    eventName,
    dynamodb: {
      Keys: { id: { S: id } },
      SequenceNumber: String(seq).padStart(6, '0'),
      StreamViewType: 'NEW_AND_OLD_IMAGES',
      ...(newImage ? { NewImage: image(newImage) } : {}),
      ...(oldImage ? { OldImage: image(oldImage) } : {}),
    },
  };
}

const upsert = (eventName: 'INSERT' | 'MODIFY', l: Listing) =>
  record(eventName, l.id, { ...toListingItem(l) });
const remove = (id: string) => record('REMOVE', id);
/** `MODIFY` with both images, e.g. a status change or an import that only set `lastImportedAt`. */
const modify = (before: Record<string, unknown>, after: Record<string, unknown>) =>
  record('MODIFY', String(after['id']), after, before);
const batch = (...records: DynamoDBRecord[]): DynamoDBStreamEvent => ({ Records: records });
const seqOf = (...records: DynamoDBRecord[]) =>
  records.map((r) => ({ itemIdentifier: r.dynamodb?.SequenceNumber }));

function setup() {
  const writer = new FakeWriter();
  const logs: IndexerLogEntry[] = [];
  const run = (event: DynamoDBStreamEvent) =>
    indexStreamBatch(event, {
      writer,
      toDocument: toOpenSearchDocument,
      log: (e) => logs.push(e),
    });
  return { writer, logs, run };
}

describe('indexStreamBatch', () => {
  it('INSERT indexes the search document of the new image under its id', async () => {
    const { writer, run } = setup();
    const a = listing('a');

    await expect(run(batch(upsert('INSERT', a)))).resolves.toEqual({ batchItemFailures: [] });

    expect(writer.docs.get('a')).toEqual(toOpenSearchDocument(a));
  });

  it('MODIFY fully replaces the indexed document (Req 4.11)', async () => {
    const { writer, run } = setup();
    await run(batch(upsert('INSERT', listing('a'))));
    const changed = listing('a');
    changed.title = 'Changed';
    changed.offers = [{ offerType: 'RENT', coldRent: 900_00, currency: 'EUR' }];

    await expect(run(batch(upsert('MODIFY', changed)))).resolves.toEqual({
      batchItemFailures: [],
    });

    expect(writer.docs.get('a')).toEqual(toOpenSearchDocument(changed));
    expect(writer.docs.get('a')?.saleAmountMinor).toBeUndefined();
  });

  it('REMOVE deletes the document (Req 18.4, 18.5)', async () => {
    const { writer, run } = setup();
    await run(batch(upsert('INSERT', listing('a'))));

    await expect(run(batch(remove('a')))).resolves.toEqual({ batchItemFailures: [] });

    expect(writer.docs.has('a')).toBe(false);
    expect(writer.deleteCalls).toEqual([['a']]);
  });

  it('applies only the last record per id within a batch', async () => {
    const { writer, run } = setup();
    await run(batch(upsert('INSERT', listing('b'))));
    const a2 = listing('a');
    a2.title = 'v2';

    const result = await run(
      batch(
        upsert('INSERT', listing('a')),
        remove('b'),
        upsert('MODIFY', a2),
        upsert('INSERT', listing('c')),
        remove('c'),
      ),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(writer.upsertCalls.at(-1)).toEqual(['a']);
    expect(writer.deleteCalls.at(-1)?.sort()).toEqual(['b', 'c']);
    expect(writer.docs.get('a')?.listing.title).toBe('v2');
    expect([...writer.docs.keys()]).toEqual(['a']);
  });

  it('reports the first failed record and every later record', async () => {
    const { writer, run, logs } = setup();
    writer.failIds = new Set(['b']);
    const records = [
      upsert('INSERT', listing('a')),
      upsert('INSERT', listing('b')),
      remove('c'),
      upsert('INSERT', listing('d')),
    ];

    const result = await run(batch(...records));

    expect(result.batchItemFailures).toEqual(seqOf(...records.slice(1)));
    // Writes after the failure are applied anyway; their replay is idempotent.
    expect([...writer.docs.keys()].sort()).toEqual(['a', 'd']);
    expect(logs).toContainEqual({
      event: 'indexer.failure',
      id: 'b',
      sequenceNumber: records[1]?.dynamodb?.SequenceNumber,
      errorType: 'mapper_parsing_exception',
    });
  });

  it('maps a failed id to its first record, so a replay compares against the acknowledged state', async () => {
    const { writer, run } = setup();
    writer.failIds = new Set(['a']);
    const records = [remove('b'), upsert('INSERT', listing('a')), upsert('MODIFY', listing('a'))];

    const result = await run(batch(...records));

    expect(result.batchItemFailures).toEqual(seqOf(...records.slice(1)));
  });

  it('MODIFY without gsiPk (INACTIVE) deletes the document; reactivation upserts it (Req 6.3, 6.5)', async () => {
    const { writer, run } = setup();
    const a = listing('a');
    const active = { ...toListingItem(a, { status: 'ACTIVE', agencyId: 'agency-1' }) };
    const inactive = { ...toListingItem(a, { status: 'INACTIVE', agencyId: 'agency-1' }) };
    await run(batch(record('INSERT', 'a', active)));
    expect(writer.docs.get('a')).toEqual(toOpenSearchDocument(a, 'agency-1'));

    await expect(run(batch(modify(active, inactive)))).resolves.toEqual({ batchItemFailures: [] });
    expect(writer.docs.has('a')).toBe(false);
    expect(writer.deleteCalls).toEqual([['a']]);

    await run(batch(modify(inactive, active)));
    expect(writer.docs.get('a')).toEqual(toOpenSearchDocument(a, 'agency-1'));
  });

  it('INSERT of an INACTIVE listing is not indexed', async () => {
    const { writer, run } = setup();
    const item = { ...toListingItem(listing('a'), { status: 'INACTIVE' }) };

    await expect(run(batch(record('INSERT', 'a', item)))).resolves.toEqual({
      batchItemFailures: [],
    });

    expect(writer.upsertCalls).toEqual([]);
    expect(writer.docs.has('a')).toBe(false);
  });

  it('skips MODIFY records whose search document is unchanged', async () => {
    const { writer, run, logs } = setup();
    const item = { ...toListingItem(listing('a')) };
    const hidden = { ...toListingItem(listing('b'), { status: 'INACTIVE' }) };

    const result = await run(
      batch(
        modify(item, { ...item, lastImportedAt: '2026-01-02T10:00:00Z' }),
        modify(hidden, { ...hidden, lastImportedAt: '2026-01-02T10:00:00Z' }),
      ),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(writer.upsertCalls).toEqual([]);
    expect(writer.deleteCalls).toEqual([]);
    expect(logs.at(-1)).toMatchObject({ upserts: 0, deletes: 0, skipped: 2 });
  });

  it('compares against the state before the batch, not an intermediate one', async () => {
    const { writer, run } = setup();
    const v1 = { ...toListingItem(listing('a')) };
    const changed = listing('a');
    changed.title = 'v2';
    const v2 = { ...toListingItem(changed) };
    const touched = { ...changed, lastImportedAt: '2026-01-02T10:00:00Z' };

    await run(batch(modify(v1, v2), modify(v2, { ...toListingItem(touched) })));

    expect(writer.docs.get('a')).toEqual(toOpenSearchDocument(touched));
  });

  it('treats a failed bulk request as failure of all its documents', async () => {
    const { writer, run } = setup();
    writer.throwOn = 'delete';
    const records = [upsert('INSERT', listing('a')), remove('b'), upsert('INSERT', listing('c'))];

    const result = await run(batch(...records));

    expect(result.batchItemFailures).toEqual(seqOf(...records.slice(1)));
    expect([...writer.docs.keys()].sort()).toEqual(['a', 'c']);
  });

  it('reports invalid images without crashing and without logging content', async () => {
    const { writer, run, logs } = setup();
    const valid = listing('a');
    const withoutAddress: Record<string, unknown> = { ...toListingItem(listing('b')) };
    delete withoutAddress['address'];
    const records = [
      upsert('INSERT', valid),
      record('INSERT', 'b', withoutAddress),
      record('MODIFY', 'c'), // no NewImage (wrong stream view type)
      upsert('INSERT', listing('d')),
    ];

    const result = await run(batch(...records));

    expect(result.batchItemFailures).toEqual(seqOf(...records.slice(1)));
    expect([...writer.docs.keys()].sort()).toEqual(['a', 'd']);
    const failures = logs.filter((l) => l.event === 'indexer.failure');
    expect(failures.map((f) => [f.id, f.errorType])).toEqual([
      ['b', INVALID_IMAGE],
      ['c', INVALID_RECORD],
    ]);
    expect(JSON.stringify(logs)).not.toContain(valid.title);
    expect(JSON.stringify(logs)).not.toContain('Berlin');
  });

  it('reports a record without key as failure', async () => {
    const { run } = setup();
    const keyless: DynamoDBRecord = { eventName: 'REMOVE', dynamodb: { SequenceNumber: '9' } };

    const result = await run(batch(keyless));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: '9' }]);
  });

  it('logs a batch summary with counts', async () => {
    const { run, logs } = setup();
    await run(batch(upsert('INSERT', listing('a')), remove('b')));

    expect(logs.at(-1)).toEqual({
      event: 'indexer.batch',
      records: 2,
      upserts: 1,
      deletes: 1,
      skipped: 0,
      failedRecords: 0,
    });
  });
});

describe('readIndexerConfig', () => {
  it('reads endpoint, index and region', () => {
    expect(
      readIndexerConfig({
        OPENSEARCH_ENDPOINT: 'https://x.eu-central-1.aoss.amazonaws.com',
        OPENSEARCH_INDEX: 'listings',
        AWS_REGION: 'eu-central-1',
      }),
    ).toEqual({
      endpoint: 'https://x.eu-central-1.aoss.amazonaws.com',
      index: 'listings',
      region: 'eu-central-1',
    });
  });

  it('names every missing value', () => {
    const read = () => readIndexerConfig({ OPENSEARCH_INDEX: ' ', AWS_REGION: 'eu-central-1' });
    expect(read).toThrow(ConfigError);
    expect(read).toThrow('CONFIG_MISSING: OPENSEARCH_ENDPOINT, OPENSEARCH_INDEX');
  });
});
