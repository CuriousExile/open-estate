// Feature: duplicate-detection, Property 18: Agenturübergreifende Treffer
import { CROSS_AGENCY_OPEN_COUNTER, PLATFORM_SCOPE } from '@open-estate/core';
import fc from 'fast-check';
import {
  applyOperation,
  arbContentPool,
  arbOperation,
  duplicatePlatform,
  platformAdmin,
} from './support/duplicate-harness';
import { expectConverged, expectedCrossPairs, statusAndVersions } from './support/sweep-reference';

/**
 * For any stock over several Prüfbereiche and any sequence of writes, Abgleiche and Verwerfungen
 * of Treffer: after each Abgleich the Treffer in state `OPEN` are exactly the pairs of listings of
 * different Prüfbereiche that are duplicates and were never dismissed; dismissed Treffer stay
 * `DISMISSED`, `OPEN` Treffer that no longer match become `RESOLVED`, `duplicate.cross_agency_open`
 * counts the `OPEN` ones — and no listing, Markierung or status changes because of them.
 *
 * **Validates: Requirements 4.5, 11.1, 11.2, 11.5, 11.6**
 */

const pairOf = (r: { listingA: string; listingB: string }) => `${r.listingA}|${r.listingB}`;

describe('Property 18: Agenturübergreifende Treffer', () => {
  it('keeps exactly the undismissed duplicate pairs across Prüfbereiche open', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbContentPool,
        fc.array(
          fc.record({
            operations: fc.array(arbOperation, { maxLength: 6 }),
            dismiss: fc.array(fc.nat(), { maxLength: 2 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        async (pool, rounds) => {
          const platform = duplicatePlatform();
          const dismissed = new Set<string>();
          for (const round of rounds) {
            for (const operation of round.operations) {
              await applyOperation(platform, pool, operation);
            }
            const previous = new Map(platform.reports.all().map((r) => [pairOf(r), r.state]));
            const before = await statusAndVersions(platform);

            await platform.sweep();

            const reports = platform.reports.all();
            const expected = await expectedCrossPairs(platform, platform.config);
            const open = new Set(reports.filter((r) => r.state === 'OPEN').map(pairOf));
            expect(open).toEqual(new Set([...expected].filter((pair) => !dismissed.has(pair))));
            for (const report of reports) {
              const pair = pairOf(report);
              expect(report.listingA < report.listingB).toBe(true);
              if (dismissed.has(pair)) expect(report.state).toBe('DISMISSED');
              else if (!expected.has(pair)) expect(report.state).toBe('RESOLVED');
              if (previous.get(pair) === 'OPEN' && !expected.has(pair) && !dismissed.has(pair)) {
                expect(report.state).toBe('RESOLVED');
              }
            }
            // Only pairs that were found ever get a Treffer.
            for (const pair of previous.keys()) {
              expect(reports.some((r) => pairOf(r) === pair)).toBe(true);
            }
            expect(await platform.counters.get(PLATFORM_SCOPE, CROSS_AGENCY_OPEN_COUNTER)).toBe(
              open.size,
            );
            // Treffer never touch listings: status and version as before, Markierungen as the
            // in-scope reference model says (Req 11.2).
            expect(await statusAndVersions(platform)).toEqual(before);
            await expectConverged(platform, platform.config, new Map());

            // The Plattform_Admin dismisses some of the open Treffer.
            const openReports = reports.filter((r) => r.state === 'OPEN');
            for (const n of round.dismiss) {
              const report = openReports[n % Math.max(1, openReports.length)];
              if (report === undefined) continue;
              const result = await platform.reportService.dismiss(platformAdmin, report.reportId);
              expect(result.ok && result.value.state).toBe('DISMISSED');
              dismissed.add(pairOf(report));
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
