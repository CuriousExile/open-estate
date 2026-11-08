// Feature: duplicate-detection, Property 22: Zähler der Markierungen
import { agencyScope, LISTING_COUNTER_CODES } from '@open-estate/core';
import fc from 'fast-check';
import {
  AGENCY_IDS,
  applyOperation,
  arbContentPool,
  arbOperation,
  duplicatePlatform,
  storedOriginal,
} from './support/duplicate-harness';

/**
 * For any sequence of creations, edits, agency assignments, releases, dismissals, status changes
 * and restores, `listing.duplicate_flags` (counter `listing.flags.DUPLICATE`) of every agency
 * equals the number of its listings with a Duplikat_Markierung — including when an agency
 * assignment moves a flagged listing to another agency.
 *
 * The Duplikat_Abgleich and deletions join this property with their tasks (7.2, 8.1); the
 * platform counter `duplicate.cross_agency_open` is covered with the Abgleich.
 *
 * **Validates: Requirements 14.5**
 */

describe('Property 22: Zähler der Markierungen', () => {
  it('counts exactly the flagged listings of each agency', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbContentPool,
        fc.array(arbOperation, { minLength: 1, maxLength: 12 }),
        async (pool, operations) => {
          const platform = duplicatePlatform();
          for (const operation of operations) {
            await applyOperation(platform, pool, operation);
            const all = await platform.all();
            for (const agencyId of AGENCY_IDS) {
              const flagged = all.filter(
                (l) => l.management.agencyId === agencyId && storedOriginal(l) !== null,
              ).length;
              const counted = await platform.counters.get(
                agencyScope(agencyId),
                LISTING_COUNTER_CODES.duplicateFlags,
              );
              expect(counted).toBe(flagged);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
