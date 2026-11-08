// Feature: duplicate-detection, Property 10: Index-Konsistenz
import { creationTime } from '@open-estate/core';
import fc from 'fast-check';
import {
  applyOperation,
  arbContentPool,
  arbOperation,
  duplicatePlatform,
  expectedIndex,
  type DuplicatePlatform,
} from './support/duplicate-harness';

/**
 * For any sequence of creations, edits, restores, agency assignments, status changes, releases
 * and dismissals through the writer, the Duplikat_Index equals a recomputation from the stock
 * after every step: exactly one profile per listing with `buildProfile(content)`, its Prüfbereich,
 * version and Anlagezeitpunkt; exactly the block items `blockKeys(profile)`; and every exact key
 * belongs to a listing of that Prüfbereich with that key, which records the claim.
 *
 * Imports and deletions join this property with their tasks (6.1, 8.1).
 *
 * **Validates: Requirements 5.1, 6.1, 10.4**
 */

async function expectIndexMatchesStock(platform: DuplicatePlatform): Promise<void> {
  const snapshot = platform.index.snapshot();
  const expected = await expectedIndex(platform);
  const all = await platform.all();

  expect(snapshot.profiles.map((p) => p.listingId)).toEqual(expected.map((e) => e.listingId));
  for (const want of expected) {
    const stored = snapshot.profiles.find((p) => p.listingId === want.listingId);
    const listing = all.find((l) => l.listing.id === want.listingId);
    expect(stored).toMatchObject({
      scope: want.scope,
      listingVersion: want.listingVersion,
      profile: want.profile,
      blockKeys: want.blockKeys,
      createdAt: listing === undefined ? undefined : creationTime(listing),
    });
  }

  const blocks = expected
    .flatMap((e) => e.blockKeys.map((key) => `${key}|${e.listingId}|${e.scope}`))
    .sort();
  expect(snapshot.blocks.map((b) => `${b.key}|${b.listingId}|${b.scope}`).sort()).toEqual(blocks);

  for (const { key, listingId } of snapshot.exact) {
    const owner = snapshot.profiles.find((p) => p.listingId === listingId);
    expect(owner?.exactClaimed).toBe(true);
    expect(key).toBe(`X#${owner?.scope}#${owner?.profile.exactKey}`);
  }
  for (const profile of snapshot.profiles.filter((p) => p.exactClaimed === true)) {
    expect(snapshot.exact).toContainEqual({
      key: `X#${profile.scope}#${profile.profile.exactKey}`,
      listingId: profile.listingId,
    });
  }
}

describe('Property 10: Index-Konsistenz', () => {
  it('keeps the Duplikat_Index equal to a recomputation from the stock', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbContentPool,
        fc.array(arbOperation, { minLength: 1, maxLength: 12 }),
        async (pool, operations) => {
          const platform = duplicatePlatform();
          for (const operation of operations) {
            await applyOperation(platform, pool, operation);
            await expectIndexMatchesStock(platform);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
