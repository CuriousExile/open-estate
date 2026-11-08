import {
  agencyScope,
  customIdBlocklistKey,
  DynamoDbDeletionBlocklistCheck,
  DynamoDbManagedListingStore,
  InMemoryDeletionBlocklistCheck,
  InMemoryListingKeyStore,
  InMemoryListingVersionStore,
  InMemoryManagedListingStore,
  InMemoryMetricCounterStore,
  InMemorySnapshotStore,
  InMemoryTransactor,
  snapshotKey,
  VersionedListingWriter,
  type StateChange,
} from '@open-estate/core';
import {
  CONTENT_FIELDS,
  contentHash,
  contentPaths,
  type ActorRef,
  type ListingContent,
  type VersionedState,
} from '@open-estate/shared';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { exampleListing } from '../../../shared/test/arbitraries';

const ID = 'lst-1';
const USER: ActorRef = { kind: 'user', userId: 'u1', displayName: 'Ada' };
const CONNECTOR: ActorRef = { kind: 'connector', connectorId: 'crm', runId: 'run-7' };
const T0 = Date.parse('2026-03-01T10:00:00.000Z');

const baseContent = (): ListingContent => {
  const listing = exampleListing(ID) as Record<string, unknown>;
  return Object.fromEntries(
    CONTENT_FIELDS.flatMap((field) => (field in listing ? [[field, listing[field]]] : [])),
  ) as ListingContent;
};

const state = (overrides: Partial<VersionedState> = {}): VersionedState => ({
  content: baseContent(),
  status: 'ACTIVE',
  agencyId: 'agy-1',
  customId: 'C-1',
  ...overrides,
});

function setup() {
  let now = T0;
  const stores = {
    listings: new InMemoryManagedListingStore(),
    versions: new InMemoryListingVersionStore(),
    keys: new InMemoryListingKeyStore(),
    blocklist: new InMemoryDeletionBlocklistCheck(),
    counters: new InMemoryMetricCounterStore(),
    snapshots: new InMemorySnapshotStore(),
  };
  const writer = new VersionedListingWriter({
    ...stores,
    transactor: new InMemoryTransactor(),
    clock: () => now,
  });
  const advance = (ms: number) => {
    now += ms;
  };
  return { ...stores, writer, advance };
}

const create = (overrides: Partial<StateChange> = {}): StateChange => ({
  listingId: ID,
  expectedVersion: null,
  next: state(),
  changeType: 'CREATE',
  channel: 'PORTAL',
  actor: USER,
  ...overrides,
});

const counters = async (c: InMemoryMetricCounterStore, agencyId = 'agy-1') => ({
  active: await c.get(agencyScope(agencyId), 'listing.status.ACTIVE'),
  inactive: await c.get(agencyScope(agencyId), 'listing.status.INACTIVE'),
  versions: await c.get(agencyScope(agencyId), 'history.version_count'),
  bytes: await c.get(agencyScope(agencyId), 'history.storage_bytes'),
});

