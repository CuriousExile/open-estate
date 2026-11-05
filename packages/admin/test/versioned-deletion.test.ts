import {
  createOverdueDeletionCheck,
  DELETION_EXECUTED_ACTION,
  InMemoryOverdueDeletionNotifier,
  runDeletionWorkflow,
  type StoredListingKey,
} from '@open-estate/admin';
import {
  agencyScope,
  customIdBlocklistKey,
  InMemoryDeletionBlocklistCheck,
  InMemoryListingHistoryStore,
  InMemoryListingVersionStore,
  InMemoryManagedListingStore,
  InMemorySnapshotStore,
  InMemoryTransactor,
  VersionedListingWriter,
  type HistoryPurgeResult,
  type StateChange,
} from '@open-estate/core';
import {
  CONTENT_FIELDS,
  type ActorRef,
  type ListingContent,
  type VersionedState,
} from '@open-estate/shared';
import { exampleListing } from '../../shared/test/arbitraries';
import { createDeletionHarness } from './support/deletion-harness';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const ADMIN = 'user-admin-1';
const USER: ActorRef = { kind: 'user', userId: 'u1', displayName: 'Ada' };

const contentOf = (id: string, title: string): ListingContent => {
  const listing: Record<string, unknown> = { ...exampleListing(id), title };
  return Object.fromEntries(
    CONTENT_FIELDS.flatMap((field) => (field in listing ? [[field, listing[field]]] : [])),
  ) as ListingContent;
};

/** Writer and deletion workflow over one set of in-memory stores. */
function setup(options: { failingPurges?: number } = {}) {
  let now = T0;
  const clock = () => now;
  const blocklistCheck = new InMemoryDeletionBlocklistCheck();
  const backing = new Map<string, StoredListingKey>();
  const versions = new InMemoryListingVersionStore();
  const snapshots = new InMemorySnapshotStore();
  // Fails the first `failingPurges` purges, leaving versions and snapshots in place.
  let failures = options.failingPurges ?? 0;
  const history = new InMemoryListingHistoryStore({ versions, snapshots });
  const flaky = {
    usage: (id: string) => history.usage(id),
    purge: async (id: string): Promise<HistoryPurgeResult> => {
      if (failures > 0) {
        failures -= 1;
        return { complete: false };
      }
      return history.purge(id);
    },
  };
  const harness = createDeletionHarness({
    clock,
    listings: backing,
    blocklistMirror: blocklistCheck,
    versions,
    snapshots,
    history: flaky,
  });
  const managed = new InMemoryManagedListingStore();
  const writer = new VersionedListingWriter({
    listings: managed,
    versions: harness.versions,
    keys: harness.keys,
    blocklist: blocklistCheck,
    counters: harness.counters,
    snapshots: harness.snapshots,
    transactor: new InMemoryTransactor(),
    clock,
  });

  /** Writes through the writer and mirrors the key data into the deletion store's map. */
  async function write(change: Omit<StateChange, 'expectedVersion' | 'actor' | 'channel'>) {
    const current = await managed.get(change.listingId);
    const result = await writer.write({
      ...change,
      expectedVersion: current?.management.version ?? null,
      channel: 'PORTAL',
      actor: USER,
    });
    if (!result.ok) return result;
    const { listing, management } = result.value.listing;
    backing.set(listing.id, {
      id: listing.id,
      source: listing.source,
      status: management.status,
      ...(management.agencyId !== undefined && { agencyId: management.agencyId }),
      ...(management.customId !== undefined && { customId: management.customId }),
    });
    return result;
  }

  async function requestDeletion(requestId: string, listingId: string) {
    await harness.requests.create({
      requestId,
      criterion: { listingId },
      status: 'OPEN',
      requestedBy: ADMIN,
      requestedAt: new Date(now).toISOString(),
      removedCount: 0,
    });
    return runDeletionWorkflow(harness.workflow, requestId);
  }

  const counters = async (agencyId: string) => ({
    active: await harness.counters.get(agencyScope(agencyId), 'listing.status.ACTIVE'),
    inactive: await harness.counters.get(agencyScope(agencyId), 'listing.status.INACTIVE'),
    versions: await harness.counters.get(agencyScope(agencyId), 'history.version_count'),
    bytes: await harness.counters.get(agencyScope(agencyId), 'history.storage_bytes'),
  });

  return {
    ...harness,
    writer,
    write,
    requestDeletion,
    counters,
    blocklistCheck,
    backing,
    advance: (ms: number) => (now += ms),
  };
}

const state = (id: string, overrides: Partial<VersionedState> = {}): VersionedState => ({
  content: contentOf(id, `Wohnung ${id}`),
  status: 'ACTIVE',
  agencyId: 'agy-a',
  customId: `C-${id}`,
  ...overrides,
});

/** Creates L-1 (agency A → B, three contents, inactive) and an unrelated L-2 of agency A. */
async function seed(s: ReturnType<typeof setup>) {
  await s.write({ listingId: 'L-1', next: state('L-1'), changeType: 'CREATE' });
  await s.write({
    listingId: 'L-1',
    next: state('L-1', { content: contentOf('L-1', 'Renoviert') }),
    changeType: 'UPDATE',
  });
  await s.write({
    listingId: 'L-1',
    next: state('L-1', { content: contentOf('L-1', 'Renoviert'), agencyId: 'agy-b' }),
    changeType: 'UPDATE',
  });
  await s.write({
    listingId: 'L-1',
    next: state('L-1', {
      content: contentOf('L-1', 'Renoviert'),
      agencyId: 'agy-b',
      status: 'INACTIVE',
    }),
    changeType: 'STATUS',
  });
  await s.write({ listingId: 'L-2', next: state('L-2'), changeType: 'CREATE' });
}

