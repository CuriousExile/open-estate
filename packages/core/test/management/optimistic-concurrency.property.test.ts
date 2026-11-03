// Feature: listing-management, Property 9: Optimistische Nebenläufigkeit
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
  type InMemoryOp,
  type Transactor,
} from '@open-estate/core';
import {
  assertValidTaxonomy,
  DEFAULT_TAXONOMY_CONFIG,
  LISTING_STATUSES,
  type ApiError,
  type ListingContent,
  type ListingStatus,
  type ListingView,
  type Principal,
  type Result,
} from '@open-estate/shared';
import fc from 'fast-check';
import {
  arbCustomId,
  arbListingContent,
  arbPlatformAdminPrincipal,
  exampleListing,
  toContent,
} from '../../../shared/test/arbitraries';

/**
 * Property 9: for any listing with current version v and any edit, status change with base
 * version, agency assignment or restore with base version b: b = v ⇒ the new current version is
 * v + 1 (for a change of state); b ≠ v ⇒ 409 with `currentVersion = v` and the listing unchanged;
 * of two concurrent writes with the same base version at most one succeeds.
 *
 * All commands run through `ListingCommandService` on the in-memory stores; concurrency is
 * exercised with `fc.scheduler`, which holds every transaction until the scheduler releases it in
 * a random order (both commands have read version v before either commits).
 *
 * **Validates: Requirements 4.6, 4.8, 8.5**
 */

const RUNS = { numRuns: 100 };
const ORIGIN = 'https://estate.example';
const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const LISTING_ID = 'lst-1';
const AGENCY_IDS = ['agy-a', 'agy-b'] as const;
const TAXONOMY = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);

/** A command with a base version; `restore.pick` selects one of the existing versions 1..v. */
type Command =
  | { kind: 'update'; content: ListingContent; customId?: string | null }
  | { kind: 'status'; status: ListingStatus }
  | { kind: 'assign'; agencyId: string }
  | { kind: 'restore'; pick: number };

const arbCommand: fc.Arbitrary<Command> = fc.oneof(
  fc.record(
    {
      kind: fc.constant('update' as const),
      content: arbListingContent(),
      customId: fc.oneof(arbCustomId, fc.constant(null)),
    },
    { requiredKeys: ['kind', 'content'] },
  ),
  fc.record({ kind: fc.constant('status' as const), status: fc.constantFrom(...LISTING_STATUSES) }),
  fc.record({ kind: fc.constant('assign' as const), agencyId: fc.constantFrom(...AGENCY_IDS) }),
  fc.record({ kind: fc.constant('restore' as const), pick: fc.nat() }),
);

/** Contents written before the command, so that the listing has a version v ≥ 1 and a history. */
const arbHistory = fc.array(arbListingContent(), { maxLength: 3 });

/** Holds every transaction until the scheduler (if set) releases it. */
class GatedTransactor implements Transactor<InMemoryOp> {
  private readonly inner = new InMemoryTransactor();
  scheduler: fc.Scheduler | undefined;

  transact(ops: readonly InMemoryOp[]) {
    if (this.scheduler === undefined) return this.inner.transact(ops);
    return this.scheduler
      .schedule(Promise.resolve(), 'transact')
      .then(() => this.inner.transact(ops));
  }
}

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
  const transactor = new GatedTransactor();
  const writer = new VersionedListingWriter({
    ...stores,
    transactor,
    clock: () => (now += 1000),
  });
  const agencies = new InMemoryAgencyStore(
    AGENCY_IDS.map((agencyId) => ({
      agencyId,
      displayName: agencyId,
      state: 'ACTIVE' as const,
      createdAt: '2025-01-01T00:00:00.000Z',
      agencyAdmins: 1,
    })),
  );
  const commands = new ListingCommandService({
    listings: stores.listings,
    versions: stores.versions,
    snapshots: stores.snapshots,
    agencies,
    writer,
    audit: new InMemoryAuditService(),
    frontendOrigin: ORIGIN,
    contentSchema: manualContentSchema(TAXONOMY),
    rules: contentRules({ tourProviders: { providers: [] } }),
    newId: () => LISTING_ID,
  });
  return { ...stores, transactor, commands };
}

type World = ReturnType<typeof setup>;

/** Creates the listing (v1) and replaces its content with each history entry. */
async function seed(w: World, admin: Principal, history: readonly ListingContent[]) {
  const created = await w.commands.create(admin, {
    content: contentToInput(toContent(exampleListing(LISTING_ID))),
    agencyId: AGENCY_IDS[0],
  });
  expect(created.ok).toBe(true);
  for (const content of history) {
    const current = await w.listings.get(LISTING_ID);
    await w.commands.replaceContent(admin, LISTING_ID, {
      content: contentToInput(content),
      baseVersion: current?.management.version,
    });
  }
  const current = await w.listings.get(LISTING_ID);
  if (current === null) throw new Error('Seeded listing is missing');
  return current.management.version;
}

function run(
  w: World,
  p: Principal,
  command: Command,
  baseVersion: number,
  currentVersion: number,
): Promise<Result<ListingView, ApiError[]>> {
  switch (command.kind) {
    case 'update':
      return w.commands.replaceContent(p, LISTING_ID, {
        content: contentToInput(command.content),
        baseVersion,
        ...(command.customId !== undefined && { customId: command.customId }),
      });
    case 'status':
      return w.commands.setStatus(p, LISTING_ID, { status: command.status, baseVersion });
    case 'assign':
      return w.commands.assignAgency(p, LISTING_ID, { agencyId: command.agencyId, baseVersion });
    case 'restore':
      return w.commands.restore(p, LISTING_ID, {
        version: (command.pick % currentVersion) + 1,
        baseVersion,
      });
  }
}

