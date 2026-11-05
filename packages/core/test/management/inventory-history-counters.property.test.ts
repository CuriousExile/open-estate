// Feature: listing-management, Property 25: Bestands- und Historienzähler entsprechen dem Bestand
import {
  agencyScope,
  counterSortKey,
  InMemoryDeletionBlocklistCheck,
  InMemoryListingKeyStore,
  InMemoryListingVersionStore,
  InMemoryManagedListingStore,
  InMemoryMetricCounterStore,
  InMemorySnapshotStore,
  InMemoryTransactor,
  LISTING_COUNTER_CODES,
  serializeSnapshot,
  VersionedListingWriter,
  type ManagedListing,
  type StateChange,
} from '@open-estate/core';
import {
  LISTING_STATUSES,
  type ActorRef,
  type Channel,
  type ListingContent,
  type ListingStatus,
  type Principal,
  type VersionedState,
} from '@open-estate/shared';
import fc from 'fast-check';
import {
  arbListingContent,
  arbOperation,
  arbRunId,
  SimulatedClock,
  type ManagementOperation,
} from '../../../shared/test/arbitraries';

/**
 * Property 25: for any sequence of creations, status, agency and content changes, restores and
 * imports, the counters `listing.status.*` per agency, `listing.changes.*` per agency, channel and
 * day, `history.version_count` and `history.storage_bytes` per agency equal the values recomputed
 * from the stored listings and versions (bytes over unique snapshots), and the platform-wide
 * values are the sum over all agencies.
 *
 * Writer semantics: history counters belong to the agency owning the listing when the version was
 * written (they do not move on reassignment); bytes are counted once per unique snapshot (content
 * hash per listing). Deletions are not covered: the writer has no deletion path yet.
 *
 * **Validates: Requirements 10.3, 13.1, 14.4, 14.5**
 */

const RUNS = { numRuns: 100 };
const AGENCIES = ['agy-a', 'agy-b', 'agy-c'] as const;
const LISTING_IDS = ['lst-1', 'lst-2', 'lst-3'] as const;

/** Import step driven directly through the writer; the connector may have no agency. */
interface ImportOp {
  kind: 'connectorImport';
  advanceMs: number;
  listingId: string;
  content: ListingContent;
  status: ListingStatus;
  agencyId?: string;
  actor: ActorRef;
}

type Op = Exclude<ManagementOperation, { kind: 'import' | 'delete' }> | ImportOp;

const arbImport: fc.Arbitrary<ImportOp> = fc.record(
  {
    kind: fc.constant('connectorImport' as const),
    advanceMs: fc.integer({ min: 0, max: 86_400_000 }),
    listingId: fc.constantFrom(...LISTING_IDS),
    content: arbListingContent(),
    status: fc.constantFrom(...LISTING_STATUSES),
    agencyId: fc.constantFrom(...AGENCIES),
    actor: fc.record({
      kind: fc.constant('connector' as const),
      connectorId: fc.constantFrom('conn-a', 'conn-b'),
      runId: arbRunId,
    }),
  },
  { requiredKeys: ['kind', 'advanceMs', 'listingId', 'content', 'status', 'actor'] },
);

const arbOp: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: arbOperation({
      agencyIds: AGENCIES,
      listingIds: LISTING_IDS,
      kinds: ['create', 'update', 'status', 'assignAgency', 'restore'],
      maxVersion: 6,
    }) as fc.Arbitrary<Op>,
  },
  { weight: 1, arbitrary: arbImport },
);

function channelAndActor(principal: Principal): { channel: Channel; actor: ActorRef } {
  if (principal.kind === 'machine') {
    return {
      channel: 'API',
      actor: { kind: 'machine', keyId: principal.keyId, label: principal.label },
    };
  }
  const actor: ActorRef = {
    kind: 'user',
    userId: principal.userId,
    displayName: principal.displayName,
  };
  return { channel: principal.role === 'PLATFORM_ADMIN' ? 'ADMIN' : 'PORTAL', actor };
}

const stateOf = ({ listing, management }: ManagedListing): VersionedState => ({
  content: listing,
  status: management.status,
  ...(management.customId !== undefined && { customId: management.customId }),
  ...(management.agencyId !== undefined && { agencyId: management.agencyId }),
});

function setup() {
  const clock = new SimulatedClock();
  const listings = new InMemoryManagedListingStore();
  const versions = new InMemoryListingVersionStore();
  const counters = new InMemoryMetricCounterStore();
  const snapshots = new InMemorySnapshotStore();
  const writer = new VersionedListingWriter({
    listings,
    versions,
    keys: new InMemoryListingKeyStore(),
    blocklist: new InMemoryDeletionBlocklistCheck(),
    counters,
    snapshots,
    transactor: new InMemoryTransactor(),
    clock: () => clock.now(),
  });
  return { clock, listings, versions, counters, snapshots, writer };
}

type Setup = ReturnType<typeof setup>;