describe('Deletion of versions, snapshots and Custom_Ids (Req 6.8, 9.2–9.5)', () => {
  it('removes listing, history, snapshots and Custom_Id key and reverses the counters', async () => {
    const s = setup();
    await seed(s);
    const l2Counters = await s.counters('agy-a'); // L-2 plus L-1's versions 1 and 2
    const l2Versions = s.versions.all().filter((v) => v.listingId === 'L-2');
    const l2Snapshots = s.snapshots.keys().filter((key) => key.startsWith('listings/L-2/'));

    const record = await s.requestDeletion('req-1', 'L-1');

    expect(record).toMatchObject({ status: 'EXECUTED', removedCount: 1 });
    expect(s.backing.has('L-1')).toBe(false);
    expect(s.versions.all().filter((v) => v.listingId === 'L-1')).toEqual([]);
    expect(s.snapshots.keys().filter((key) => key.startsWith('listings/L-1/'))).toEqual([]);
    expect(s.keys.entries()).toEqual([['agy-a#C-L-2', 'L-2']]);
    expect(await s.requests.incompleteListings('req-1')).toEqual([]);
    // Inactive listing of agency B (Req 6.8); agency A keeps exactly L-2's counters.
    expect(await s.counters('agy-b')).toEqual({ active: 0, inactive: 0, versions: 0, bytes: 0 });
    expect(await s.counters('agy-a')).toEqual({
      active: 1,
      inactive: 0,
      versions: 1,
      bytes: l2Versions[0]?.snapshotBytes,
    });
    expect(l2Counters).toMatchObject({ active: 1, versions: 3 });
    // The unaffected listing and its history are unchanged.
    expect(s.versions.all().filter((v) => v.listingId === 'L-2')).toEqual(l2Versions);
    expect(s.snapshots.keys().filter((key) => key.startsWith('listings/L-2/'))).toEqual(
      l2Snapshots,
    );
    expect(s.audit.entries.map((e) => e.action)).toContain(DELETION_EXECUTED_ACTION);
  });

  it('blocks id and Custom_Id, so neither can be used for a new listing (Req 4.9)', async () => {
    const s = setup();
    await seed(s);
    await s.requestDeletion('req-1', 'L-1');

    expect(s.blocklist.ids().sort()).toEqual(['L-1', customIdBlocklistKey('agy-b', 'C-L-1')]);
    const sameId = await s.write({ listingId: 'L-1', next: state('L-1'), changeType: 'CREATE' });
    expect(sameId).toEqual({ ok: false, error: { code: 'DELETION_BLOCKED' } });
    const sameCustomId = await s.write({
      listingId: 'L-9',
      next: state('L-9', { agencyId: 'agy-b', customId: 'C-L-1' }),
      changeType: 'CREATE',
    });
    expect(sameCustomId).toEqual({ ok: false, error: { code: 'DELETION_BLOCKED' } });
  });

  it('stays OPEN while versions remain and notifies the requester after 24 h (Req 9.5)', async () => {
    // deleteListing and the retry in finalize both fail.
    const s = setup({ failingPurges: 2 });
    await seed(s);

    const record = await s.requestDeletion('req-1', 'L-1');

    expect(record).toMatchObject({ status: 'OPEN', removedCount: 1 });
    expect(record.executedAt).toBeUndefined();
    expect(s.backing.has('L-1')).toBe(false);
    expect(s.versions.all().some((v) => v.listingId === 'L-1')).toBe(true);
    expect(await s.requests.incompleteListings('req-1')).toEqual(['L-1']);
    expect(s.audit.entries.map((e) => e.action)).not.toContain(DELETION_EXECUTED_ACTION);

    const notifier = new InMemoryOverdueDeletionNotifier();
    const check = createOverdueDeletionCheck({
      requests: s.requests,
      listings: s.listings,
      notifier,
      clock: () => T0 + DAY + 1,
    });
    await check();
    expect(notifier.sent).toEqual([
      {
        requestId: 'req-1',
        criterion: { listingId: 'L-1' },
        requestedAt: new Date(T0).toISOString(),
        remainingCount: 1,
        adminArn: ADMIN,
      },
    ]);
  });

  it('completes on a re-run once the history can be removed', async () => {
    const s = setup({ failingPurges: 2 });
    await seed(s);
    await s.requestDeletion('req-1', 'L-1');

    await expect(
      s.workflow.deleteListing({ requestId: 'req-1', listingId: 'L-1', source: 'agency:agy-b' }),
    ).resolves.toEqual({ removed: false, complete: true });
    const record = await s.workflow.finalize({ requestId: 'req-1' });

    expect(record).toMatchObject({ status: 'EXECUTED', removedCount: 1 });
    expect(s.versions.all().some((v) => v.listingId === 'L-1')).toBe(false);
    expect(await s.requests.incompleteListings('req-1')).toEqual([]);
    // Counters were reversed exactly once.
    expect(await s.counters('agy-b')).toEqual({ active: 0, inactive: 0, versions: 0, bytes: 0 });
  });

  it('finalize retries an incomplete history once before staying OPEN', async () => {
    const s = setup({ failingPurges: 1 });
    await seed(s);

    const record = await s.requestDeletion('req-1', 'L-1');

    expect(record).toMatchObject({ status: 'EXECUTED' });
    expect(s.snapshots.keys().some((key) => key.startsWith('listings/L-1/'))).toBe(false);
  });
});
