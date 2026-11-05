import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  agencyScope,
  DynamoDbListingKeyStore,
  DynamoDbListingVersionStore,
  DynamoDbManagedListingStore,
  DynamoDbMetricCounterStore,
  encodeKeyCursor,
  fromManagedListingItem,
  InMemoryListingKeyStore,
  InMemoryListingVersionStore,
  InMemoryManagedListingStore,
  InMemoryMetricCounterStore,
  InMemorySnapshotStore,
  InMemoryTransactor,
  InvalidCursorError,
  LISTINGS_BY_ID_PK_ATTRIBUTE,
  S3SnapshotStore,
  snapshotKey,
  toListingItem,
  toManagedListingItem,
  type ListingManagement,
  type ListingVersionRecord,
} from '@open-estate/core';
import { CONTENT_FIELDS, contentHash, type ListingContent } from '@open-estate/shared';
import { exampleListing } from '../../../shared/test/arbitraries';

const documentClient = () =>
  DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));

const listing = exampleListing('lst-1');
const HASH = contentHash(listing);
const content = Object.fromEntries(
  CONTENT_FIELDS.flatMap((field) => (field in listing ? [[field, listing[field]]] : [])),
) as ListingContent;
const USER = { kind: 'user', userId: 'u1', displayName: 'Ada' } as const;

const management = (overrides: Partial<ListingManagement> = {}): ListingManagement => ({
  status: 'ACTIVE',
  agencyId: 'agy-1',
  origin: 'MANUAL',
  customId: 'C-1',
  version: 1,
  contentHash: HASH,
  fieldSources: { title: { channel: 'PORTAL', actor: USER, version: 1 } },
  updatedAt: '2026-01-01T10:00:00+01:00',
  ...overrides,
});

const version = (
  n: number,
  overrides: Partial<ListingVersionRecord> = {},
): ListingVersionRecord => ({
  listingId: 'lst-1',
  version: n,
  changeType: n === 1 ? 'CREATE' : 'UPDATE',
  channel: 'PORTAL',
  actor: USER,
  createdAt: '2026-01-01T10:00:00+01:00',
  status: 'ACTIVE',
  contentHash: HASH,
  snapshotBytes: 100,
  newSnapshot: true,
  changedPaths: [
    {
      path: 'title',
      previous: {
        channel: 'IMPORT',
        actor: { kind: 'connector', connectorId: 'c', runId: 'r' },
        version: n - 1 || 1,
      },
      overwrittenByImport: false,
    },
  ],
  ...overrides,
});

describe('managed Listings item', () => {
  it('adds management attributes and keeps the listing projection and gsiPk', () => {
    const item = toManagedListingItem(listing, management());
    expect(item).toMatchObject({ ...toListingItem(listing), ...management() });
    expect(item[LISTINGS_BY_ID_PK_ATTRIBUTE]).toBe('L');
    expect(fromManagedListingItem(item)).toEqual({ listing, management: management() });
  });

  it('omits absent optional attributes', () => {
    const rest = management();
    delete rest.agencyId;
    delete rest.customId;
    const item = toManagedListingItem(listing, rest);
    expect(item).not.toHaveProperty('agencyId');
    expect(item).not.toHaveProperty('customId');
    expect(fromManagedListingItem(item).management).toEqual(rest);
  });

  it('rejects items with malformed management data', () => {
    const item = { ...toManagedListingItem(listing, management()), status: 'DELETED' };
    expect(() => fromManagedListingItem(item)).toThrow();
  });
});

