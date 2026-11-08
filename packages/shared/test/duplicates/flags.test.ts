import {
  duplicateFlag,
  duplicateFlagOf,
  flagCodes,
  isOlder,
  ListingFlagsSchema,
  MAX_FLAG_MATCHES,
  withDuplicateFlag,
  type DuplicateMatch,
} from '../../src';

// Markierungsentscheidung (duplicate-detection Req 4.3, 4.4, 7.1, 7.2): a listing is a duplicate
// exactly when an older Treffer exists, and the oldest of them is the Original that stays online.

const at = '2026-05-01T10:00:00.000Z';
const listing = { listingId: 'new', createdAt: '2026-03-01T00:00:00.000Z' };

const match = (over: Partial<DuplicateMatch> = {}): DuplicateMatch => ({
  listingId: 'old-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  score: 0.9,
  reasons: ['SAME_ADDRESS'],
  ...over,
});

describe('duplicateFlag', () => {
  it('returns null without any Treffer', () => {
    expect(duplicateFlag(listing, [], 'CREATE', at)).toBeNull();
  });

  it('returns null when every Treffer is younger (the first listing stays unflagged)', () => {
    const younger = match({ listingId: 'young', createdAt: '2026-04-01T00:00:00.000Z' });
    expect(duplicateFlag(listing, [younger], 'SWEEP', at)).toBeNull();
  });

  it('names the oldest older Treffer as Original', () => {
    const flag = duplicateFlag(
      listing,
      [
        match({ listingId: 'b', createdAt: '2026-02-01T00:00:00.000Z', score: 0.95 }),
        match({ listingId: 'a', createdAt: '2026-01-01T00:00:00.000Z', score: 0.8 }),
        match({ listingId: 'young', createdAt: '2026-04-01T00:00:00.000Z', score: 1 }),
      ],
      'CREATE',
      at,
    );
    expect(flag?.originalId).toBe('a');
    expect(flag?.detectedBy).toBe('CREATE');
    expect(flag?.updatedAt).toBe(at);
    // Younger Treffer are not part of the Markierung; the rest is sorted by score.
    expect(flag?.matches.map((m) => m.listingId)).toEqual(['b', 'a']);
  });

  it('keeps at most five Treffer, by descending score', () => {
    const matches = Array.from({ length: 8 }, (_, index) =>
      match({ listingId: `old-${index}`, score: index / 10 }),
    );
    const flag = duplicateFlag(listing, matches, 'SWEEP', at);
    expect(flag?.matches).toHaveLength(MAX_FLAG_MATCHES);
    expect(flag?.matches.map((m) => m.score)).toEqual([0.7, 0.6, 0.5, 0.4, 0.3]);
    expect(ListingFlagsSchema.safeParse([flag]).success).toBe(true);
  });

  it('breaks an equal Anlagezeitpunkt by the smaller listing id', () => {
    // Same Anlagezeitpunkt: the smaller id counts as older ('a' < 'new' < 'z').
    expect(isOlder({ listingId: 'a', createdAt: listing.createdAt }, listing)).toBe(true);
    expect(isOlder({ listingId: 'z', createdAt: listing.createdAt }, listing)).toBe(false);
    // The relation is irreflexive, so a listing is never its own Treffer.
    expect(isOlder(listing, listing)).toBe(false);
  });
});

describe('flag lists', () => {
  it('replaces and removes the Duplikat_Markierung, keeping the list sorted and unique', () => {
    const flag = duplicateFlag(listing, [match()], 'CREATE', at);
    const flags = withDuplicateFlag([], flag);
    expect(flagCodes(flags)).toEqual(['DUPLICATE']);
    expect(duplicateFlagOf(flags)).toEqual(flag);

    const replaced = withDuplicateFlag(flags, duplicateFlag(listing, [match()], 'SWEEP', at));
    expect(replaced).toHaveLength(1);
    expect(duplicateFlagOf(replaced)?.detectedBy).toBe('SWEEP');

    expect(withDuplicateFlag(replaced, null)).toEqual([]);
    expect(flagCodes([])).toEqual([]);
  });
});
