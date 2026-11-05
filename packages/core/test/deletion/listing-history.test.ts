import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  deletionCounterDecrements,
  DynamoDbS3ListingHistoryStore,
  InMemoryListingHistoryStore,
  InMemoryListingVersionStore,
  InMemorySnapshotStore,
  InMemoryTransactor,
  type ListingVersionRecord,
} from '@open-estate/core';
import type { ListingContent } from '@open-estate/shared';

const region = 'eu-central-1';
const HASH = (n: number) => String(n).repeat(64).slice(0, 64);

const version = (
  listingId: string,
  n: number,
  extra: Partial<ListingVersionRecord> = {},
): ListingVersionRecord => ({
  listingId,
  version: n,
  changeType: n === 1 ? 'CREATE' : 'UPDATE',
  channel: 'PORTAL',
  actor: { kind: 'user', userId: 'u1', displayName: 'Ada' },
  createdAt: '2026-01-01T12:00:00.000Z',
  status: 'ACTIVE',
  contentHash: HASH(n),
  snapshotBytes: 100 * n,
  newSnapshot: true,
  changedPaths: [],
  ...extra,
});

describe('deletionCounterDecrements', () => {
  it('reverses inventory and history per agency and drops zero deltas', () => {
    expect(
      deletionCounterDecrements({ status: 'INACTIVE', agencyId: 'b' }, [
        { agencyId: 'a', versions: 2, storageBytes: 300 },
        { agencyId: 'b', versions: 1, storageBytes: 0 },
      ]),
    ).toEqual([
      { scope: 'agency#b', code: 'listing.status.INACTIVE', delta: -1 },
      { scope: 'agency#a', code: 'history.version_count', delta: -2 },
      { scope: 'agency#a', code: 'history.storage_bytes', delta: -300 },
      { scope: 'agency#b', code: 'history.version_count', delta: -1 },
    ]);
    expect(deletionCounterDecrements({}, [{ versions: 1, storageBytes: 5 }])).toEqual([
      { scope: 'agency#_none', code: 'history.version_count', delta: -1 },
      { scope: 'agency#_none', code: 'history.storage_bytes', delta: -5 },
    ]);
  });
});

describe('InMemoryListingHistoryStore', () => {
  it('sums usage per agency (new snapshots only) and purges one listing only', async () => {
    const versions = new InMemoryListingVersionStore();
    const snapshots = new InMemorySnapshotStore();
    await new InMemoryTransactor().transact([
      versions.putOp(version('L-1', 1, { agencyId: 'a' })),
      versions.putOp(version('L-1', 2, { agencyId: 'a', newSnapshot: false })),
      versions.putOp(version('L-1', 3, { agencyId: 'b' })),
      versions.putOp(version('L-10', 1)),
    ]);
    const content = { title: 'x' } as unknown as ListingContent;
    await snapshots.put('L-1', HASH(1), content);
    await snapshots.put('L-10', HASH(1), content);
    const store = new InMemoryListingHistoryStore({ versions, snapshots });

    await expect(store.usage('L-1')).resolves.toEqual([
      { agencyId: 'a', versions: 2, storageBytes: 100 },
      { agencyId: 'b', versions: 1, storageBytes: 300 },
    ]);
    await expect(store.purge('L-1')).resolves.toEqual({ complete: true });
    expect(versions.all().map((v) => v.listingId)).toEqual(['L-10']);
    expect(snapshots.keys()).toEqual([`listings/L-10/${HASH(1)}.json`]);
  });
});

