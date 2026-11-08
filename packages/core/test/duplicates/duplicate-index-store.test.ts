import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  agencyScope,
  DUPLICATE_INDEX_BY_BLOCK,
  DynamoDbDuplicateIndexStore,
  InMemoryDuplicateIndexStore,
  InMemoryTransactor,
  scopeAgency,
  type StoredProfile,
} from '@open-estate/core';
import {
  assertValidTaxonomy,
  blockKeys,
  buildProfile,
  DEFAULT_DUPLICATE_CONFIG,
  DEFAULT_TAXONOMY_CONFIG,
  ListingContent,
} from '@open-estate/shared';

// `DuplicateIndex` stores (duplicate-detection design: "Duplikat_Index").

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const config = DEFAULT_DUPLICATE_CONFIG;

const content = (street = 'Hauptstraße 12') =>
  ListingContent.parse({
    originalLocale: 'de',
    title: 'Helle Wohnung',
    description: 'Mit Balkon',
    translations: [],
    offers: [{ offerType: 'SALE', price: '350000.00', currency: 'EUR' }],
    listingType: 'apartment_unit',
    rooms: 3,
    area: '85.50',
    address: { city: 'Berlin', postalCode: '10115', country: 'DE', street },
    sourceUrl: 'https://makler.example/w/1',
    media: [],
    tours: [],
  });

function stored(
  listingId: string,
  overrides: Partial<StoredProfile> = {},
  street?: string,
): StoredProfile {
  const profile = buildProfile(content(street), { taxonomy, config });
  return {
    listingId,
    scope: agencyScope('agy-1'),
    createdAt: '2026-01-01T10:00:00.000Z',
    listingVersion: 1,
    profile,
    blockKeys: blockKeys(profile, config),
    dismissed: [],
    ...overrides,
  };
}