describe('VersionedListingWriter: creation', () => {
  it('stores listing, version 1, snapshot, key, field sources, provenance and counters', async () => {
    const s = setup();
    const result = await s.writer.write(create());
    expect(result.ok && result.value.outcome).toBe('created');

    const stored = await s.listings.get(ID);
    const content = baseContent();
    const hash = contentHash(content);
    expect(stored?.management).toEqual({
      status: 'ACTIVE',
      agencyId: 'agy-1',
      origin: 'MANUAL',
      customId: 'C-1',
      version: 1,
      contentHash: hash,
      fieldSources: Object.fromEntries(
        contentPaths(content).map((path) => [path, { channel: 'PORTAL', actor: USER, version: 1 }]),
      ),
      updatedAt: '2026-03-01T10:00:00.000Z',
      // Anlagezeitpunkt of version 1 (duplicate-detection Req 4.3).
      createdAt: '2026-03-01T10:00:00.000Z',
    });
    expect(stored?.listing).toMatchObject({
      id: ID,
      source: 'agency:agy-1',
      lastImportedAt: '2026-03-01T10:00:00.000Z',
      lastRunId: 'PORTAL#1',
    });
    expect(result.ok && result.value.listing).toEqual(stored);

    const [v1] = s.versions.all();
    expect(v1).toMatchObject({
      version: 1,
      changeType: 'CREATE',
      channel: 'PORTAL',
      actor: USER,
      createdAt: '2026-03-01T10:00:00.000Z',
      status: 'ACTIVE',
      customId: 'C-1',
      agencyId: 'agy-1',
      contentHash: hash,
      newSnapshot: true,
    });
    expect(v1?.changedPaths).toEqual(
      contentPaths(content).map((path) => ({ path, overwrittenByImport: false })),
    );
    expect(s.snapshots.keys()).toEqual([snapshotKey(ID, hash)]);
    expect(await s.keys.get('agy-1', 'C-1')).toBe(ID);
    expect(await counters(s.counters)).toEqual({
      active: 1,
      inactive: 0,
      versions: 1,
      bytes: v1?.snapshotBytes,
    });
    expect(await s.counters.get(agencyScope('agy-1'), 'listing.changes.PORTAL', '2026-03-01')).toBe(
      1,
    );
  });

  it('creates import listings with the connector as source and the run as lastRunId', async () => {
    const s = setup();
    await s.writer.write(
      create({ channel: 'IMPORT', changeType: 'IMPORT', actor: CONNECTOR, next: state() }),
    );
    const stored = await s.listings.get(ID);
    expect(stored?.management.origin).toBe('IMPORT');
    expect(stored?.listing).toMatchObject({ source: 'crm', lastRunId: 'run-7' });
  });

  it('counts listings without agency under the `_none` scope', async () => {
    const s = setup();
    await s.writer.write(
      create({
        channel: 'IMPORT',
        changeType: 'IMPORT',
        actor: CONNECTOR,
        next: { content: baseContent(), status: 'INACTIVE' },
      }),
    );
    expect(await s.counters.get(agencyScope(undefined), 'listing.status.INACTIVE')).toBe(1);
  });
});

describe('VersionedListingWriter: unchanged writes', () => {
  it('creates no version for an unchanged edit or status (Req 4.7, 6.9)', async () => {
    const s = setup();
    await s.writer.write(create());
    const before = s.listings.all();
    const countersBefore = s.counters.entries();
    s.advance(60_000);

    const result = await s.writer.write(
      create({ expectedVersion: 1, changeType: 'UPDATE', next: state() }),
    );
    expect(result.ok && result.value.outcome).toBe('unchanged');
    expect(s.versions.all()).toHaveLength(1);
    expect(s.listings.all()).toEqual(before);
    expect(s.counters.entries()).toEqual(countersBefore);
  });

  it('only refreshes lastImportedAt/lastRunId for an unchanged import (Req 4.16, 7.3)', async () => {
    const s = setup();
    await s.writer.write(create());
    s.advance(60_000);
    const result = await s.writer.write(
      create({ expectedVersion: 1, channel: 'IMPORT', changeType: 'IMPORT', actor: CONNECTOR }),
    );
    expect(result.ok && result.value.outcome).toBe('unchanged');
    const stored = await s.listings.get(ID);
    expect(stored?.listing).toMatchObject({
      source: 'agency:agy-1',
      lastImportedAt: '2026-03-01T10:01:00.000Z',
      lastRunId: 'run-7',
    });
    expect(stored?.management.version).toBe(1);
    expect(stored?.management.updatedAt).toBe('2026-03-01T10:00:00.000Z');
    expect(result.ok && result.value.listing).toEqual(stored);
    expect(s.versions.all()).toHaveLength(1);
  });
});

