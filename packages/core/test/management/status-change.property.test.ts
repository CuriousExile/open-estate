// Feature: listing-management, Property 13: Statusänderung erhält Inhalt und Historie
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
  ListingQueryService,
  manualContentSchema,
  VersionedListingWriter,
  VersionService,
  type AgencyActor,
  type ListingVersionRecord,
  type ManagedListing,
} from '@open-estate/core';
import {
  assertValidTaxonomy,
  DEFAULT_TAXONOMY_CONFIG,
  LISTING_STATUSES,
  type Channel,
  type Principal,
} from '@open-estate/shared';
import fc from 'fast-check';
import {
  arbAgencyUserPrincipal,
  arbCustomId,
  arbListingContent,
  arbMachinePrincipal,
  arbPlatformAdminPrincipal,
  SimulatedClock,
  toContent,
} from '../../../shared/test/arbitraries';

/**
 * Property 13: for any listing and any sequence of status changes, Listing_Inhalt, Custom_Id,
 * agency and every previous version stay unchanged; a status change to a different status writes
 * exactly one new version with change type `STATUS` and the new status. In every status the
 * listing stays fully readable (by id, by Custom_Id, with its version history) and editable over
 * the Management_API for actors of its agency and for Plattform_Admins.
 *
 * Status changes run through `ListingCommandService.setStatus`, reads through
 * `ListingQueryService` and `VersionService` — all on the in-memory stores.
 *
 * **Validates: Requirements 6.2, 6.6**
 */

const RUNS = { numRuns: 100 };
const ORIGIN = 'https://estate.example';
const AGENCY = 'agy-a';
const OTHER_AGENCY = 'agy-b';
const LISTING_ID = 'lst-1';
const TAXONOMY = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);

/** Test-local reference of the channel rule (Req 10.5). */
function channelOf(p: Principal): Channel {
  if (p.kind === 'machine') return 'API';
  return 'role' in p && p.role === 'PLATFORM_ADMIN' ? 'ADMIN' : 'PORTAL';
}

const asActor = (principal: Principal): AgencyActor => ({
  principal,
  channel: channelOf(principal) as AgencyActor['channel'],
});

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
    [AGENCY, OTHER_AGENCY].map((agencyId) => ({
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
    audit,
    frontendOrigin: ORIGIN,
    contentSchema: manualContentSchema(TAXONOMY),
    rules: contentRules({ tourProviders: { providers: [] } }),
    newId: () => LISTING_ID,
  });
  const queries = new ListingQueryService({ ...stores, audit, frontendOrigin: ORIGIN });
  const history = new VersionService({ ...stores, audit });
  return { ...stores, clock, commands, queries, history };
}

type World = ReturnType<typeof setup>;

/** Serialized records and snapshot contents of every version (for byte equality). */
async function serializedHistory(w: World): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const record of w.versions.all()) {
    const content = await w.snapshots.get(record.listingId, record.contentHash);
    out.set(`${record.listingId}#${record.version}`, JSON.stringify({ record, content }));
  }
  return out;
}

const versionsOf = (w: World): ListingVersionRecord[] =>
  w.versions
    .all()
    .filter((r) => r.listingId === LISTING_ID)
    .sort((a, b) => a.version - b.version);

async function stored(w: World): Promise<ManagedListing> {
  const current = await w.listings.get(LISTING_ID);
  if (current === null) throw new Error('listing vanished');
  return current;
}

/** Actors allowed to change the status of a listing of AGENCY. */
const arbStatusActor: fc.Arbitrary<Principal> = fc.oneof(
  arbAgencyUserPrincipal({ agencyIds: [AGENCY] }),
  arbPlatformAdminPrincipal,
  arbMachinePrincipal({ agencyIds: [AGENCY] }).map((m) => ({
    ...m,
    permissions: [...new Set([...m.permissions, 'listing:status' as const])],
  })),
);

/** Actors allowed to read and edit a listing of AGENCY. */
const arbAgencyReader: fc.Arbitrary<Principal> = fc.oneof(
  arbAgencyUserPrincipal({ agencyIds: [AGENCY] }),
  arbPlatformAdminPrincipal,
);

const arbStep = fc.record({
  status: fc.constantFrom(...LISTING_STATUSES),
  actor: arbStatusActor,
  withBaseVersion: fc.boolean(),
  reader: arbAgencyReader,
  edit: fc.boolean(),
  advanceMs: fc.integer({ min: 0, max: 86_400_000 }),
});

