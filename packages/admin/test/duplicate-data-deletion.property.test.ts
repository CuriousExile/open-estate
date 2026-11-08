// Feature: duplicate-detection, Property 20: Löschung entfernt alle Duplikat-Daten
import {
  createDeletionWorkflow,
  InMemoryAuditLog,
  InMemoryDeletionBlocklistStore,
  InMemoryDeletionRequestStore,
  runDeletionWorkflow,
} from '@open-estate/admin';
import {
  agencyScope,
  CROSS_AGENCY_OPEN_COUNTER,
  duplicateDataPurge,
  InMemoryListingHistoryStore,
  LISTING_COUNTER_CODES,
  PLATFORM_SCOPE,
} from '@open-estate/core';
import fc from 'fast-check';
import {
  AGENCY_IDS,
  applyOperation,
  arbContentPool,
  arbOperation,
  duplicatePlatform,
  member,
  storedOriginal,
} from '../../core/test/duplicates/support/duplicate-harness';
import { ManagedDeletionListingStore } from '../../devserver/src/deletion-store';

/**
 * For any stock and deletion criterion (one listing or one data source), after an executed
 * deletion request no affected listing has a profile, a block item, an exact key or an
 * Idempotenzschlüssel record left; the request becomes `EXECUTED` only afterwards; and the
 * Duplikat-Erkennung's data of every unaffected listing is unchanged. No
 * Agenturübergreifender_Treffer naming an affected listing is left, the partner's Verweis on it
 * is gone, and `duplicate.cross_agency_open` still counts the `OPEN` Treffer.
 *
 * **Validates: Requirements 12.3**
 */

describe('Property 20: Löschung entfernt alle Duplikat-Daten', () => {
  it('removes every profile, block, exact key, Treffer and idempotency record of deleted listings', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbContentPool,
        fc.array(arbOperation, { minLength: 1, maxLength: 10 }),
        fc.array(fc.nat(), { maxLength: 3 }),
        fc.nat(),
        fc.boolean(),
        async (pool, operations, keyedCreations, victim, bySource) => {
          const platform = duplicatePlatform();
          for (const operation of operations) await applyOperation(platform, pool, operation);
          for (const [i, n] of keyedCreations.entries()) {
            await platform.commands.createWithKey(
              member('agy-a'),
              { content: pool[n % pool.length] },
              `key-${i}`,
            );
          }
          // Agenturübergreifende_Treffer come from the Duplikat_Abgleich.
          await platform.sweep();
          const ids = platform.listings
            .all()
            .map((item) => item.id)
            .sort();
          fc.pre(ids.length > 0);
          const listingId = ids[victim % ids.length] ?? '';
          const source = (await platform.get(listingId))?.listing.source ?? '';
          // By source, every listing of that data source (here: of the agency) goes.
          const affected = new Set(
            bySource
              ? platform.listings
                  .all()
                  .filter((item) => item.source === source)
                  .map((i) => i.id)
              : [listingId],
          );

          const requests = new InMemoryDeletionRequestStore();
          const workflow = createDeletionWorkflow({
            requests,
            listings: new ManagedDeletionListingStore({
              listings: platform.listings,
              requests,
              keys: platform.keys,
              counters: platform.counters,
            }),
            blocklist: new InMemoryDeletionBlocklistStore(),
            history: new InMemoryListingHistoryStore({
              versions: platform.versions,
              snapshots: platform.snapshots,
            }),
            audit: new InMemoryAuditLog(),
            duplicates: duplicateDataPurge({
              index: platform.index,
              idempotency: platform.idempotency,
              reports: platform.reports,
              counters: platform.counters,
              transactor: platform.transactor,
            }),
          });
          const before = platform.index.snapshot();
          const othersBefore = {
            profiles: before.profiles.filter((p) => !affected.has(p.listingId)),
            blocks: before.blocks.filter((b) => !affected.has(b.listingId)),
            exact: before.exact.filter((e) => !affected.has(e.listingId)),
          };
          const idempotencyOthers = platform.idempotency
            .entries()
            .filter((record) => !affected.has(record.listingId));
          const touches = (r: { listingA: string; listingB: string }) =>
            affected.has(r.listingA) || affected.has(r.listingB);
          const reportsOthers = platform.reports.all().filter((r) => !touches(r));
          const refsOthers = before.reportRefs.filter(
            (ref) =>
              !affected.has(ref.listingId) &&
              !platform.reports.all().some((r) => r.reportId === ref.reportId && touches(r)),
          );

          await requests.create({
            requestId: 'del-1',
            criterion: bySource ? { source } : { listingId },
            status: 'OPEN',
            requestedBy: 'admin',
            requestedAt: '2026-06-01T00:00:00.000Z',
            removedCount: 0,
          });
          const record = await runDeletionWorkflow(workflow, 'del-1');

          expect(record.status).toBe('EXECUTED');
          const after = platform.index.snapshot();
          expect(after.profiles.some((p) => affected.has(p.listingId))).toBe(false);
          expect(after.blocks.some((b) => affected.has(b.listingId))).toBe(false);
          expect(after.exact.some((e) => affected.has(e.listingId))).toBe(false);
          expect(platform.idempotency.entries().some((r) => affected.has(r.listingId))).toBe(false);
          expect(record.removedCount).toBe(affected.size);
          // No Treffer and no Verweis of an affected listing is left.
          expect(platform.reports.all().some(touches)).toBe(false);
          expect(after.reportRefs.some((ref) => affected.has(ref.listingId))).toBe(false);
          expect(await platform.counters.get(PLATFORM_SCOPE, CROSS_AGENCY_OPEN_COUNTER)).toBe(
            platform.reports.all().filter((r) => r.state === 'OPEN').length,
          );
          // Nothing else changed.
          expect(platform.reports.all()).toEqual(reportsOthers);
          expect(after).toEqual({ ...othersBefore, reportRefs: refsOthers });
          expect(platform.idempotency.entries()).toEqual(idempotencyOthers);
          // The flag counter follows the removal (Property 22, Req 14.5).
          const remaining = await platform.all();
          for (const agencyId of AGENCY_IDS) {
            const flagged = remaining.filter(
              (l) => l.management.agencyId === agencyId && storedOriginal(l) !== null,
            ).length;
            expect(
              await platform.counters.get(
                agencyScope(agencyId),
                LISTING_COUNTER_CODES.duplicateFlags,
              ),
            ).toBe(flagged);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