/** Translates one operation into a writer change; `null` = no target (expected rejection). */
async function toChange(s: Setup, op: Op): Promise<StateChange | null> {
  const stored = await s.listings.get(op.listingId);
  const base = stored === null ? null : stateOf(stored);
  const expectedVersion = stored?.management.version ?? null;
  switch (op.kind) {
    case 'create': {
      const { channel, actor } = channelAndActor(op.principal);
      const agencyId =
        'agencyId' in op.principal ? op.principal.agencyId : (op.agencyId ?? AGENCIES[0]);
      return {
        listingId: op.listingId,
        expectedVersion: null,
        next: {
          content: op.content,
          status: op.status ?? 'ACTIVE',
          ...(op.customId !== undefined && { customId: op.customId }),
          agencyId,
        },
        changeType: 'CREATE',
        channel,
        actor,
      };
    }
    case 'connectorImport': {
      const agencyId = op.agencyId ?? base?.agencyId;
      return {
        listingId: op.listingId,
        expectedVersion,
        next: {
          content: op.content,
          status: op.status,
          ...(base?.customId !== undefined && { customId: base.customId }),
          ...(agencyId !== undefined && { agencyId }),
        },
        changeType: 'IMPORT',
        channel: 'IMPORT',
        actor: op.actor,
      };
    }
    default:
      break;
  }
  if (base === null) return null;
  const { channel, actor } = channelAndActor(op.principal);
  const common = { listingId: op.listingId, expectedVersion, channel, actor };
  switch (op.kind) {
    case 'update': {
      const customId = op.customId ?? base.customId;
      return {
        ...common,
        next: { ...base, content: op.content, ...(customId !== undefined && { customId }) },
        changeType: 'UPDATE',
      };
    }
    case 'status':
      return { ...common, next: { ...base, status: op.status }, changeType: 'STATUS' };
    case 'assignAgency':
      return { ...common, next: { ...base, agencyId: op.agencyId }, changeType: 'UPDATE' };
    case 'restore': {
      const target = await s.versions.get(op.listingId, op.version);
      if (target === null) return null;
      const content = await s.snapshots.get(op.listingId, target.contentHash);
      if (content === null) throw new Error(`Snapshot of ${op.listingId} v${op.version} missing`);
      return {
        ...common,
        next: { ...base, content },
        changeType: 'RESTORE',
        restoredFrom: op.version,
      };
    }
  }
}

const key = (scope: string, code: string, day?: string) => `${scope}|${counterSortKey(code, day)}`;

/** Expected non-zero counters, recomputed from listings, versions and snapshots. */
async function recompute(s: Setup): Promise<Map<string, number>> {
  const expected = new Map<string, number>();
  const add = (k: string, delta: number) => expected.set(k, (expected.get(k) ?? 0) + delta);

  for (const id of LISTING_IDS) {
    const stored = await s.listings.get(id);
    if (stored === null) continue;
    const { agencyId, status } = stored.management;
    add(key(agencyScope(agencyId), LISTING_COUNTER_CODES.status(status)), 1);
  }

  const versions = [...s.versions.all()].sort((a, b) =>
    a.listingId === b.listingId ? a.version - b.version : a.listingId < b.listingId ? -1 : 1,
  );
  const seenSnapshots = new Set<string>();
  for (const v of versions) {
    const scope = agencyScope(v.agencyId);
    add(key(scope, LISTING_COUNTER_CODES.versionCount), 1);
    add(key(scope, LISTING_COUNTER_CODES.changes(v.channel), v.createdAt.slice(0, 10)), 1);
    // Bytes of each unique snapshot, attributed to the agency of its first version.
    const snapshotId = `${v.listingId}|${v.contentHash}`;
    if (seenSnapshots.has(snapshotId)) continue;
    seenSnapshots.add(snapshotId);
    const content = await s.snapshots.get(v.listingId, v.contentHash);
    if (content === null) throw new Error(`Snapshot ${snapshotId} missing`);
    add(
      key(scope, LISTING_COUNTER_CODES.storageBytes),
      Buffer.byteLength(serializeSnapshot(content), 'utf8'),
    );
  }
  return new Map([...expected].filter(([, value]) => value !== 0));
}

/** Platform value of a counter: sum over all agency scopes. */
const platformSum = (entries: [string, number][], sk: string) =>
  entries.filter(([k]) => k.endsWith(`|${sk}`)).reduce((sum, [, v]) => sum + v, 0);

describe('Property 25: Bestands- und Historienzähler entsprechen dem Bestand', () => {
  it('counters equal the recomputation from the stored inventory and history', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(arbOp, { minLength: 1, maxLength: 25 }), async (ops) => {
        const s = setup();
        for (const op of ops) {
          s.clock.advance(op.advanceMs);
          const change = await toChange(s, op);
          if (change !== null) await s.writer.write(change);
        }

        const actual = s.counters.entries().filter(([, value]) => value !== 0);
        expect(actual.every(([k]) => k.startsWith('agency#'))).toBe(true);
        expect(new Map(actual)).toEqual(await recompute(s));

        // Platform-wide values: the sum over all agencies equals the platform-wide recomputation.
        const stored = (await Promise.all(LISTING_IDS.map((id) => s.listings.get(id)))).filter(
          (l): l is ManagedListing => l !== null,
        );
        for (const status of LISTING_STATUSES) {
          expect(platformSum(actual, counterSortKey(LISTING_COUNTER_CODES.status(status)))).toBe(
            stored.filter((l) => l.management.status === status).length,
          );
        }
        const versions = s.versions.all();
        expect(platformSum(actual, counterSortKey(LISTING_COUNTER_CODES.versionCount))).toBe(
          versions.length,
        );
        const unique = new Map(versions.map((v) => [`${v.listingId}|${v.contentHash}`, v]));
        expect(platformSum(actual, counterSortKey(LISTING_COUNTER_CODES.storageBytes))).toBe(
          [...unique.values()].reduce((sum, v) => sum + v.snapshotBytes, 0),
        );
      }),
      RUNS,
    );
  });
});