describe('InMemoryDuplicateIndexStore', () => {
  const tx = new InMemoryTransactor();

  it('stores profiles and blocks and finds candidates within and across Prüfbereiche', async () => {
    const store = new InMemoryDuplicateIndexStore();
    const a = stored('a');
    const b = stored('b', { scope: agencyScope('agy-2') });
    await tx.transact([...store.syncOps(null, a), ...store.syncOps(null, b)]);

    expect(await store.getProfile('a')).toEqual({ ...a, revision: 1 });
    expect([...(await store.getProfiles(['a', 'b', 'x'])).keys()].sort()).toEqual(['a', 'b']);
    const key = a.blockKeys[0] ?? '';
    const inScope = await store.candidates([key], agencyScope('agy-1'));
    expect(inScope.map((c) => c.listingId)).toEqual(['a']);
    const all = await store.candidates([key]);
    expect(all.map((c) => c.listingId).sort()).toEqual(['a', 'b']);
    expect(all.find((c) => c.listingId === 'b')?.scope).toBe(agencyScope('agy-2'));
  });

  it('moves blocks on a content change and removes everything with `after = null`', async () => {
    const store = new InMemoryDuplicateIndexStore();
    const before = stored('a');
    await tx.transact(store.syncOps(null, before));
    const after = stored('a', { listingVersion: 2 }, 'Bahnhofstraße 3');
    await tx.transact(store.syncOps(before, after));

    const keys = store.snapshot().blocks.map((block) => block.key);
    expect(keys.sort()).toEqual([...after.blockKeys].sort());
    expect((await store.getProfile('a'))?.listingVersion).toBe(2);

    await tx.transact(store.syncOps(after, null));
    expect(store.snapshot()).toEqual({ profiles: [], blocks: [], exact: [], reportRefs: [] });
  });

  it('writes no block twice and no unchanged block at all', () => {
    const store = new InMemoryDuplicateIndexStore();
    const before = stored('a');
    const same = store.syncOps(before, { ...before, listingVersion: 2 });
    expect(same.map((op) => op.label)).toEqual(['duplicateIndex.profile']);
    const moved = store.syncOps(before, { ...before, scope: agencyScope('agy-2') });
    const targets = moved.map((op) => op.target);
    expect(new Set(targets).size).toBe(targets.length);
    expect(moved.filter((op) => op.label === 'duplicateIndex.block')).toHaveLength(
      before.blockKeys.length,
    );
  });

  it('guards the exact key: one owner, release only by the owner', async () => {
    const store = new InMemoryDuplicateIndexStore();
    const scope = agencyScope('agy-1');
    expect((await tx.transact([store.claimExactOp(scope, 'k', 'a')])).ok).toBe(true);
    expect((await tx.transact([store.claimExactOp(scope, 'k', 'a')])).ok).toBe(true);
    const taken = await tx.transact([store.claimExactOp(scope, 'k', 'b')]);
    expect(taken).toEqual({ ok: false, error: { failed: ['duplicateIndex.exactClaim'] } });
    expect((await tx.transact([store.releaseExactOp(scope, 'k', 'b')])).ok).toBe(false);
    expect(await store.exactOwner(scope, 'k')).toBe('a');
    expect((await tx.transact([store.releaseExactOp(scope, 'k', 'a')])).ok).toBe(true);
    expect(await store.exactOwner(scope, 'k')).toBeNull();
    // Another Prüfbereich has its own key space.
    expect(await store.exactOwner(agencyScope('agy-2'), 'k')).toBeNull();
  });

  it('simulates the eventually consistent GSI when lagging', async () => {
    const store = new InMemoryDuplicateIndexStore({ lagging: true });
    const a = stored('a');
    await tx.transact(store.syncOps(null, a));
    const key = a.blockKeys[0] ?? '';
    expect(await store.candidates([key])).toEqual([]);
    // The table itself is consistent.
    expect(await store.getProfile('a')).toEqual({ ...a, revision: 1 });
    store.flushIndex();
    expect((await store.candidates([key])).map((c) => c.listingId)).toEqual(['a']);
  });

  it('counts revisions and fails a guarded write on a changed profile', async () => {
    const store = new InMemoryDuplicateIndexStore();
    const a = stored('a');
    expect((await tx.transact(store.syncOps(null, a, { guard: true }))).ok).toBe(true);
    // A second guarded creation sees the stored profile.
    const again = await tx.transact(store.syncOps(null, a, { guard: true }));
    expect(again).toEqual({ ok: false, error: { failed: ['duplicateIndex.profile'] } });
    const first = await store.getProfile('a');
    if (first === null) throw new Error('profile missing');
    expect(first.revision).toBe(1);
    const dismissed = { ...first, dismissed: ['b'] };
    expect((await tx.transact(store.syncOps(first, dismissed, { guard: true }))).ok).toBe(true);
    expect((await store.getProfile('a'))?.revision).toBe(2);
    // Based on revision 1: rejected, the Verwerfung stays.
    const stale = await tx.transact(
      store.syncOps(first, { ...first, listingVersion: 2 }, { guard: true }),
    );
    expect(stale.ok).toBe(false);
    expect((await store.getProfile('a'))?.dismissed).toEqual(['b']);
    // Unguarded writes apply regardless.
    expect((await tx.transact(store.syncOps(first, first))).ok).toBe(true);
  });

  it('keeps Treffer-Verweise and releases exact keys only for their owner', async () => {
    const store = new InMemoryDuplicateIndexStore();
    await tx.transact([store.reportRefOp('a', 'r1'), store.reportRefOp('a', 'r2')]);
    expect(await store.reportRefs('a')).toEqual(['r1', 'r2']);
    await store.deleteReportRef('a', 'r1');
    expect(await store.reportRefs('a')).toEqual(['r2']);
    await store.purgeListing('a');
    expect(await store.reportRefs('a')).toEqual([]);

    const scope = agencyScope('agy-1');
    await tx.transact([store.claimExactOp(scope, 'k', 'a')]);
    expect(await store.releaseExact(scope, 'k', 'b')).toBe(false);
    expect(await store.releaseExact(scope, 'k', 'a')).toBe(true);
    expect(await store.exactOwner(scope, 'k')).toBeNull();
  });

  it('scans every item exactly once across segments, page by page', async () => {
    const store = new InMemoryDuplicateIndexStore();
    const profiles = ['a', 'b', 'c', 'd', 'e'].map((id) => stored(id));
    await tx.transact(profiles.flatMap((p) => store.syncOps(null, p)));
    await tx.transact([
      store.claimExactOp(agencyScope('agy-1'), 'k', 'a'),
      store.reportRefOp('b', 'r1'),
    ]);
    const seen: string[] = [];
    for (let segment = 0; segment < 3; segment += 1) {
      let cursor: string | undefined;
      do {
        const page = await store.scan({
          segment,
          segments: 3,
          limit: 2,
          ...(cursor !== undefined && { cursor }),
        });
        expect(page.items.length).toBeLessThanOrEqual(2);
        for (const entry of page.items) seen.push(JSON.stringify(entry));
        cursor = page.cursor;
      } while (cursor !== undefined);
    }
    const snapshot = store.snapshot();
    const expected = snapshot.profiles.length + snapshot.blocks.length + snapshot.exact.length + 1;
    expect(seen).toHaveLength(expected);
    expect(new Set(seen).size).toBe(expected);
    const kinds = seen.map((entry) => (JSON.parse(entry) as { kind: string }).kind);
    expect(new Set(kinds)).toEqual(new Set(['profile', 'block', 'exact', 'reportRef']));
    const exact = seen
      .map((e) => JSON.parse(e) as Record<string, unknown>)
      .find((e) => e['kind'] === 'exact');
    expect(exact).toEqual({
      kind: 'exact',
      scope: agencyScope('agy-1'),
      exactKey: 'k',
      listingId: 'a',
    });
  });

  it('rejects a malformed profile before it is stored', () => {
    const store = new InMemoryDuplicateIndexStore();
    expect(() => store.syncOps(null, { ...stored('a'), scope: 'nope' })).toThrow();
  });

  it('maps scopes back to agencies', () => {
    expect(scopeAgency(agencyScope('agy-1'))).toBe('agy-1');
    expect(scopeAgency(agencyScope(undefined))).toBeUndefined();
  });
});

