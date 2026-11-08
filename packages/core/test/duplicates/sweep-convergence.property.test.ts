// Feature: duplicate-detection, Property 17: Konvergenz des Abgleichs
import {
  addSweepCounts,
  emptySweepCounts,
  sameFlag,
  SEGMENTED_PHASES,
  type SweepPhase,
} from '@open-estate/core';
import { duplicateFlagOf } from '@open-estate/shared';
import fc from 'fast-check';
import {
  applyOperation,
  arbContentPool,
  arbOperation,
  duplicatePlatform,
} from './support/duplicate-harness';
import {
  arbDisturbance,
  arbSweepConfig,
  disturb,
  expectConverged,
  statusAndVersions,
  type RemovedFlags,
} from './support/sweep-reference';

/**
 * For any stock — with missing, stale or orphaned index entries, listings written outside the
 * writer, changed rules and orphaned Verwerfungen — after one complete Duplikat_Abgleich without
 * concurrent changes the Duplikat_Index equals the recomputation from the stock, every
 * Duplikat_Markierung equals the reference model of Property 11, no status and no version
 * changed, and no Verwerfung names a missing listing. With writes interleaved between the steps
 * of a run, the Abgleich changes neither status nor version, and the next complete run converges.
 *
 * **Validates: Requirements 10.3, 10.4, 10.5, 10.6, 12.4**
 */

describe('Property 17: Konvergenz des Abgleichs', () => {
  it('repairs index and Markierungen of any disturbed stock in one run', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbContentPool,
        fc.array(arbOperation, { minLength: 1, maxLength: 10 }),
        fc.array(arbDisturbance, { maxLength: 5 }),
        fc.option(arbSweepConfig, { nil: undefined }),
        fc.integer({ min: 1, max: 3 }),
        async (pool, operations, disturbances, config, segments) => {
          const platform = duplicatePlatform();
          for (const operation of operations) await applyOperation(platform, pool, operation);
          const removed: RemovedFlags = new Map();
          for (const d of disturbances) await disturb(platform, pool, d, removed);
          const before = await statusAndVersions(platform);
          const flagsBefore = new Map(
            (await platform.all()).map((l) => [l.listing.id, l.management.flags ?? []]),
          );

          const summary = await platform.sweep(config, segments);

          expect(summary.status).toBe('SUCCEEDED');
          expect(summary.skipped).toBe(0);
          expect(await statusAndVersions(platform)).toEqual(before);
          // A Markierung the run changed is detected by `SWEEP`; a correct one stays as it was.
          for (const listing of await platform.all()) {
            const previous = duplicateFlagOf(flagsBefore.get(listing.listing.id) ?? []) ?? null;
            const now = duplicateFlagOf(listing.management.flags ?? []) ?? null;
            if (sameFlag(previous, now)) expect(now).toEqual(previous);
            else if (now !== null) expect(now.detectedBy).toBe('SWEEP');
          }
          await expectConverged(platform, config ?? platform.config, removed);
          // Converged: a second run finds nothing to do.
          const again = await platform.sweep(config, segments);
          expect({ ...again, sweepId: '', startedAt: '', endedAt: '' }).toEqual({
            ...addSweepCounts(emptySweepCounts(), { checked: again.checked }),
            event: 'duplicate.sweep',
            status: 'SUCCEEDED',
            sweepId: '',
            startedAt: '',
            endedAt: '',
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  it('keeps what concurrent writes set and converges in the next run', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbContentPool,
        fc.array(arbOperation, { minLength: 1, maxLength: 8 }),
        fc.array(fc.tuple(fc.nat(), arbOperation), { maxLength: 6 }),
        async (pool, operations, concurrent) => {
          const platform = duplicatePlatform();
          for (const operation of operations) await applyOperation(platform, pool, operation);
          const sweep = platform.sweepFor();
          const run = { sweepId: 'concurrent', startedAt: '2026-03-01T00:00:00.000Z' };
          // The writes happen between steps; each step covers one page.
          const queue = [...concurrent].sort(([a], [b]) => a - b);
          let stepNo = 0;
          let expected = await statusAndVersions(platform);
          const runPhase = async (phase: SweepPhase, segments: number) => {
            for (let segment = 0; segment < segments; segment += 1) {
              let cursor: string | undefined;
              do {
                const result = await sweep.step(
                  run,
                  { phase, segment, segments, ...(cursor !== undefined && { cursor }) },
                  () => true,
                );
                cursor = result.cursor;
                // The step itself changed no status and no version.
                expect(await statusAndVersions(platform)).toEqual(expected);
                stepNo += 1;
                while (queue.length > 0 && (queue[0]?.[0] ?? 0) % 8 <= stepNo % 8) {
                  const next = queue.shift();
                  if (next !== undefined) await applyOperation(platform, pool, next[1]);
                  expected = await statusAndVersions(platform);
                }
              } while (cursor !== undefined);
            }
          };
          for (const phase of SEGMENTED_PHASES) await runPhase(phase, 2);
          await runPhase('RESOLVE', 1);

          await platform.sweep();
          await expectConverged(platform, platform.config, new Map());
        },
      ),
      { numRuns: 100 },
    );
  });
});