describe('VersionedListingWriter: versions', () => {
  it('marks exactly the fields an import overwrote and updates field sources (Req 7.2, 12.11)', async () => {
    const s = setup();
    const content = baseContent();
    await s.writer.write(
      create({
        next: state({ content: { ...content, address: { ...content.address, street: 'Main 1' } } }),
      }),
    );
    const imported = {
      ...content,
      title: 'Imported title',
      address: { ...content.address, city: 'Hamburg' },
    };
    const result = await s.writer.write(
      create({
        expectedVersion: 1,
        channel: 'IMPORT',
        changeType: 'IMPORT',
        actor: CONNECTOR,
        next: state({ content: imported }),
      }),
    );
    expect(result.ok && result.value.outcome).toBe('updated');

    const portal = { channel: 'PORTAL', actor: USER, version: 1 };
    const fromImport = { channel: 'IMPORT', actor: CONNECTOR, version: 2 };
    expect((await s.versions.get(ID, 2))?.changedPaths).toEqual([
      { path: 'address.city', previous: portal, overwrittenByImport: true },
      { path: 'address.street', previous: portal, overwrittenByImport: true },
      { path: 'title', previous: portal, overwrittenByImport: true },
    ]);
    const stored = await s.listings.get(ID);
    expect(Object.keys(stored?.management.fieldSources ?? {}).sort()).toEqual(
      contentPaths(imported),
    );
    expect(stored?.management.fieldSources['address.city']).toEqual(fromImport);
    expect(stored?.management.fieldSources['address.country']).toEqual(portal);
    expect(stored?.management.fieldSources).not.toHaveProperty('address.street');
    expect(stored?.listing).toMatchObject({ source: 'agency:agy-1', lastRunId: 'run-7' });

    // A second import over an import-sourced field is no "overwritten by import".
    await s.writer.write(
      create({
        expectedVersion: 2,
        channel: 'IMPORT',
        changeType: 'IMPORT',
        actor: CONNECTOR,
        next: state({ content: { ...imported, title: 'Again' } }),
      }),
    );
    expect((await s.versions.get(ID, 3))?.changedPaths).toEqual([
      { path: 'title', previous: fromImport, overwrittenByImport: false },
    ]);
  });

  it('deduplicates the snapshot of a status version and moves the status counter', async () => {
    const s = setup();
    await s.writer.write(create());
    const bytes = (await counters(s.counters)).bytes;
    s.advance(1000);
    const result = await s.writer.write(
      create({ expectedVersion: 1, changeType: 'STATUS', next: state({ status: 'INACTIVE' }) }),
    );
    expect(result.ok && result.value.outcome).toBe('updated');
    expect(await s.versions.get(ID, 2)).toMatchObject({
      changeType: 'STATUS',
      status: 'INACTIVE',
      newSnapshot: false,
      changedPaths: [],
    });
    expect(s.snapshots.keys()).toHaveLength(1);
    expect(await counters(s.counters)).toEqual({ active: 0, inactive: 1, versions: 2, bytes });
    expect((await s.listings.get(ID))?.listing.lastRunId).toBe('PORTAL#2');
  });

  it('stores restoredFrom of a restore version', async () => {
    const s = setup();
    await s.writer.write(create());
    await s.writer.write(
      create({
        expectedVersion: 1,
        changeType: 'RESTORE',
        restoredFrom: 1,
        next: state({ content: { ...baseContent(), title: 'Other' } }),
      }),
    );
    expect((await s.versions.get(ID, 2))?.restoredFrom).toBe(1);
  });

  it('moves key and counters to the new agency on assignment (Req 10.6)', async () => {
    const s = setup();
    await s.writer.write(create());
    await s.writer.write(
      create({
        expectedVersion: 1,
        changeType: 'UPDATE',
        channel: 'ADMIN',
        next: state({ agencyId: 'agy-2' }),
      }),
    );
    expect(await s.keys.get('agy-1', 'C-1')).toBeNull();
    expect(await s.keys.get('agy-2', 'C-1')).toBe(ID);
    expect((await counters(s.counters, 'agy-1')).active).toBe(0);
    expect((await counters(s.counters, 'agy-2')).active).toBe(1);
    expect((await s.listings.get(ID))?.listing.source).toBe('agency:agy-2');
  });

  it('replaces and removes the Custom_Id key', async () => {
    const s = setup();
    await s.writer.write(create());
    await s.writer.write(create({ expectedVersion: 1, next: state({ customId: 'C-2' }) }));
    expect(s.keys.entries()).toEqual([['agy-1#C-2', ID]]);
    const { customId: _removed, ...withoutCustomId } = state();
    void _removed;
    await s.writer.write(create({ expectedVersion: 2, next: withoutCustomId }));
    expect(s.keys.entries()).toEqual([]);
    expect((await s.listings.get(ID))?.management).not.toHaveProperty('customId');
  });
});