/** The listing is fully readable via id, Custom_Id and version history (Req 6.6). */
async function expectReadable(w: World, reader: Principal, current: ManagedListing) {
  const actor = asActor(reader);
  const { management } = current;
  const view = await w.queries.get(actor, LISTING_ID);
  expect(view.ok).toBe(true);
  if (!view.ok) return;
  expect(view.value).toMatchObject({
    id: LISTING_ID,
    status: management.status,
    version: management.version,
    agencyId: AGENCY,
  });
  expect(view.value.content).toEqual(contentToInput(current.listing));
  expect(view.value.customId).toBe(management.customId);

  if (management.customId !== undefined) {
    const byCustomId = await w.queries.getByCustomId(actor, management.customId, AGENCY);
    expect(byCustomId.ok && byCustomId.value.id).toBe(LISTING_ID);
  }

  const n = management.version;
  const page = await w.history.list(actor, LISTING_ID, { limit: n + 1 });
  expect(page.ok).toBe(true);
  if (!page.ok) return;
  expect(page.value.items.map((entry) => entry.version)).toEqual(
    Array.from({ length: n }, (_, i) => n - i),
  );
  const latest = await w.history.get(actor, LISTING_ID, n);
  expect(latest.ok && latest.value.content).toEqual(contentToInput(current.listing));
}

describe('Property 13: Statusänderung erhält Inhalt und Historie', () => {
  it('keeps content, Custom_Id, agency and history; writes STATUS versions; stays readable and editable', async () => {
    let statusVersions = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.integer({
          min: Date.parse('2020-01-01T00:00:00.000Z'),
          max: Date.parse('2030-01-01T00:00:00.000Z'),
        }),
        arbListingContent(),
        fc.constantFrom(...LISTING_STATUSES),
        fc.option(arbCustomId, { nil: undefined }),
        arbPlatformAdminPrincipal,
        fc.array(arbStep, { minLength: 1, maxLength: 8 }),
        async (startMs, content, initialStatus, customId, creator, steps) => {
          const w = setup(startMs);
          const created = await w.commands.create(creator, {
            content: contentToInput(content),
            status: initialStatus,
            agencyId: AGENCY,
            ...(customId !== undefined && { customId }),
          });
          expect(created.ok).toBe(true);
          if (!created.ok) return;

          for (const [index, step] of steps.entries()) {
            w.clock.advance(step.advanceMs);
            const before = await stored(w);
            const historyBefore = await serializedHistory(w);

            const result = await w.commands.setStatus(step.actor, LISTING_ID, {
              status: step.status,
              ...(step.withBaseVersion && { baseVersion: before.management.version }),
            });
            expect(result.ok).toBe(true);
            if (!result.ok) return;

            const after = await stored(w);
            // Content, Custom_Id and agency stay unchanged (Req 6.2).
            expect(toContent(after.listing)).toEqual(toContent(before.listing));
            expect(after.management.contentHash).toBe(before.management.contentHash);
            expect(after.management.customId).toBe(before.management.customId);
            expect(after.management.agencyId).toBe(before.management.agencyId);
            expect(after.management.status).toBe(step.status);
            expect(result.value.status).toBe(step.status);

            // Every previous version is byte-identical afterwards.
            const historyAfter = await serializedHistory(w);
            for (const [key, serialized] of historyBefore) {
              expect(historyAfter.get(key)).toBe(serialized);
            }
            const added = [...historyAfter.keys()].filter((key) => !historyBefore.has(key));

            if (step.status === before.management.status) {
              expect(added).toEqual([]);
              expect(after.management.version).toBe(before.management.version);
            } else {
              statusVersions += 1;
              const n = before.management.version + 1;
              expect(after.management.version).toBe(n);
              expect(added).toEqual([`${LISTING_ID}#${n}`]);
              const record = versionsOf(w).at(-1);
              expect(record).toMatchObject({
                version: n,
                changeType: 'STATUS',
                status: step.status,
                contentHash: before.management.contentHash,
                channel: channelOf(step.actor),
              });
              expect(record?.customId).toBe(before.management.customId);
              expect(record?.agencyId).toBe(before.management.agencyId);
              const snapshot = await w.snapshots.get(LISTING_ID, before.management.contentHash);
              expect(snapshot).toEqual(toContent(before.listing));
            }

            // Fully readable in every status (Req 6.6).
            await expectReadable(w, step.reader, after);

            // Editable in every status: a content change is a new UPDATE version, status kept.
            if (step.edit) {
              const edited = await w.commands.replaceContent(step.reader, LISTING_ID, {
                content: {
                  ...contentToInput(after.listing),
                  title: `Bearbeitet ${index} ${after.management.version}`,
                },
                baseVersion: after.management.version,
              });
              expect(edited.ok).toBe(true);
              if (!edited.ok) return;
              const updated = await stored(w);
              expect(updated.management.status).toBe(step.status);
              expect(updated.management.customId).toBe(before.management.customId);
              expect(updated.management.agencyId).toBe(AGENCY);
              if (updated.management.version !== after.management.version) {
                expect(updated.management.version).toBe(after.management.version + 1);
                expect(versionsOf(w).at(-1)).toMatchObject({
                  changeType: 'UPDATE',
                  status: step.status,
                });
              }
              await expectReadable(w, step.reader, updated);
            }
          }
        },
      ),
      RUNS,
    );
    // Guards against a vacuous run (no status ever actually changed).
    expect(statusVersions).toBeGreaterThan(0);
  });
});