/** Commands whose target state differs from the current one by construction. */
async function changesState(w: World, command: Command): Promise<boolean> {
  const current = await w.listings.get(LISTING_ID);
  if (command.kind === 'status') return command.status !== current?.management.status;
  if (command.kind === 'assign') return command.agencyId !== current?.management.agencyId;
  return false;
}

/** Stored listing and full version history, for "unchanged" comparisons. */
async function snapshot(w: World) {
  return { listing: await w.listings.get(LISTING_ID), versions: w.versions.all() };
}

const isValidationError = (result: Result<ListingView, ApiError[]>) =>
  !result.ok && result.error.every((e) => e.code === 'INVALID_PARAMETER');

describe('Property 9: Optimistische Nebenläufigkeit', () => {
  it('advances the version only on the current base version and rejects stale ones with 409', async () => {
    let updated = 0;
    let conflicts = 0;
    await fc.assert(
      fc.asyncProperty(
        arbPlatformAdminPrincipal,
        arbHistory,
        arbCommand,
        fc.option(fc.nat({ max: 5 }), { nil: undefined, freq: 2 }),
        async (admin, history, command, stale) => {
          const w = setup();
          const v = await seed(w, admin, history);
          // undefined = current base version; otherwise one of 1..v-1, v+1..v+3.
          const others = [
            ...Array.from({ length: v - 1 }, (_, i) => i + 1),
            ...[1, 2, 3].map((d) => v + d),
          ];
          const b = stale === undefined ? v : (others[stale % others.length] as number);
          const mustChange = await changesState(w, command);
          const before = await snapshot(w);

          const result = await run(w, admin, command, b, v);

          const after = await snapshot(w);
          if (isValidationError(result)) {
            // 400 precedes the version check; nothing is written.
            expect(after).toEqual(before);
            return;
          }
          if (b !== v) {
            conflicts += 1;
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toEqual([
              expect.objectContaining({
                code: 'VERSION_CONFLICT',
                details: { currentVersion: v },
              }),
            ]);
            expect(after).toEqual(before);
            return;
          }

          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const stored = after.listing?.management.version;
          expect(result.value.version).toBe(stored);
          if (stored === v + 1) {
            updated += 1;
            expect(after.versions).toHaveLength(before.versions.length + 1);
            expect(after.versions.slice(0, before.versions.length)).toEqual(before.versions);
            expect(after.versions.at(-1)?.version).toBe(v + 1);
          } else {
            // Same state: no version, the listing stays as it was.
            expect(mustChange).toBe(false);
            expect(stored).toBe(v);
            expect(after).toEqual(before);
          }
        },
      ),
      RUNS,
    );
    // Guards against a vacuous run.
    expect(updated).toBeGreaterThan(0);
    expect(conflicts).toBeGreaterThan(0);
  });

  it('lets at most one of two concurrent writes with the same base version succeed', async () => {
    let raced = 0;
    await fc.assert(
      fc.asyncProperty(
        arbPlatformAdminPrincipal,
        arbHistory,
        arbCommand,
        arbCommand,
        fc.scheduler(),
        async (admin, history, first, second, scheduler) => {
          const w = setup();
          const v = await seed(w, admin, history);
          const before = await snapshot(w);

          w.transactor.scheduler = scheduler;
          const results = await scheduler.waitFor(
            Promise.all([run(w, admin, first, v, v), run(w, admin, second, v, v)]),
          );
          w.transactor.scheduler = undefined;

          const after = await snapshot(w);
          const stored = after.listing?.management.version;
          const winners = results.filter((r) => r.ok && r.value.version === v + 1);
          const relevant = results.filter((r) => !isValidationError(r));

          // At most one new version; the history grows by exactly that version.
          expect(winners.length).toBeLessThanOrEqual(1);
          expect(stored).toBe(v + winners.length);
          expect(after.versions).toHaveLength(before.versions.length + winners.length);
          expect(after.versions.slice(0, before.versions.length)).toEqual(before.versions);
          if (winners.length === 0) expect(after).toEqual(before);

          for (const result of results) {
            if (result.ok) {
              // Success is either the winning version or "unchanged" on v.
              expect([v, v + 1]).toContain(result.value.version);
              continue;
            }
            if (isValidationError(result)) continue;
            // The loser sees the version of the winner.
            expect(result.error).toEqual([
              expect.objectContaining({
                code: 'VERSION_CONFLICT',
                details: { currentVersion: v + 1 },
              }),
            ]);
            expect(winners).toHaveLength(1);
          }
          // Not both rejected: of two writes that pass validation, at least one is applied.
          if (relevant.length > 0) expect(relevant.some((r) => r.ok)).toBe(true);
          if (relevant.length === 2 && results.some((r) => !r.ok)) raced += 1;
          const [winner] = winners;
          if (winner?.ok) {
            expect(after.listing?.management).toMatchObject({
              status: winner.value.status,
              agencyId: winner.value.agencyId,
            });
          }
        },
      ),
      RUNS,
    );
    // Guards against a vacuous run (no actual write-write conflict).
    expect(raced).toBeGreaterThan(0);
  });
});