describe('listing store fakes with transaction semantics', () => {
  const tx = new InMemoryTransactor();

  it('creates once and updates only with the expected version', async () => {
    const store = new InMemoryManagedListingStore();
    const v1 = toManagedListingItem(listing, management());
    await expect(tx.transact([store.putOp(v1, null)])).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(tx.transact([store.putOp(v1, null)])).resolves.toEqual({
      ok: false,
      error: { failed: ['listing.put'] },
    });

    const v2 = toManagedListingItem(listing, management({ version: 2 }));
    expect((await tx.transact([store.putOp(v2, 2)])).ok).toBe(false);
    expect((await tx.transact([store.putOp(v2, 1)])).ok).toBe(true);
    expect((await store.get('lst-1'))?.management.version).toBe(2);
    expect(await store.get('unknown')).toBeNull();
  });

  it('never overwrites a version and pages versions newest first', async () => {
    const store = new InMemoryListingVersionStore();
    for (const n of [1, 2, 3]) expect((await tx.transact([store.putOp(version(n))])).ok).toBe(true);
    const again = await tx.transact([store.putOp(version(2, { status: 'INACTIVE' }))]);
    expect(again).toEqual({ ok: false, error: { failed: ['listingVersion.put'] } });
    expect((await store.get('lst-1', 2))?.status).toBe('ACTIVE');

    const first = await store.list('lst-1', { limit: 2 });
    expect(first.items.map((v) => v.version)).toEqual([3, 2]);
    const cursor = first.nextCursor ?? '';
    expect(cursor).not.toBe('');
    const second = await store.list('lst-1', { limit: 2, cursor });
    expect(second).toEqual({ items: [version(1)] });
    await expect(store.list('lst-2', { limit: 2, cursor })).rejects.toThrow(InvalidCursorError);
  });

  it('keeps a Custom_Id unique per agency and releases only the own key', async () => {
    const keys = new InMemoryListingKeyStore();
    expect((await tx.transact([keys.assignOp('agy-1', 'C-1', 'lst-1')])).ok).toBe(true);
    expect((await tx.transact([keys.assignOp('agy-1', 'C-1', 'lst-1')])).ok).toBe(true);
    expect(await tx.transact([keys.assignOp('agy-1', 'C-1', 'lst-2')])).toEqual({
      ok: false,
      error: { failed: ['listingKey.assign'] },
    });
    expect((await tx.transact([keys.assignOp('agy-2', 'C-1', 'lst-2')])).ok).toBe(true);
    expect((await tx.transact([keys.releaseOp('agy-1', 'C-1', 'lst-2')])).ok).toBe(false);
    expect((await tx.transact([keys.releaseOp('agy-1', 'C-1', 'lst-1')])).ok).toBe(true);
    expect(await keys.get('agy-1', 'C-1')).toBeNull();
    expect(await keys.get('agy-2', 'C-1')).toBe('lst-2');
  });

  it('applies nothing if one operation of a transaction fails', async () => {
    const listings = new InMemoryManagedListingStore();
    const versions = new InMemoryListingVersionStore();
    const keys = new InMemoryListingKeyStore();
    const counters = new InMemoryMetricCounterStore();
    await tx.transact([keys.assignOp('agy-1', 'C-1', 'other')]);

    const result = await tx.transact([
      listings.putOp(toManagedListingItem(listing, management()), null),
      versions.putOp(version(1)),
      keys.assignOp('agy-1', 'C-1', 'lst-1'),
      counters.addOp({ scope: agencyScope('agy-1'), code: 'listing.status.ACTIVE', delta: 1 }),
    ]);
    expect(result).toEqual({ ok: false, error: { failed: ['listingKey.assign'] } });
    expect(listings.all()).toEqual([]);
    expect(versions.all()).toEqual([]);
    expect(counters.entries()).toEqual([]);
  });

  it('sums counter increments per scope, code and day', async () => {
    const counters = new InMemoryMetricCounterStore();
    await tx.transact([
      counters.addOp({ scope: agencyScope(undefined), code: 'history.version_count', delta: 2 }),
    ]);
    await counters.add({ scope: agencyScope(undefined), code: 'history.version_count', delta: -1 });
    await counters.add({
      scope: 'agency#a',
      code: 'listing.changes.PORTAL',
      day: '2026-01-01',
      delta: 1,
    });
    expect(await counters.get('agency#_none', 'history.version_count')).toBe(1);
    expect(await counters.get('agency#a', 'listing.changes.PORTAL', '2026-01-01')).toBe(1);
    expect(await counters.get('agency#a', 'listing.changes.PORTAL')).toBe(0);
  });

  it('stores each snapshot content once', async () => {
    const snapshots = new InMemorySnapshotStore();
    const first = await snapshots.put('lst-1', HASH, listing);
    expect(first.created).toBe(true);
    expect(first.bytes).toBe(Buffer.byteLength(JSON.stringify(content)));
    expect(await snapshots.put('lst-1', HASH, listing)).toEqual({ ...first, created: false });
    expect(snapshots.keys()).toEqual([`listings/lst-1/${HASH}.json`]);
    expect(await snapshots.get('lst-1', HASH)).toEqual(content);
    expect(await snapshots.get('lst-1', 'f'.repeat(64))).toBeNull();
  });
});