describe('DynamoDbDuplicateIndexStore', () => {
  const client = () => DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));

  it('queries the block index with the Prüfbereich as key prefix and pages through', async () => {
    const c = client();
    const send = jest
      .spyOn(c, 'send')
      .mockImplementationOnce(async () => ({
        Items: [{ pk: 'L#a', sk: 'B#A|x', gsiBlock: 'A|x', gsiSk: 'agency#agy-1#2026#a' }],
        LastEvaluatedKey: { pk: 'L#a' },
      }))
      .mockImplementationOnce(async () => ({
        Items: [{ pk: 'L#b#1', sk: 'B#A|x', gsiBlock: 'A|x', gsiSk: 'agency#agy-1#2026#b#1' }],
      }));
    const store = new DynamoDbDuplicateIndexStore({ client: c, tableName: 'DuplicateIndex' });

    const refs = await store.candidates(['A|x'], agencyScope('agy-1'));

    // Listing ids may contain `#`; they are read from the table key, not from the sort key.
    expect(refs).toEqual([
      { listingId: 'a', scope: 'agency#agy-1', key: 'A|x' },
      { listingId: 'b#1', scope: 'agency#agy-1', key: 'A|x' },
    ]);
    const first = send.mock.calls[0]?.[0] as QueryCommand;
    expect(first.input).toEqual({
      TableName: 'DuplicateIndex',
      IndexName: DUPLICATE_INDEX_BY_BLOCK,
      KeyConditionExpression: '#block = :block AND begins_with(#sk, :scope)',
      ExpressionAttributeNames: { '#block': 'gsiBlock', '#sk': 'gsiSk' },
      ExpressionAttributeValues: { ':block': 'A|x', ':scope': 'agency#agy-1#' },
    });
    expect((send.mock.calls[1]?.[0] as QueryCommand).input.ExclusiveStartKey).toEqual({
      pk: 'L#a',
    });
  });

  it('queries across Prüfbereiche without a sort key condition', async () => {
    const c = client();
    const send = jest.spyOn(c, 'send').mockImplementation(async () => ({ Items: [] }));
    const store = new DynamoDbDuplicateIndexStore({ client: c, tableName: 'DuplicateIndex' });
    await store.candidates(['A|x', 'A|x']);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0]?.[0] as QueryCommand).input.KeyConditionExpression).toBe(
      '#block = :block',
    );
  });

  it('reads profiles strongly consistent and batches with retries of unprocessed keys', async () => {
    const c = client();
    const a = stored('a');
    const b = stored('b');
    const send = jest
      .spyOn(c, 'send')
      .mockImplementationOnce(async () => ({ Item: { pk: 'L#a', sk: 'P', ...a } }))
      .mockImplementationOnce(async () => ({
        Responses: { DuplicateIndex: [{ pk: 'L#a', sk: 'P', ...a }] },
        UnprocessedKeys: { DuplicateIndex: { Keys: [{ pk: 'L#b', sk: 'P' }] } },
      }))
      .mockImplementationOnce(async () => ({
        Responses: { DuplicateIndex: [{ pk: 'L#b', sk: 'P', ...b }] },
      }));
    const store = new DynamoDbDuplicateIndexStore({ client: c, tableName: 'DuplicateIndex' });

    expect(await store.getProfile('a')).toEqual(a);
    expect((send.mock.calls[0]?.[0] as GetCommand).input).toEqual({
      TableName: 'DuplicateIndex',
      Key: { pk: 'L#a', sk: 'P' },
      ConsistentRead: true,
    });
    const profiles = await store.getProfiles(['a', 'b']);
    expect([...profiles.keys()].sort()).toEqual(['a', 'b']);
    expect((send.mock.calls[2]?.[0] as BatchGetCommand).input.RequestItems).toEqual({
      DuplicateIndex: { Keys: [{ pk: 'L#b', sk: 'P' }] },
    });
  });

  it('builds profile, block and exact-key operations', () => {
    const store = new DynamoDbDuplicateIndexStore({
      client: client(),
      tableName: 'DuplicateIndex',
    });
    const a = stored('a');
    const ops = store.syncOps(null, a);
    expect(ops[0]?.item.Put?.Item).toMatchObject({ pk: 'L#a', sk: 'P', listingId: 'a' });
    const block = ops[1]?.item.Put?.Item;
    expect(block).toEqual({
      pk: 'L#a',
      sk: `B#${a.blockKeys[0]}`,
      gsiBlock: a.blockKeys[0],
      gsiSk: `agency#agy-1#2026-01-01T10:00:00.000Z#a`,
    });
    expect(store.syncOps(a, null).map((op) => Object.keys(op.item)[0])).toEqual(
      a.blockKeys.map(() => 'Delete').concat('Delete'),
    );
    expect(store.claimExactOp('agency#agy-1', 'k', 'a').item.Put).toMatchObject({
      Item: { pk: 'X#agency#agy-1#k', sk: 'X', listingId: 'a' },
      ConditionExpression: 'attribute_not_exists(#pk) OR #listingId = :listingId',
    });
    expect(store.releaseExactOp('agency#agy-1', 'k', 'a').item.Delete).toMatchObject({
      Key: { pk: 'X#agency#agy-1#k', sk: 'X' },
      ConditionExpression: '#listingId = :listingId',
    });
  });

  it('guards profile writes by revision and increments it', () => {
    const store = new DynamoDbDuplicateIndexStore({
      client: client(),
      tableName: 'DuplicateIndex',
    });
    const a = stored('a');
    const created = store.syncOps(null, a, { guard: true })[0]?.item.Put;
    expect(created).toMatchObject({
      Item: { revision: 1 },
      ConditionExpression: 'attribute_not_exists(#pk)',
    });
    const legacy = store.syncOps(a, a, { guard: true })[0]?.item.Put;
    expect(legacy?.ConditionExpression).toBe(
      'attribute_exists(#pk) AND attribute_not_exists(#revision)',
    );
    const revised = { ...a, revision: 4 };
    const updated = store.syncOps(revised, revised, { guard: true })[0]?.item.Put;
    expect(updated).toMatchObject({
      Item: { revision: 5 },
      ConditionExpression: '#revision = :revision',
      ExpressionAttributeValues: { ':revision': 4 },
    });
    const removed = store.syncOps(revised, null, { guard: true }).at(-1);
    expect(removed?.item.Delete?.ConditionExpression).toBeUndefined();
    expect(store.syncOps(revised, null, { guard: true })[0]?.item.Delete).toMatchObject({
      ConditionExpression: '#revision = :revision',
    });
    expect(store.syncOps(null, a)[0]?.item.Put?.ConditionExpression).toBeUndefined();
  });

  it('reads profiles strongly consistent on request', async () => {
    const c = client();
    const send = jest.spyOn(c, 'send').mockImplementation(async () => ({ Responses: {} }));
    const store = new DynamoDbDuplicateIndexStore({ client: c, tableName: 'DuplicateIndex' });
    await store.getProfiles(['a'], { consistent: true });
    expect((send.mock.calls[0]?.[0] as BatchGetCommand).input.RequestItems).toEqual({
      DuplicateIndex: { Keys: [{ pk: 'L#a', sk: 'P' }], ConsistentRead: true },
    });
  });

  it('scans segments and maps every item kind', async () => {
    const c = client();
    const a = stored('a');
    const send = jest.spyOn(c, 'send').mockImplementationOnce(async () => ({
      Items: [
        { pk: 'L#a', sk: 'P', ...a },
        { pk: 'L#a', sk: 'B#A|x', gsiBlock: 'A|x', gsiSk: 'agency#agy-1#2026#a' },
        { pk: 'L#a', sk: 'R#r1' },
        { pk: 'X#agency#agy-1#k1', sk: 'X', listingId: 'a' },
        { pk: 'other', sk: 'X' },
      ],
      LastEvaluatedKey: { pk: 'L#a', sk: 'R#r1' },
    }));
    const store = new DynamoDbDuplicateIndexStore({ client: c, tableName: 'DuplicateIndex' });
    const page = await store.scan({ segment: 2, segments: 8, limit: 50 });
    expect(page.items).toEqual([
      { kind: 'profile', profile: a },
      { kind: 'block', listingId: 'a', key: 'A|x' },
      { kind: 'reportRef', listingId: 'a', reportId: 'r1' },
      { kind: 'exact', scope: 'agency#agy-1', exactKey: 'k1', listingId: 'a' },
    ]);
    expect((send.mock.calls[0]?.[0] as ScanCommand).input).toEqual({
      TableName: 'DuplicateIndex',
      ConsistentRead: true,
      Segment: 2,
      TotalSegments: 8,
      Limit: 50,
    });
    expect(page.cursor).toBeDefined();
    send.mockImplementationOnce(async () => ({ Items: [] }));
    const next = await store.scan({
      segment: 2,
      segments: 8,
      limit: 50,
      ...(page.cursor !== undefined && { cursor: page.cursor }),
    });
    expect(next).toEqual({ items: [] });
    expect((send.mock.calls[1]?.[0] as ScanCommand).input.ExclusiveStartKey).toEqual({
      pk: 'L#a',
      sk: 'R#r1',
    });
  });

  it('reads, writes and deletes Treffer-Verweise; releases exact keys conditionally', async () => {
    const c = client();
    const send = jest
      .spyOn(c, 'send')
      .mockImplementationOnce(async () => ({
        Items: [{ pk: 'L#a', sk: 'R#r1' }],
        LastEvaluatedKey: { pk: 'L#a', sk: 'R#r1' },
      }))
      .mockImplementationOnce(async () => ({ Items: [{ pk: 'L#a', sk: 'R#r2' }] }))
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('failed'), { name: 'ConditionalCheckFailedException' });
      });
    const store = new DynamoDbDuplicateIndexStore({ client: c, tableName: 'DuplicateIndex' });
    expect(store.reportRefOp('a', 'r1').item.Put?.Item).toEqual({ pk: 'L#a', sk: 'R#r1' });
    expect(await store.reportRefs('a')).toEqual(['r1', 'r2']);
    expect((send.mock.calls[0]?.[0] as QueryCommand).input).toMatchObject({
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeValues: { ':pk': 'L#a', ':prefix': 'R#' },
      ConsistentRead: true,
    });
    await store.deleteReportRef('a', 'r1');
    expect((send.mock.calls[2]?.[0] as DeleteCommand).input.Key).toEqual({
      pk: 'L#a',
      sk: 'R#r1',
    });
    expect(await store.releaseExact('agency#agy-1', 'k', 'a')).toBe(true);
    expect((send.mock.calls[3]?.[0] as DeleteCommand).input).toMatchObject({
      Key: { pk: 'X#agency#agy-1#k', sk: 'X' },
      ConditionExpression: '#listingId = :listingId',
      ExpressionAttributeValues: { ':listingId': 'a' },
    });
    expect(await store.releaseExact('agency#agy-1', 'k', 'a')).toBe(false);
  });

  it('reads the exact key owner strongly consistent', async () => {
    const c = client();
    jest
      .spyOn(c, 'send')
      .mockImplementationOnce(async () => ({
        Item: { pk: 'X#agency#agy-1#k', sk: 'X', listingId: 'a' },
      }))
      .mockImplementationOnce(async () => ({}));
    const store = new DynamoDbDuplicateIndexStore({ client: c, tableName: 'DuplicateIndex' });
    expect(await store.exactOwner('agency#agy-1', 'k')).toBe('a');
    expect(await store.exactOwner('agency#agy-1', 'k')).toBeNull();
  });

  it('purges a listing: owned exact key first, then every item, then verifies (Req 12.3)', async () => {
    const c = client();
    const a = { ...stored('a'), exactClaimed: true };
    const send = jest
      .spyOn(c, 'send')
      .mockImplementationOnce(async () => ({
        Items: [
          { pk: 'L#a', sk: 'P', ...a },
          { pk: 'L#a', sk: `B#${a.blockKeys[0]}` },
        ],
      }))
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => ({ Items: [] }));
    const store = new DynamoDbDuplicateIndexStore({ client: c, tableName: 'DuplicateIndex' });

    expect(await store.purgeListing('a')).toEqual({ complete: true });
    const [query, exact, batch, verify] = send.mock.calls.map(([command]) => command);
    expect((query as QueryCommand).input).toMatchObject({
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeValues: { ':pk': 'L#a' },
      ConsistentRead: true,
    });
    expect((exact as DeleteCommand).input).toMatchObject({
      Key: { pk: `X#agency#agy-1#${a.profile.exactKey}`, sk: 'X' },
      ConditionExpression: '#listingId = :listingId',
    });
    expect((batch as BatchWriteCommand).input.RequestItems).toEqual({
      DuplicateIndex: [
        { DeleteRequest: { Key: { pk: 'L#a', sk: 'P' } } },
        { DeleteRequest: { Key: { pk: 'L#a', sk: `B#${a.blockKeys[0]}` } } },
      ],
    });
    expect((verify as QueryCommand).input.Limit).toBe(1);
  });

  it('reports an incomplete purge when items remain', async () => {
    const c = client();
    jest
      .spyOn(c, 'send')
      .mockImplementationOnce(async () => ({ Items: [{ pk: 'L#a', sk: 'B#x' }] }))
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => ({ Items: [{ pk: 'L#a', sk: 'B#x' }] }));
    const store = new DynamoDbDuplicateIndexStore({ client: c, tableName: 'DuplicateIndex' });
    expect(await store.purgeListing('a')).toEqual({ complete: false });
  });
});
