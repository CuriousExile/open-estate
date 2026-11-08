// Feature: duplicate-detection, Property 14: Freigabe und Verwerfung
import { duplicateFlagOf } from '@open-estate/shared';
import fc from 'fast-check';
import {
  applyOperation,
  arbContentPool,
  arbOperation,
  duplicatePlatform,
  expectedMatches,
  member,
  platformAdmin,
} from './support/duplicate-harness';

/**
 * For any flagged listing and any release (status `ACTIVE`) or Verwerfung: afterwards it has no
 * Duplikat_Markierung, a Verwerfung exists for every Treffer it had at that moment, and no later
 * creation, change or Abgleich flags it or one of these Treffer again because of that pair. The
 * Verwerfung creates no version and keeps the status; dismissing without a Markierung changes
 * nothing.
 *
 * **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.6**
 */

describe('Property 14: Freigabe und Verwerfung', () => {
  it('releases or dismisses a Markierung for good, pair by pair', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbContentPool,
        fc.array(arbOperation, { minLength: 2, maxLength: 10 }),
        fc.nat(),
        fc.constantFrom('release' as const, 'dismiss' as const),
        fc.array(arbOperation, { maxLength: 8 }),
        fc.boolean(),
        async (pool, setup, pickFlagged, how, later, sweepFirst) => {
          const platform = duplicatePlatform();
          for (const operation of setup) await applyOperation(platform, pool, operation);
          if (sweepFirst) await platform.sweep();
          const flagged = (await platform.all()).filter(
            (l) => duplicateFlagOf(l.management.flags ?? []) !== undefined,
          );
          fc.pre(flagged.length > 0);
          const target = flagged[pickFlagged % flagged.length];
          if (target === undefined) return;
          const id = target.listing.id;
          const actor =
            target.management.agencyId === undefined
              ? platformAdmin
              : member(target.management.agencyId);
          const matches = (await expectedMatches(platform, target)).map((m) => m.listingId);
          const named = duplicateFlagOf(target.management.flags ?? [])?.matches ?? [];
          const partners = new Set([...matches, ...named.map((m) => m.listingId)]);

          const result =
            how === 'release'
              ? await platform.commands.setStatus(actor, id, { status: 'ACTIVE' })
              : await platform.commands.dismissFlag(actor, id, 'DUPLICATE');
          expect(result.ok).toBe(true);

          const after = await platform.get(id);
          expect(duplicateFlagOf(after?.management.flags ?? [])).toBeUndefined();
          if (how === 'dismiss') {
            // No version, same status (Req 8.2, 8.6).
            expect(after?.management.version).toBe(target.management.version);
            expect(after?.management.status).toBe(target.management.status);
          } else {
            expect(after?.management.status).toBe('ACTIVE');
          }
          const dismissed = new Set((await platform.index.getProfile(id))?.dismissed ?? []);
          for (const partner of partners) expect(dismissed.has(partner)).toBe(true);

          // Dismissing again without a Markierung changes nothing (Req 8.4).
          const unchanged = await platform.get(id);
          const again = await platform.commands.dismissFlag(actor, id, 'DUPLICATE');
          expect(again.ok).toBe(true);
          expect(await platform.get(id)).toEqual(unchanged);

          // Later writes and Abgleiche never flag the pair again (Req 8.3).
          for (const operation of later) {
            // Releasing or dismissing other listings is allowed; this listing stays released.
            await applyOperation(platform, pool, operation);
          }
          await platform.sweep();
          for (const listing of await platform.all()) {
            const flag = duplicateFlagOf(listing.management.flags ?? []);
            if (flag === undefined) continue;
            const named = new Set([flag.originalId, ...flag.matches.map((m) => m.listingId)]);
            if (listing.listing.id === id) {
              for (const partner of partners) expect(named.has(partner)).toBe(false);
            } else if (partners.has(listing.listing.id)) {
              expect(named.has(id)).toBe(false);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
