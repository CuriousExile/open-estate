// Feature: duplicate-detection, Property 15: Nebenläufige Exakt_Duplikate
import { duplicateFlagOf } from '@open-estate/shared';
import fc from 'fast-check';
import { arbRealisticInput } from '../../../shared/test/arbitraries/duplicates';
import { duplicatePlatform, member, profileOfStored } from './support/duplicate-harness';

/**
 * For any set of concurrent creations of Exakt_Duplikaten in one Prüfbereich — with the GSI of
 * the Duplikat_Index lagging (no creation sees another through the candidate search) and any
 * interleaving of the store calls (fast-check scheduler) — at most one of the new listings is
 * stored without a Duplikat_Markierung, and every flagged one names a listing with the same
 * exact key as its Original. The strongly consistent exact key decides the race.
 *
 * **Validates: Requirements 9.1**
 */

const INDEX_READS = ['candidates', 'getProfiles', 'exactOwner', 'getProfile'] as const;

describe('Property 15: Nebenläufige Exakt_Duplikate', () => {
  it('keeps at most one of concurrent Exakt_Duplikaten unflagged', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        arbRealisticInput(),
        fc.integer({ min: 2, max: 4 }),
        async (scheduler, input, count) => {
          const platform = duplicatePlatform({ lagging: true });
          const index = platform.index as unknown as Record<
            string,
            (...args: never[]) => Promise<unknown>
          >;
          for (const method of INDEX_READS) {
            const original = index[method]?.bind(platform.index);
            if (original !== undefined) index[method] = scheduler.scheduleFunction(original);
          }
          const { sourceUrl: _ignored, ...content } = input;
          void _ignored;

          // `waitFor` keeps releasing scheduled store calls until every creation settled, in
          // an order the scheduler chooses (an arbitrary interleaving of the creations).
          const created = await scheduler.waitFor(
            Promise.all(
              Array.from({ length: count }, () =>
                platform.commands.create(member('agy-a'), { content, status: 'ACTIVE' }),
              ),
            ),
          );

          expect(created.every((r) => r.ok)).toBe(true);
          const all = await platform.all();
          expect(all).toHaveLength(count);
          const unflagged = all.filter(
            (l) => duplicateFlagOf(l.management.flags ?? []) === undefined,
          );
          expect(unflagged.length).toBeLessThanOrEqual(1);
          for (const listing of all) {
            const flag = duplicateFlagOf(listing.management.flags ?? []);
            if (flag === undefined) continue;
            const original = all.find((l) => l.listing.id === flag.originalId);
            expect(original).toBeDefined();
            if (original === undefined) continue;
            expect(profileOfStored(platform, original).exactKey).toBe(
              profileOfStored(platform, listing).exactKey,
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
