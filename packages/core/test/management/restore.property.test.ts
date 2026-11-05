// Feature: listing-management, Property 17: Wiederherstellung
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
  type ListingVersionRecord,
} from '@open-estate/core';
import {
  AGENCY_ROLES,
  assertValidTaxonomy,
  DEFAULT_TAXONOMY_CONFIG,
  ERROR_HTTP_STATUS,
  LISTING_STATUSES,
  type ListingContent,
  type ListingStatus,
  type Principal,
  type Taxonomy,
} from '@open-estate/shared';
import fc from 'fast-check';
import {
  arbListingContent,
  arbPermissionSet,
  arbPlatformAdminPrincipal,
  SimulatedClock,
  toContent,
} from '../../../shared/test/arbitraries';

/**
 * Property 17: for any listing with versions and any version V whose content is valid under the
 * current rules, restoring V yields a new current version whose content equals the content of V,
 * with status, Custom_Id and agency as before the restore, change type `RESTORE` referencing V,
 * and every previous version unchanged. If the content of V is invalid under the current rules,
 * the restore is rejected with 400 per field and the listing stays unchanged.
 *
 * "Current rules" are modelled by a taxonomy that may have lost listing types since the history
 * was written; all other content rules are unchanged, so V is valid iff its type is still offered.
 * Restoring the current content creates no version (design: Req 4.7 applies analogously).
 *
 * **Validates: Requirements 8.1, 8.2, 8.3, 8.4**
 */

const RUNS = { numRuns: 100 };
const ORIGIN = 'https://estate.example';
const AGENCY_IDS = ['agy-a', 'agy-b'] as const;
const CUSTOM_IDS = ['C-1', 'C-2'] as const;
const LISTING_ID = 'lst-1';
const TAXONOMY = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const TYPE_CODES = TAXONOMY.groups.flatMap((g) => g.types);

type Step =
  | { kind: 'update'; content: ListingContent; customId?: string | null }
  | { kind: 'status'; status: ListingStatus }
  | { kind: 'assignAgency'; agencyId: string };

const arbStep: fc.Arbitrary<Step> = fc.oneof(
  fc.record(
    {
      kind: fc.constant('update' as const),
      content: arbListingContent(),
      customId: fc.oneof(fc.constantFrom(...CUSTOM_IDS), fc.constant(null)),
    },
    { requiredKeys: ['kind', 'content'] },
  ),
  fc.record({ kind: fc.constant('status' as const), status: fc.constantFrom(...LISTING_STATUSES) }),
  fc.record({
    kind: fc.constant('assignAgency' as const),
    agencyId: fc.constantFrom(...AGENCY_IDS),
  }),
);

/** Who restores: any actor allowed to restore listings of the owning agency. */
const arbRestorer = fc.oneof(
  arbPlatformAdminPrincipal.map((p) => () => p as Principal),
  fc.constantFrom(...AGENCY_ROLES).map((role) => (agencyId: string): Principal => ({
    kind: 'user',
    userId: 'usr-r',
    displayName: 'Restorer',
    role,
    agencyId,
  })),
  arbPermissionSet().map((permissions) => (agencyId: string): Principal => ({
    kind: 'machine',
    keyId: 'mk-r',
    label: 'CRM',
    agencyId,
    permissions: [...new Set([...permissions, 'version:restore' as const])],
  })),
);

/** Taxonomy without the given type codes (empty groups dropped). */
function narrowed(removed: readonly string[]): Taxonomy {
  return {
    groups: TAXONOMY.groups
      .map((g) => ({ code: g.code, types: g.types.filter((t) => !removed.includes(t)) }))
      .filter((g) => g.types.length > 0),
  };
}

function setup() {
  const clock = new SimulatedClock(Date.parse('2026-03-01T10:00:00.000Z'));
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
    clock: () => clock.advance(1000),
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
  const service = (taxonomy: Taxonomy) =>
    new ListingCommandService({
      listings: stores.listings,
      versions: stores.versions,
      snapshots: stores.snapshots,
      agencies,
      writer,
      audit,
      frontendOrigin: ORIGIN,
      contentSchema: manualContentSchema(taxonomy),
      rules: contentRules({ tourProviders: { providers: [] } }),
      newId: () => LISTING_ID,
    });
  return { ...stores, service };
}

type World = ReturnType<typeof setup>;

const versionsOf = (w: World): ListingVersionRecord[] =>
  w.versions
    .all()
    .filter((r) => r.listingId === LISTING_ID)
    .sort((a, b) => a.version - b.version);

/** Serialized records and snapshot contents of every version (for byte equality). */
async function serializedHistory(w: World): Promise<string[]> {
  const out: string[] = [];
  for (const record of versionsOf(w)) {
    const content = await w.snapshots.get(record.listingId, record.contentHash);
    out.push(JSON.stringify({ record, content }));
  }
  return out;
}

async function currentVersion(w: World): Promise<number> {
  return (await w.listings.get(LISTING_ID))?.management.version ?? 0;
}