describe('DynamoDbS3ListingHistoryStore', () => {
  const create = () => {
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
    const s3 = new S3Client({ region });
    const store = new DynamoDbS3ListingHistoryStore({
      client,
      s3,
      versionsTable: 'ListingVersions',
      bucketName: 'snapshots',
      retryDelayMs: 0,
    });
    return { client, s3, store };
  };
  const key = (n: number) => ({ listingId: 'L/1', version: n });

  it('usage queries all pages strongly consistent and groups per agency', async () => {
    const { client, store } = create();
    const send = jest
      .spyOn(client, 'send')
      .mockImplementationOnce(async () => ({
        Items: [{ ...key(1), agencyId: 'a', snapshotBytes: 10, newSnapshot: true }],
        LastEvaluatedKey: key(1),
      }))
      .mockImplementationOnce(async () => ({
        Items: [
          { ...key(2), agencyId: 'a', snapshotBytes: 10, newSnapshot: false },
          { ...key(3), snapshotBytes: 7, newSnapshot: true },
        ],
      }));

    await expect(store.usage('L/1')).resolves.toEqual([
      { agencyId: 'a', versions: 2, storageBytes: 10 },
      { versions: 1, storageBytes: 7 },
    ]);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(QueryCommand);
    expect((send.mock.calls[1]?.[0] as QueryCommand).input).toMatchObject({
      TableName: 'ListingVersions',
      ExpressionAttributeValues: { ':pk': 'L/1' },
      ConsistentRead: true,
      ExclusiveStartKey: key(1),
    });
  });

  it('purge deletes versions via BatchWriteItem and the encoded prefix via DeleteObjects', async () => {
    const { client, s3, store } = create();
    const dynamo = jest
      .spyOn(client, 'send')
      .mockImplementationOnce(async () => ({ Items: [key(1), key(2)] }))
      .mockImplementationOnce(async () => ({ UnprocessedItems: {} }))
      .mockImplementationOnce(async () => ({ Items: [] }));
    const objects = jest
      .spyOn(s3, 'send')
      .mockImplementationOnce(async () => ({
        Contents: [{ Key: 'listings/L%2F1/a.json' }, { Key: 'listings/L%2F1/b.json' }],
        IsTruncated: false,
      }))
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => ({ Contents: [] }));

    await expect(store.purge('L/1')).resolves.toEqual({ complete: true });

    expect(dynamo.mock.calls[1]?.[0]).toBeInstanceOf(BatchWriteCommand);
    expect((dynamo.mock.calls[1]?.[0] as BatchWriteCommand).input).toEqual({
      RequestItems: {
        ListingVersions: [{ DeleteRequest: { Key: key(1) } }, { DeleteRequest: { Key: key(2) } }],
      },
    });
    expect((objects.mock.calls[0]?.[0] as ListObjectsV2Command).input).toEqual({
      Bucket: 'snapshots',
      Prefix: 'listings/L%2F1/',
    });
    expect(objects.mock.calls[1]?.[0]).toBeInstanceOf(DeleteObjectsCommand);
    expect((objects.mock.calls[1]?.[0] as DeleteObjectsCommand).input).toEqual({
      Bucket: 'snapshots',
      Delete: {
        Objects: [{ Key: 'listings/L%2F1/a.json' }, { Key: 'listings/L%2F1/b.json' }],
        Quiet: true,
      },
    });
    // Verification: one version query and one listing with MaxKeys 1.
    expect((dynamo.mock.calls[2]?.[0] as QueryCommand).input).toMatchObject({ Limit: 1 });
    expect((objects.mock.calls[2]?.[0] as ListObjectsV2Command).input).toMatchObject({
      MaxKeys: 1,
    });
  });

  it('is incomplete when items stay unprocessed or objects fail to delete', async () => {
    const { client, s3, store } = create();
    const unprocessed = {
      UnprocessedItems: { ListingVersions: [{ DeleteRequest: { Key: key(1) } }] },
    };
    jest
      .spyOn(client, 'send')
      .mockImplementationOnce(async () => ({ Items: [key(1)] }))
      .mockImplementation(async () => unprocessed);
    jest
      .spyOn(s3, 'send')
      .mockImplementationOnce(async () => ({ Contents: [{ Key: 'listings/L%2F1/a.json' }] }))
      .mockImplementationOnce(async () => ({
        Errors: [{ Key: 'listings/L%2F1/a.json', Code: 'InternalError' }],
      }));

    await expect(store.purge('L/1')).resolves.toEqual({ complete: false });
  });

  it('is incomplete when the verification still finds a version', async () => {
    const { client, s3, store } = create();
    jest
      .spyOn(client, 'send')
      .mockImplementationOnce(async () => ({ Items: [] }))
      .mockImplementationOnce(async () => ({ Items: [key(4)] }));
    jest.spyOn(s3, 'send').mockImplementationOnce(async () => ({ Contents: [] }));

    await expect(store.purge('L/1')).resolves.toEqual({ complete: false });
  });
});
