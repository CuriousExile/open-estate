// Feature: listing-management, Property 14: Versionshistorie ist lückenlos und unveränderlich
import {
  contentRules,
  contentToInput,
  InMemoryAgencyStore,
  InMemoryAuditService,
  InMemoryDeletionBlocklistCheck,
  InMemoryListingKeyStore,
  InMemoryListingVersionStore,
  InMemoryManagedListingStore,
  InMemoryMetricCounterStore,
  InMemorySnapshotStore,
  InMemoryTransactor,
  ListingCommandService,
  manualContentSchema,
  VersionedListingWriter,
  VersionService,
  type ListingVersionRecord,
  type ManagedListing,
} from '@open-estate/core';
import {
  assertValidTaxonomy,
  DEFAULT_TAXONOMY_CONFIG,
  ListingContent as ListingContentSchema,
  mergeImport,
  type ActorRef,
  type ApiError,
  type ChangeType,
  type Channel,
  type ListingContent,
  type Principal,
  type Result,
} from '@open-estate/shared';
import fc from 'fast-check';
import {
  arbOperations,
  arbPlatformAdminPrincipal,
  exampleListing,
  SimulatedClock,
  toContent,
  type ManagementOperation,
} from '../../../shared/test/arbitraries';

/**
 * Property 14: for any sequence of changes over any channel the version history of a listing is
 * 1..n without gaps; every version holds the state right after its change with actor, channel,
 * change type and timestamp with offset; the state of version n equals the current listing; every
 * version present before an operation is byte-identical afterwards; the paginated query returns
 * every version exactly once, newest first.
 *
 * PORTAL/API/ADMIN changes run through `ListingCommandService`, imports through the writer.
 *
 * **Validates: Requirements 7.1, 7.4, 7.5, 7.9, 9.1, 10.5**
 */

const RUNS = { numRuns: 100 };
const ORIGIN = 'https://estate.example';
const AGENCY_IDS = ['agy-a', 'agy-b'] as const;
const LISTING_IDS = ['lst-1', 'lst-2'] as const;
const TAXONOMY = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

type Op = Exclude<ManagementOperation, { kind: 'delete' }>;

const CHANGE_TYPE: Record<Op['kind'], ChangeType> = {
  create: 'CREATE',
  update: 'UPDATE',
  status: 'STATUS',
  assignAgency: 'UPDATE',
  restore: 'RESTORE',
  import: 'IMPORT',
};

/** Test-local reference of the channel rule (Req 10.5). */
function expectedChannel(p: Principal): Channel {
  if (p.kind === 'machine') return 'API';
  return 'role' in p && p.role === 'PLATFORM_ADMIN' ? 'ADMIN' : 'PORTAL';
}

function expectedActor(p: Principal): ActorRef {
  return p.kind === 'user'
    ? { kind: 'user', userId: p.userId, displayName: p.displayName }
    : { kind: 'machine', keyId: p.keyId, label: p.label };
}

function setup(startMs: number) {
  const clock = new SimulatedClock(startMs);
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
    clock: () => clock.now(),
  });
  const audit = new InMemoryAuditService();
  const agencies = new InMemoryAgencyStore(
    AGENCY_IDS.map((agencyId) => ({
      agencyId,
      displayName: agencyId,
      state: 'ACTIVE' as const,
      createdAt: '2025-01-01T00:00:00.000Z',
      agencyAdmins: 1,
    })),
  );
  let nextId = '';
  const commands = new ListingCommandService({
    listings: stores.listings,
    versions: stores.versions,
    snapshots: stores.snapshots,
    agencies,
    writer,
    audit,
    frontendOrigin: ORIGIN,
    contentSchema: manualContentSchema(TAXONOMY),
    rules: contentRules({ tourProviders: { providers: [] } }),
    newId: () => nextId,
  });
  const history = new VersionService({
    listings: stores.listings,
    versions: stores.versions,
    snapshots: stores.snapshots,
    audit,
  });
  return {
    ...stores,
    clock,
    writer,
    commands,
    history,
    setNextId: (id: string) => (nextId = id),
  };
}

type World = ReturnType<typeof setup>;