describe('VersionedListingWriter: conflicts', () => {
  it('rejects a stale or missing base version with the current version (Req 4.8)', async () => {
    const s = setup();
    expect(await s.writer.write(create({ expectedVersion: 1 }))).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    await s.writer.write(create());
    expect(await s.writer.write(create())).toEqual({
      ok: false,
      error: { code: 'VERSION_CONFLICT', currentVersion: 1 },
    });
    const stale = await s.writer.write(
      create({ expectedVersion: 2, next: state({ status: 'INACTIVE' }) }),
    );
    expect(stale).toEqual({ ok: false, error: { code: 'VERSION_CONFLICT', currentVersion: 1 } });
    expect(s.versions.all()).toHaveLength(1);
  });

  it('lets only one of two concurrent writes with the same base version succeed', async () => {
    const s = setup();
    await s.writer.write(create());
    const results = await Promise.all([
      s.writer.write(create({ expectedVersion: 1, next: state({ status: 'INACTIVE' }) })),
      s.writer.write(create({ expectedVersion: 1, next: state({ customId: 'C-9' }) })),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.error)).toEqual([
      { code: 'VERSION_CONFLICT', currentVersion: 2 },
    ]);
    expect(s.versions.all().map((v) => v.version)).toEqual([1, 2]);
    expect(await counters(s.counters)).toMatchObject({ versions: 2 });
  });

  it('rejects a blocked id or Custom_Id and writes nothing (Req 4.9)', async () => {
    const s = setup();
    s.blocklist.add(ID);
    expect(await s.writer.write(create())).toEqual({
      ok: false,
      error: { code: 'DELETION_BLOCKED' },
    });
    s.blocklist.remove(ID);
    s.blocklist.add(customIdBlocklistKey('agy-1', 'C-1'));
    expect(await s.writer.write(create())).toEqual({
      ok: false,
      error: { code: 'DELETION_BLOCKED' },
    });
    expect(s.listings.all()).toEqual([]);
    expect(s.versions.all()).toEqual([]);
    expect(s.keys.entries()).toEqual([]);
    expect(s.counters.entries()).toEqual([]);
  });

  it('rejects a Custom_Id of another listing of the agency (Req 4.12)', async () => {
    const s = setup();
    await s.writer.write(create());
    expect(await s.writer.write(create({ listingId: 'lst-2' }))).toEqual({
      ok: false,
      error: { code: 'CUSTOM_ID_TAKEN' },
    });
    expect(await s.listings.get('lst-2')).toBeNull();
    // The same Custom_Id in another agency is free.
    const other = await s.writer.write(
      create({ listingId: 'lst-2', next: state({ agencyId: 'agy-2' }) }),
    );
    expect(other.ok).toBe(true);
  });
});

describe('DynamoDB operations of the writer path', () => {
  it('builds a ConditionCheck on the blocklist key', () => {
    const op = new DynamoDbDeletionBlocklistCheck({ tableName: 'Blocklist' }).notBlockedOp(
      customIdBlocklistKey('agy-1', 'C-1'),
    );
    expect(op).toEqual({
      label: 'deletionBlocklist.check',
      item: {
        ConditionCheck: {
          TableName: 'Blocklist',
          Key: { listingId: 'custom#agy-1#C-1' },
          ConditionExpression: 'attribute_not_exists(#key)',
          ExpressionAttributeNames: { '#key': 'listingId' },
        },
      },
    });
  });

  it('builds a version-conditioned provenance update', () => {
    const store = new DynamoDbManagedListingStore({
      client: {} as DynamoDBDocumentClient,
      tableName: 'Listings',
    });
    const op = store.touchProvenanceOp(ID, 3, {
      lastImportedAt: '2026-03-01T10:00:00.000Z',
      lastRunId: 'run-7',
    });
    expect(op.label).toBe('listing.touch');
    expect(op.item.Update).toMatchObject({
      TableName: 'Listings',
      Key: { id: ID },
      ConditionExpression: '#version = :expectedVersion',
      ExpressionAttributeValues: {
        ':lastImportedAt': '2026-03-01T10:00:00.000Z',
        ':lastRunId': 'run-7',
        ':expectedVersion': 3,
      },
    });
  });
});