describe('DynamoDB listing stores', () => {
  it('reads listings strongly consistent and builds the version-conditioned put', async () => {
    const client = documentClient();
    const item = toManagedListingItem(listing, management());
    const send = jest.spyOn(client, 'send').mockImplementation(async () => ({ Item: item }));
    const store = new DynamoDbManagedListingStore({ client, tableName: 'Listings' });

    await expect(store.get('lst-1')).resolves.toEqual({ listing, management: management() });
    expect((send.mock.calls[0]?.[0] as GetCommand).input).toEqual({
      TableName: 'Listings',
      Key: { id: 'lst-1' },
      ConsistentRead: true,
    });
    expect(store.putOp(item, null)).toEqual({
      label: 'listing.put',
      item: {
        Put: {
          TableName: 'Listings',
          Item: item,
          ConditionExpression: 'attribute_not_exists(#id)',
          ExpressionAttributeNames: { '#id': 'id' },
        },
      },
    });
    expect(store.putOp(item, 4).item.Put).toMatchObject({
      ConditionExpression: '#version = :expectedVersion',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':expectedVersion': 4 },
    });
  });

  it('queries versions descending with the cursor as exclusive start key', async () => {
    const client = documentClient();
    const lastKey = { listingId: 'lst-1', version: 2 };
    const send = jest.spyOn(client, 'send').mockImplementation(async () => ({
      Items: [version(3), version(2)],
      LastEvaluatedKey: lastKey,
    }));
    const store = new DynamoDbListingVersionStore({ client, tableName: 'ListingVersions' });

    const page = await store.list('lst-1', {
      limit: 2,
      cursor: encodeKeyCursor({ listingId: 'lst-1', version: 4 }),
    });
    expect(page).toEqual({ items: [version(3), version(2)], nextCursor: encodeKeyCursor(lastKey) });
    expect((send.mock.calls[0]?.[0] as QueryCommand).input).toEqual({
      TableName: 'ListingVersions',
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'listingId' },
      ExpressionAttributeValues: { ':pk': 'lst-1' },
      ScanIndexForward: false,
      Limit: 2,
      ConsistentRead: true,
      ExclusiveStartKey: { listingId: 'lst-1', version: 4 },
    });
    await expect(
      store.list('lst-1', {
        limit: 2,
        cursor: encodeKeyCursor({ listingId: 'lst-1', version: '4' }),
      }),
    ).rejects.toThrow(InvalidCursorError);
  });

  it('puts versions only if absent and validates them', () => {
    const store = new DynamoDbListingVersionStore({
      client: documentClient(),
      tableName: 'ListingVersions',
    });
    expect(store.putOp(version(1))).toEqual({
      label: 'listingVersion.put',
      item: {
        Put: {
          TableName: 'ListingVersions',
          Item: version(1),
          ConditionExpression: 'attribute_not_exists(#sk)',
          ExpressionAttributeNames: { '#sk': 'version' },
        },
      },
    });
    expect(() => store.putOp(version(1, { createdAt: 'yesterday' }))).toThrow();
  });

  it('reads and builds Custom_Id key operations', async () => {
    const client = documentClient();
    const send = jest
      .spyOn(client, 'send')
      .mockImplementation(async () => ({ Item: { customKey: 'agy-1#C-1', listingId: 'lst-1' } }));
    const store = new DynamoDbListingKeyStore({ client, tableName: 'ListingKeys' });

    await expect(store.get('agy-1', 'C-1')).resolves.toBe('lst-1');
    expect((send.mock.calls[0]?.[0] as GetCommand).input.Key).toEqual({ customKey: 'agy-1#C-1' });
    expect(store.assignOp('agy-1', 'C-1', 'lst-1').item.Put).toEqual({
      TableName: 'ListingKeys',
      Item: { customKey: 'agy-1#C-1', listingId: 'lst-1' },
      ConditionExpression: 'attribute_not_exists(#pk) OR #listingId = :listingId',
      ExpressionAttributeNames: { '#pk': 'customKey', '#listingId': 'listingId' },
      ExpressionAttributeValues: { ':listingId': 'lst-1' },
    });
    expect(store.releaseOp('agy-1', 'C-0', 'lst-1').item.Delete).toEqual({
      TableName: 'ListingKeys',
      Key: { customKey: 'agy-1#C-0' },
      ConditionExpression: '#listingId = :listingId',
      ExpressionAttributeNames: { '#listingId': 'listingId' },
      ExpressionAttributeValues: { ':listingId': 'lst-1' },
    });
  });

  it('adds counters with TTL only for daily values', async () => {
    const client = documentClient();
    const send = jest.spyOn(client, 'send').mockImplementation(async () => ({}));
    const store = new DynamoDbMetricCounterStore({ client, tableName: 'MetricCounters' });

    expect(
      store.addOp({ scope: 'agency#a', code: 'listing.status.ACTIVE', delta: -1 }).item.Update,
    ).toEqual({
      TableName: 'MetricCounters',
      Key: { scope: 'agency#a', sk: 'listing.status.ACTIVE#current' },
      UpdateExpression: 'ADD #value :delta',
      ExpressionAttributeNames: { '#value': 'value' },
      ExpressionAttributeValues: { ':delta': -1 },
    });
    await store.add({
      scope: 'listing#l',
      code: 'listing.detail_views',
      day: '2026-01-01',
      delta: 3,
    });
    const update = send.mock.calls[0]?.[0] as UpdateCommand;
    expect(update).toBeInstanceOf(UpdateCommand);
    expect(update.input).toEqual({
      TableName: 'MetricCounters',
      Key: { scope: 'listing#l', sk: 'listing.detail_views#2026-01-01' },
      UpdateExpression: 'ADD #value :delta SET #ttl = :ttl',
      ExpressionAttributeNames: { '#value': 'value', '#ttl': 'expiresAt' },
      // End of 2026-01-01 UTC plus 100 days.
      ExpressionAttributeValues: {
        ':delta': 3,
        ':ttl': Date.UTC(2026, 0, 2) / 1000 + 100 * 86_400,
      },
    });
  });

  it('reads counters, 0 when absent', async () => {
    const client = documentClient();
    jest
      .spyOn(client, 'send')
      .mockImplementationOnce(async () => ({
        Item: { scope: 'agency#a', sk: 'x#current', value: 7 },
      }))
      .mockImplementationOnce(async () => ({}));
    const store = new DynamoDbMetricCounterStore({ client, tableName: 'MetricCounters' });
    await expect(store.get('agency#a', 'x')).resolves.toBe(7);
    await expect(store.get('agency#a', 'y')).resolves.toBe(0);
  });
});

