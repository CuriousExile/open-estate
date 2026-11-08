// Feature: duplicate-detection, Property 11: Markierung nach Schreibvorgängen
import { agencyScope } from '@open-estate/core';
import { duplicateFlagOf, MAX_FLAG_MATCHES } from '@open-estate/shared';
import fc from 'fast-check';
import {
  applyOperation,
  arbContentPool,
  arbOperation,
  duplicatePlatform,
  expectedMatches,
  expectedOriginal,
} from './support/duplicate-harness';

/**
 * For any stock of several Prüfbereiche with Verwerfungen, after a creation or a change of
 * content or agency of a listing L, L has a Duplikat_Markierung exactly when it has an older
 * Treffer in its Prüfbereich (brute-force reference over the whole stock); the Original is the
 * oldest of them; the Markierung names at most five Treffer by descending score, only listings of
 * L's Prüfbereich, with `detectedBy` `CREATE` or `UPDATE`.
 *
 * Only the written listing is checked: other listings are brought up to date by the
 * Duplikat_Abgleich (Property 17).
 *
 * **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 6.1, 6.3, 7.1, 7.2, 7.6**
 */

const CONTENT_WRITES = new Set(['create', 'edit', 'assign', 'restore']);

describe('Property 11: Markierung nach Schreibvorgängen', () => {
  it('flags the written listing exactly as the reference model says', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbContentPool,
        fc.array(arbOperation, { minLength: 1, maxLength: 12 }),
        async (pool, operations) => {
          const platform = duplicatePlatform();
          for (const operation of operations) {
            const before = new Map((await platform.all()).map((l) => [l.listing.id, l]));
            const applied = await applyOperation(platform, pool, operation);
            if (applied.listingId === undefined || !CONTENT_WRITES.has(operation.kind)) continue;
            const listing = await platform.get(applied.listingId);
            if (listing === null) throw new Error('written listing missing');
            // An edit without change writes nothing and re-checks nothing (Req 4.7).
            const previous = before.get(applied.listingId);
            if (previous?.management.version === listing.management.version) continue;

            const flag = duplicateFlagOf(listing.management.flags ?? []);
            const original = await expectedOriginal(platform, listing);
            expect(flag?.originalId ?? null).toBe(original);
            if (flag === undefined) continue;

            // Req 6.3: a Markierung set or changed by the write records how; one the write left
            // as it was (same Original, same Treffer) keeps its previous state.
            const earlier = duplicateFlagOf(previous?.management.flags ?? []);
            const unchanged =
              earlier !== undefined &&
              JSON.stringify([earlier.originalId, earlier.matches]) ===
                JSON.stringify([flag.originalId, flag.matches]);
            if (unchanged) expect(flag).toEqual(earlier);
            else expect(flag.detectedBy).toBe(operation.kind === 'create' ? 'CREATE' : 'UPDATE');
            expect(flag.matches.length).toBeLessThanOrEqual(MAX_FLAG_MATCHES);
            const scores = flag.matches.map((m) => m.score);
            expect(scores).toEqual([...scores].sort((a, b) => b - a));
            const scope = agencyScope(listing.management.agencyId);
            const reference = await expectedMatches(platform, listing);
            for (const match of flag.matches) {
              expect(reference.map((r) => r.listingId)).toContain(match.listingId);
              const other = await platform.get(match.listingId);
              expect(agencyScope(other?.management.agencyId)).toBe(scope);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