/** Applies one operation; returns the expected version metadata if it may create a version. */
async function apply(
  w: World,
  op: Op,
  index: number,
): Promise<{ listingId: string; channel: Channel; actor: ActorRef } | null> {
  if (op.kind === 'import') return applyImport(w, op, index);
  const current = await w.listings.get(op.listingId);
  const baseVersion = current?.management.version ?? 1;
  let result: Result<unknown, ApiError[]>;
  switch (op.kind) {
    case 'create':
      w.setNextId(op.listingId);
      result = await w.commands.create(op.principal, {
        content: contentToInput(op.content),
        ...(op.status !== undefined && { status: op.status }),
        ...(op.customId !== undefined && { customId: op.customId }),
        ...(op.agencyId !== undefined && { agencyId: op.agencyId }),
      });
      break;
    case 'update':
      result = await w.commands.replaceContent(op.principal, op.listingId, {
        content: contentToInput(op.content),
        baseVersion,
        ...(op.customId !== undefined && { customId: op.customId }),
      });
      break;
    case 'status':
      result = await w.commands.setStatus(op.principal, op.listingId, { status: op.status });
      break;
    case 'assignAgency':
      result = await w.commands.assignAgency(op.principal, op.listingId, {
        agencyId: op.agencyId,
        baseVersion,
      });
      break;
    case 'restore':
      result = await w.commands.restore(op.principal, op.listingId, {
        version: op.version,
        baseVersion,
      });
      break;
  }
  if (!result.ok) return null;
  return {
    listingId: op.listingId,
    channel: expectedChannel(op.principal),
    actor: expectedActor(op.principal),
  };
}

/** Merged import content validated like the pipeline does (Req 12.9); `null` = rejected. */
function validated(merged: ReturnType<typeof mergeImport>): ListingContent | null {
  try {
    const parsed = ListingContentSchema.safeParse(contentToInput(merged as ListingContent));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // required fields such as `offers` missing
  }
}

/** Import: merge as the pipeline does, validate, then write directly (connector actor). */
async function applyImport(w: World, op: Extract<Op, { kind: 'import' }>, index: number) {
  const listingId = op.record.id ?? `lst-import-${index}`;
  const current = await w.listings.get(listingId);
  const base = current === null ? toContent(exampleListing(listingId)) : toContent(current.listing);
  const content = validated(mergeImport(base, op.record, op.mode));
  if (content === null) return null;
  const agencyId = current?.management.agencyId ?? op.agencyId;
  const customId = op.record.customId ?? current?.management.customId;
  const actor: ActorRef = { kind: 'connector', connectorId: op.connectorId, runId: op.runId };
  const result = await w.writer.write({
    listingId,
    expectedVersion: current?.management.version ?? null,
    next: {
      content,
      status: op.record.status ?? current?.management.status ?? 'INACTIVE',
      ...(customId !== undefined && { customId }),
      ...(agencyId !== undefined && { agencyId }),
    },
    changeType: 'IMPORT',
    channel: 'IMPORT',
    actor,
  });
  return result.ok ? { listingId, channel: 'IMPORT' as const, actor } : null;
}

/** Serialized records and snapshot contents of every version (for byte equality). */
async function serializedHistory(w: World): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const record of w.versions.all()) {
    const content = await w.snapshots.get(record.listingId, record.contentHash);
    out.set(`${record.listingId}#${record.version}`, JSON.stringify({ record, content }));
  }
  return out;
}

const versionsOf = (w: World, listingId: string): ListingVersionRecord[] =>
  w.versions
    .all()
    .filter((r) => r.listingId === listingId)
    .sort((a, b) => a.version - b.version);

/** Version n of the listing holds exactly its current state. */
async function expectMatchesCurrent(
  w: World,
  record: ListingVersionRecord,
  stored: ManagedListing,
) {
  const { management, listing } = stored;
  expect(record.version).toBe(management.version);
  expect(record.status).toBe(management.status);
  expect(record.customId).toBe(management.customId);
  expect(record.agencyId).toBe(management.agencyId);
  expect(record.contentHash).toBe(management.contentHash);
  const snapshot = await w.snapshots.get(record.listingId, record.contentHash);
  expect(snapshot).toEqual(toContent(listing));
}