describe('S3SnapshotStore', () => {
  const s3 = () => new S3Client({ region: 'eu-central-1' });
  const preconditionFailed = () =>
    new S3ServiceException({
      name: 'PreconditionFailed',
      $fault: 'client',
      $metadata: { httpStatusCode: 412 },
    });

  it('writes content-addressed with If-None-Match', async () => {
    const client = s3();
    const send = jest.spyOn(client, 'send').mockImplementation(async () => ({}));
    const store = new S3SnapshotStore({ client, bucketName: 'snapshots' });

    const body = JSON.stringify(content);
    await expect(store.put('a/b', HASH, listing)).resolves.toEqual({
      created: true,
      bytes: Buffer.byteLength(body),
    });
    const command = send.mock.calls[0]?.[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({
      Bucket: 'snapshots',
      Key: `listings/a%2Fb/${HASH}.json`,
      Body: body,
      ContentType: 'application/json',
      IfNoneMatch: '*',
    });
    expect(snapshotKey('a/b', HASH)).toBe(`listings/a%2Fb/${HASH}.json`);
  });

  it('treats 412 as already stored and propagates other errors', async () => {
    const client = s3();
    jest
      .spyOn(client, 'send')
      .mockImplementationOnce(async () => {
        throw preconditionFailed();
      })
      .mockImplementationOnce(async () => {
        throw new Error('throttled');
      });
    const store = new S3SnapshotStore({ client, bucketName: 'snapshots' });
    await expect(store.put('lst-1', HASH, listing)).resolves.toMatchObject({ created: false });
    await expect(store.put('lst-1', HASH, listing)).rejects.toThrow('throttled');
  });

  it('reads snapshots and returns null for unknown hashes', async () => {
    const client = s3();
    const send = jest
      .spyOn(client, 'send')
      .mockImplementationOnce(async () => ({
        Body: { transformToString: async () => JSON.stringify(content) },
      }))
      .mockImplementationOnce(async () => {
        throw new NoSuchKey({ message: 'missing', $metadata: { httpStatusCode: 404 } });
      });
    const store = new S3SnapshotStore({ client, bucketName: 'snapshots' });

    await expect(store.get('lst-1', HASH)).resolves.toEqual(content);
    expect((send.mock.calls[0]?.[0] as GetObjectCommand).input).toEqual({
      Bucket: 'snapshots',
      Key: `listings/lst-1/${HASH}.json`,
    });
    await expect(store.get('lst-1', 'f'.repeat(64))).resolves.toBeNull();
  });
});
