// Feature: duplicate-detection, Property 19: Isolation
import { agencyScope, ListingQueryService, VersionService } from '@open-estate/core';
import {
  createDuplicateRoutes,
  createListingRoutes,
  createRouter,
  replyStatus,
} from '@open-estate/management';
import type { Principal } from '@open-estate/shared';
import fc from 'fast-check';
import {
  AGENCY_IDS,
  applyOperation,
  arbContentPool,
  arbOperation,
  duplicatePlatform,
  machine,
  member,
  ORIGIN,
} from '../../core/test/duplicates/support/duplicate-harness';

/**
 * For any stock of several agencies and any actor of one agency, no response of the
 * Management_API (listing, list, version, Markierung) contains the id of a listing of another
 * Prüfbereich; and every call of `/platform/duplicate-reports*` by an actor without
 * `duplicate:review` (agency roles, every machine access) is rejected with 403 without returning
 * or changing data.
 *
 * **Validates: Requirements 7.6, 11.4**
 */

function routerOf(platform: ReturnType<typeof duplicatePlatform>) {
  return createRouter([
    ...createListingRoutes({
      queries: new ListingQueryService({
        listings: platform.listings,
        keys: platform.keys,
        audit: platform.audit,
        frontendOrigin: ORIGIN,
      }),
      versions: new VersionService({
        listings: platform.listings,
        versions: platform.versions,
        snapshots: platform.snapshots,
        audit: platform.audit,
      }),
      commands: async () => platform.commands,
    }),
    ...createDuplicateRoutes({ service: () => platform.reportService }),
  ]);
}

describe('Property 19: Isolation', () => {
  it('shows agency actors only listing ids of their own Prüfbereich', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbContentPool,
        fc.array(arbOperation, { minLength: 2, maxLength: 12 }),
        fc.boolean(),
        fc.nat(),
        async (pool, operations, sweep, contentPick) => {
          const platform = duplicatePlatform();
          for (const operation of operations) await applyOperation(platform, pool, operation);
          if (sweep) await platform.sweep();
          const router = routerOf(platform);
          const call = async (
            principal: Principal,
            method: string,
            path: string,
            options: { query?: Record<string, string>; body?: unknown } = {},
          ) => {
            const found = router.match(method, path);
            if (found === undefined) throw new Error(`no route ${method} ${path}`);
            const reply = await found.route.run(
              {
                params: found.params,
                query: options.query ?? {},
                body: options.body === undefined ? '' : JSON.stringify(options.body),
                signal: new AbortController().signal,
              },
              principal,
            );
            return {
              status: replyStatus(reply),
              text: JSON.stringify(reply.kind === 'success' ? reply.body : reply.errors),
              body: reply.kind === 'success' ? reply.body : undefined,
            };
          };

          for (const agencyId of AGENCY_IDS) {
            const stock = await platform.all();
            const own = stock.filter((l) => l.management.agencyId === agencyId);
            const foreign = stock
              .filter((l) => agencyScope(l.management.agencyId) !== agencyScope(agencyId))
              .map((l) => l.listing.id);
            const expectClean = (text: string) => {
              for (const id of foreign) expect(text).not.toContain(id);
            };
            for (const principal of [member(agencyId), machine(agencyId)]) {
              // The list, every listing, its history and every version of it.
              const list = await call(principal, 'GET', '/listings', {
                query: { pageSize: '50' },
              });
              expect(list.status).toBe(200);
              expectClean(list.text);
              for (const listing of own) {
                const id = listing.listing.id;
                expectClean((await call(principal, 'GET', `/listings/${id}`)).text);
                const versions = await call(principal, 'GET', `/listings/${id}/versions`, {
                  query: { pageSize: '50' },
                });
                expectClean(versions.text);
                for (let n = 1; n <= listing.management.version; n += 1) {
                  expectClean((await call(principal, 'GET', `/listings/${id}/versions/${n}`)).text);
                }
              }
              // A creation answers with the Markierung of its own Prüfbereich only.
              const created = await call(principal, 'POST', '/listings', {
                body: { content: pool[contentPick % pool.length] },
              });
              expectClean(created.text);

              // The Treffer across agencies are for Plattform_Admins only (Req 11.4).
              const reports = platform.reports.all();
              const before = JSON.stringify(reports);
              const listed = await call(principal, 'GET', '/platform/duplicate-reports');
              expect(listed.status).toBe(403);
              expect(listed.body).toBeUndefined();
              for (const report of reports) {
                const dismissed = await call(
                  principal,
                  'POST',
                  `/platform/duplicate-reports/${report.reportId}/dismiss`,
                );
                expect(dismissed.status).toBe(403);
                expect(dismissed.text).not.toContain(report.reportId);
              }
              expect(JSON.stringify(platform.reports.all())).toBe(before);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
