import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  DynamoDbIdempotencyStore,
  IDEMPOTENCY_KEYS_BY_LISTING,
  InMemoryIdempotencyStore,
  InMemoryTransactor,
  type IdempotencyRecord,
} from '@open-estate/core';
import { IdempotencyKey, idempotencyKeyHash, idempotencyRequestHash } from '@open-estate/shared';

// Idempotenzschlüssel (duplicate-detection Req 9.2–9.6).

const NOW = 1_800_000_000;
const record = (overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord => ({
  actorKey: 'mk:key-1',
  keyHash: idempotencyKeyHash('retry-4711'),
  listingId: 'lst-1',
  requestHash: idempotencyRequestHash({ content: { title: 'x' } }),
  createdAt: '2027-01-15T08:00:00.000Z',
  expiresAt: NOW + 100,
  ...overrides,
});

describe('idempotency helpers', () => {
  it('accepts 1-128 printable ASCII characters only (Req 9.5)', () => {
    expect(IdempotencyKey.safeParse('a').success).toBe(true);
    expect(IdempotencyKey.safeParse('A-z_0.9~!'.padEnd(128, 'x')).success).toBe(true);
    for (const invalid of ['', 'with space', 'ü', 'x'.repeat(129), 'tab\t']) {
      expect(IdempotencyKey.safeParse(invalid).success).toBe(false);
    }
  });

  it('hashes bodies canonically: key order does not matter, content does', () => {
    expect(idempotencyRequestHash({ a: 1, b: { c: 2 } })).toBe(
      idempotencyRequestHash({ b: { c: 2 }, a: 1 }),
    );
    expect(idempotencyRequestHash({ a: 1 })).not.toBe(idempotencyRequestHash({ a: 2 }));
    expect(idempotencyKeyHash('k')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('InMemoryIdempotencyStore', () => {
  const tx = new InMemoryTransactor();

  it('stores a record once per actor and key until it expires', async () => {
    const store = new InMemoryIdempotencyStore();
    const first = record();
    expect((await tx.transact([store.putOp(first, NOW)])).ok).toBe(true);
    expect(await store.get('mk:key-1', first.keyHash, NOW)).toEqual(first);

    // A concurrent request with the same key loses.
    const second = await tx.transact([store.putOp(record({ listingId: 'lst-2' }), NOW)]);
    expect(second).toEqual({ ok: false, error: { failed: ['idempotency.put'] } });

    // Another actor has its own key space (Req 9.4).
    expect(await store.get('user:u-1', first.keyHash, NOW)).toBeNull();
    expect((await tx.transact([store.putOp(record({ actorKey: 'user:u-1' }), NOW)])).ok).toBe(true);

    // After 24 h the key is free again, even before the TTL removed the item.
    expect(await store.get('mk:key-1', first.keyHash, first.expiresAt)).toBeNull();
    const later = record({ listingId: 'lst-3', expiresAt: first.expiresAt + 100 });
    expect((await tx.transact([store.putOp(later, first.expiresAt)])).ok).toBe(true);
    expect(await store.keysOfListing('lst-3')).toEqual([
      { actorKey: 'mk:key-1', keyHash: first.keyHash },
    ]);
  });
});

describe('DynamoDbIdempotencyStore', () => {
  const client = () => DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));

  it('reads strongly consistent and treats an expired record as absent', async () => {
    const c = client();
    const stored = record();
    const send = jest
      .spyOn(c, 'send')
      .mockImplementation(async () => ({ Item: { key: `mk:key-1#${stored.keyHash}`, ...stored } }));
    const store = new DynamoDbIdempotencyStore({ client: c, tableName: 'IdempotencyKeys' });

    expect(await store.get('mk:key-1', stored.keyHash, NOW)).toEqual(stored);
    expect((send.mock.calls[0]?.[0] as GetCommand).input).toEqual({
      TableName: 'IdempotencyKeys',
      Key: { key: `mk:key-1#${stored.keyHash}` },
      ConsistentRead: true,
    });
    expect(await store.get('mk:key-1', stored.keyHash, stored.expiresAt)).toBeNull();
  });

  it('puts unless an unexpired record exists', () => {
    const store = new DynamoDbIdempotencyStore({ client: client(), tableName: 'IdempotencyKeys' });
    const op = store.putOp(record(), NOW);
    expect(op.label).toBe('idempotency.put');
    expect(op.item.Put).toMatchObject({
      ConditionExpression: 'attribute_not_exists(#key) OR #expiresAt <= :now',
      ExpressionAttributeValues: { ':now': NOW },
      Item: { key: `mk:key-1#${record().keyHash}`, listingId: 'lst-1', expiresAt: NOW + 100 },
    });
  });

  it('finds the records of a listing via the byListing index', async () => {
    const c = client();
    const hash = record().keyHash;
    const send = jest.spyOn(c, 'send').mockImplementation(async () => ({
      Items: [{ key: `user:u#1#${hash}`, listingId: 'lst-1' }],
    }));
    const store = new DynamoDbIdempotencyStore({ client: c, tableName: 'IdempotencyKeys' });

    // Actor keys may contain `#`; the hash has a fixed length at the end.
    expect(await store.keysOfListing('lst-1')).toEqual([{ actorKey: 'user:u#1', keyHash: hash }]);
    expect((send.mock.calls[0]?.[0] as QueryCommand).input).toMatchObject({
      IndexName: IDEMPOTENCY_KEYS_BY_LISTING,
      ExpressionAttributeValues: { ':listingId': 'lst-1' },
    });
  });

  it('purges the records of a listing and verifies against the table (Req 12.3)', async () => {
    const c = client();
    const hash = record().keyHash;
    const send = jest
      .spyOn(c, 'send')
      .mockImplementationOnce(async () => ({
        Items: [{ key: `mk:key-1#${hash}`, listingId: 'lst-1' }],
      }))
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => ({}));
    const store = new DynamoDbIdempotencyStore({ client: c, tableName: 'IdempotencyKeys' });

    expect(await store.purgeListing('lst-1')).toEqual({ complete: true });
    expect((send.mock.calls[1]?.[0] as DeleteCommand).input.Key).toEqual({
      key: `mk:key-1#${hash}`,
    });
    expect((send.mock.calls[2]?.[0] as GetCommand).input.ConsistentRead).toBe(true);
  });
});