describe('Property 17: Wiederherstellung', () => {
  it('restores the content of V, keeps status, Custom_Id and agency, or rejects invalid V', async () => {
    const seen = { restored: 0, rejected: 0 };
    await fc.assert(
      fc.asyncProperty(
        arbPlatformAdminPrincipal,
        arbListingContent(),
        fc.option(fc.constantFrom(...CUSTOM_IDS), { nil: undefined }),
        fc.array(arbStep, { minLength: 0, maxLength: 6 }),
        fc.nat(),
        fc.subarray(TYPE_CODES, { maxLength: TYPE_CODES.length - 1 }),
        arbRestorer,
        async (admin, initial, customId, steps, pick, removed, restorer) => {
          const w = setup();
          const writing = w.service(TAXONOMY);

          // History written under the original rules.
          const created = await writing.create(admin, {
            content: contentToInput(initial),
            agencyId: AGENCY_IDS[0],
            ...(customId !== undefined && { customId }),
          });
          expect(created.ok).toBe(true);
          for (const step of steps) {
            const baseVersion = await currentVersion(w);
            switch (step.kind) {
              case 'update':
                await writing.replaceContent(admin, LISTING_ID, {
                  content: contentToInput(step.content),
                  baseVersion,
                  ...(step.customId !== undefined && { customId: step.customId }),
                });
                break;
              case 'status':
                await writing.setStatus(admin, LISTING_ID, { status: step.status, baseVersion });
                break;
              case 'assignAgency':
                await writing.assignAgency(admin, LISTING_ID, {
                  agencyId: step.agencyId,
                  baseVersion,
                });
                break;
            }
          }

          const before = await w.listings.get(LISTING_ID);
          expect(before).not.toBeNull();
          if (before === null) return;
          const n = before.management.version;
          const v = (pick % n) + 1;
          const recordV = versionsOf(w)[v - 1];
          expect(recordV?.version).toBe(v);
          if (recordV === undefined) return;
          const contentV = await w.snapshots.get(LISTING_ID, recordV.contentHash);
          expect(contentV).not.toBeNull();
          if (contentV === null) return;

          const historyBefore = await serializedHistory(w);
          const listingBefore = JSON.stringify(before);
          const { status, customId: customIdBefore, agencyId } = before.management;
          const principal = restorer(agencyId ?? AGENCY_IDS[0]);
          const valid = !removed.includes(contentV.listingType);

          // Restore under the current rules.
          const result = await w
            .service(narrowed(removed))
            .restore(principal, LISTING_ID, { version: v, baseVersion: n });

          const after = await w.listings.get(LISTING_ID);
          const historyAfter = await serializedHistory(w);

          if (!valid) {
            // Req 8.4: 400 per field, listing and history unchanged.
            seen.rejected += 1;
            expect(result.ok).toBe(false);
            if (result.ok) return;
            const fields = result.error.map((e) => e.field);
            expect(result.error.length).toBeGreaterThan(0);
            for (const error of result.error) {
              expect(error.code).toBe('INVALID_PARAMETER');
              expect(ERROR_HTTP_STATUS[error.code as 'INVALID_PARAMETER']).toBe(400);
              expect(error.field).toMatch(/^content\./);
            }
            expect(fields).toContain('content.listingType');
            expect(new Set(fields).size).toBe(fields.length);
            expect(JSON.stringify(after)).toBe(listingBefore);
            expect(historyAfter).toEqual(historyBefore);
            return;
          }

          seen.restored += 1;
          expect(result.ok).toBe(true);
          if (!result.ok || after === null) return;
          // Req 8.2: content of V; status, Custom_Id and agency as before the restore.
          expect(toContent(after.listing)).toEqual(contentV);
          expect(after.management.status).toBe(status);
          expect(after.management.customId).toBe(customIdBefore);
          expect(after.management.agencyId).toBe(agencyId);
          expect(result.value).toMatchObject({ status, agencyId });
          expect(result.value.customId).toBe(customIdBefore);
          // Req 8.3: every previous version unchanged.
          expect(historyAfter.slice(0, historyBefore.length)).toEqual(historyBefore);

          if (recordV.contentHash === before.management.contentHash) {
            // Same content as the current one: no new version.
            expect(after.management.version).toBe(n);
            expect(historyAfter).toEqual(historyBefore);
            return;
          }
          // Req 8.1: new current version n + 1 of type RESTORE referencing V.
          expect(after.management.version).toBe(n + 1);
          expect(result.value.version).toBe(n + 1);
          expect(historyAfter).toHaveLength(n + 1);
          const restored = versionsOf(w).at(-1);
          expect(restored).toMatchObject({
            version: n + 1,
            changeType: 'RESTORE',
            restoredFrom: v,
            contentHash: recordV.contentHash,
            status,
          });
          expect(restored?.customId).toBe(customIdBefore);
          expect(restored?.agencyId).toBe(agencyId);
          expect(after.management.contentHash).toBe(recordV.contentHash);
        },
      ),
      RUNS,
    );
    // Guards against a vacuous run: both branches are exercised.
    expect(seen.restored).toBeGreaterThan(0);
    expect(seen.rejected).toBeGreaterThan(0);
  });
});