describe('Property 14: Versionshistorie ist lückenlos und unveränderlich', () => {
  it('keeps a gapless, immutable, fully attributed and completely paginated history', async () => {
    let versionsWritten = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.integer({
          min: Date.parse('2020-01-01T00:00:00.000Z'),
          max: Date.parse('2030-01-01T00:00:00.000Z'),
        }),
        // Seed creations by a Plattform_Admin, so that later operations hit existing listings.
        arbOperations({ listingIds: LISTING_IDS, kinds: ['create'], minLength: 0, maxLength: 2 }),
        arbOperations({
          agencyIds: AGENCY_IDS,
          listingIds: LISTING_IDS,
          kinds: ['create', 'update', 'status', 'assignAgency', 'restore', 'import'],
          maxVersion: 4,
          minLength: 1,
          maxLength: 20,
        }),
        arbPlatformAdminPrincipal,
        fc.integer({ min: 1, max: 4 }),
        async (startMs, seeds, generated, reader, pageSize) => {
          const w = setup(startMs);
          const touched = new Set<string>();
          const operations = [
            ...(seeds as Extract<Op, { kind: 'create' }>[]).map((seed) => ({
              ...seed,
              principal: reader,
              agencyId: AGENCY_IDS[0],
            })),
            ...generated,
          ];

          for (const [index, operation] of (operations as Op[]).entries()) {
            w.clock.advance(operation.advanceMs);
            const before = await serializedHistory(w);

            const applied = await apply(w, operation, index);

            // Every version present before the operation is byte-identical afterwards (Req 7.9, 9.1).
            const after = await serializedHistory(w);
            for (const [key, serialized] of before) expect(after.get(key)).toBe(serialized);
            const added = [...after.keys()].filter((key) => !before.has(key));
            expect(added.length).toBeLessThanOrEqual(1);
            if (applied === null) {
              expect(added).toEqual([]);
              continue;
            }
            touched.add(applied.listingId);
            if (added.length === 0) continue; // unchanged state: no version

            versionsWritten += 1;
            const stored = await w.listings.get(applied.listingId);
            const record = versionsOf(w, applied.listingId).at(-1);
            expect(stored).not.toBeNull();
            expect(record).toBeDefined();
            if (stored === null || record === undefined) return;
            expect(added).toEqual([`${applied.listingId}#${record.version}`]);
            // State right after the change, with actor, channel, change type, time (Req 7.1, 10.5).
            await expectMatchesCurrent(w, record, stored);
            expect(record.channel).toBe(applied.channel);
            expect(record.actor).toEqual(applied.actor);
            expect(record.changeType).toBe(CHANGE_TYPE[operation.kind]);
            expect(record.createdAt).toMatch(ISO_WITH_OFFSET);
            expect(Date.parse(record.createdAt)).toBe(w.clock.now());
          }

          for (const listingId of touched) {
            const stored = await w.listings.get(listingId);
            if (stored === null) continue;
            const n = stored.management.version;
            // Gapless 1..n (Req 7.4); version n equals the current listing (Req 7.1).
            const records = versionsOf(w, listingId);
            expect(records.map((r) => r.version)).toEqual(
              Array.from({ length: n }, (_, i) => i + 1),
            );
            const latest = records.at(-1);
            if (latest !== undefined) await expectMatchesCurrent(w, latest, stored);

            // Paginated query: every version exactly once, newest first (Req 7.5).
            const actor = { principal: reader, channel: 'ADMIN' as const };
            const listed: number[] = [];
            let cursor: string | undefined;
            for (let page = 0; page <= n; page += 1) {
              const result = await w.history.list(actor, listingId, {
                limit: pageSize,
                ...(cursor !== undefined && { cursor }),
              });
              expect(result.ok).toBe(true);
              if (!result.ok) return;
              expect(result.value.items.length).toBeLessThanOrEqual(pageSize);
              for (const entry of result.value.items) {
                const record = records[entry.version - 1];
                expect(entry).toMatchObject({
                  channel: record?.channel,
                  actor: record?.actor,
                  changeType: record?.changeType,
                  createdAt: record?.createdAt,
                });
              }
              listed.push(...result.value.items.map((entry) => entry.version));
              cursor = result.value.nextCursor;
              if (cursor === undefined) break;
            }
            expect(cursor).toBeUndefined();
            expect(listed).toEqual(Array.from({ length: n }, (_, i) => n - i));

            const detail = await w.history.get(actor, listingId, n);
            expect(detail.ok && detail.value.content).toEqual(contentToInput(stored.listing));
          }
        },
      ),
      RUNS,
    );
    // Guards against a vacuous run (all operations rejected).
    expect(versionsWritten).toBeGreaterThan(0);
  });
});
