import {
  agencyScope,
  creationTime,
  LISTING_COUNTER_CODES,
  toManagedListingItem,
  type ManagedListing,
} from '@open-estate/core';
import {
  CONTENT_FIELDS,
  DEFAULT_DUPLICATE_CONFIG,
  duplicateFlag,
  duplicateFlagOf,
  scoreMatch,
  type DuplicateConfig,
  type Listing,
} from '@open-estate/shared';
import fc from 'fast-check';
import {
  AGENCY_IDS,
  duplicatePlatform,
  expectedIndex,
  expectedMatches,
  member,
  profileOfStored,
  type DuplicatePlatform,
} from './duplicate-harness';

// Reference model of a converged Duplikat_Abgleich (Properties 17, 18) and the disturbances the
// Abgleich has to repair: listings written or removed outside the writer, lost profiles and
// changed rules.

/** Configurations the Abgleich may run with (changed rules, Req 10.6). */
export const arbSweepConfig: fc.Arbitrary<DuplicateConfig> = fc
  .record({
    threshold: fc.constantFrom(0.5, 0.7, 0.9),
    textNearHamming: fc.constantFrom(1, 3, 5),
  })
  .map((changes) => ({ ...DEFAULT_DUPLICATE_CONFIG, ...changes }));

export type Disturbance =
  | { kind: 'rawEdit'; listing: number; content: number }
  | { kind: 'rawCreate'; agency: number; content: number }
  | { kind: 'remove'; listing: number }
  /** Removes a listing another one was released against (orphaned Verwerfung). */
  | { kind: 'removeDismissed'; listing: number }
  | { kind: 'dropProfile'; listing: number };

export const arbDisturbance: fc.Arbitrary<Disturbance> = fc.oneof(
  fc.record({ kind: fc.constant('rawEdit' as const), listing: fc.nat(), content: fc.nat() }),
  fc.record({ kind: fc.constant('rawCreate' as const), agency: fc.nat(), content: fc.nat() }),
  fc.record({ kind: fc.constant('remove' as const), listing: fc.nat() }),
  fc.record({ kind: fc.constant('removeDismissed' as const), listing: fc.nat() }),
  fc.record({ kind: fc.constant('dropProfile' as const), listing: fc.nat() }),
);

/** Listing flags removed together with their listing, per agency (the counter keeps them). */
export type RemovedFlags = Map<string, number>;

/** A stored listing as the writer would have prepared `content`, from a separate platform. */
async function prepared(agencyId: string, content: Record<string, unknown>) {
  const scratch = duplicatePlatform();
  const created = await scratch.commands.create(member(agencyId), { content });
  if (!created.ok) return null;
  return scratch.get(created.value.id);
}

const contentFields = (listing: Listing): Partial<Listing> =>
  Object.fromEntries(
    CONTENT_FIELDS.flatMap((field) =>
      listing[field] === undefined ? [] : [[field, listing[field]]],
    ),
  ) as Partial<Listing>;

let rawIds = 0;

/** Applies one disturbance directly to the stores, bypassing writer and deletion workflow. */
export async function disturb(
  platform: DuplicatePlatform,
  pool: readonly Record<string, unknown>[],
  disturbance: Disturbance,
  removed: RemovedFlags,
): Promise<void> {
  const ids = platform.listings
    .all()
    .map((item) => item.id)
    .sort();
  const pickId = (n: number) => ids[n % Math.max(1, ids.length)];
  const contentOf = (n: number) => pool[n % pool.length] ?? {};
  switch (disturbance.kind) {
    case 'rawEdit': {
      const id = pickId(disturbance.listing);
      const stored = id === undefined ? null : await platform.get(id);
      if (stored === null) return;
      const donor = await prepared('agy-a', contentOf(disturbance.content));
      if (donor === null) return;
      const listing = { ...stored.listing, ...contentFields(donor.listing) } as Listing;
      platform.listings.putRaw(
        toManagedListingItem(listing, {
          ...stored.management,
          version: stored.management.version + 1,
          contentHash: donor.management.contentHash,
        }),
      );
      return;
    }
    case 'rawCreate': {
      const agencyId = AGENCY_IDS[disturbance.agency % AGENCY_IDS.length] ?? 'agy-a';
      const donor = await prepared(agencyId, contentOf(disturbance.content));
      if (donor === null) return;
      rawIds += 1;
      const id = `raw-${rawIds}`;
      const management = { ...donor.management };
      delete management.flags;
      platform.listings.putRaw(toManagedListingItem({ ...donor.listing, id }, management));
      return;
    }
    case 'remove':
    case 'removeDismissed': {
      const dismissed = platform.index
        .snapshot()
        .profiles.flatMap((p) => p.dismissed)
        .filter((id) => ids.includes(id))
        .sort();
      const id =
        disturbance.kind === 'remove'
          ? pickId(disturbance.listing)
          : dismissed[disturbance.listing % Math.max(1, dismissed.length)];
      const stored = id === undefined ? null : await platform.get(id);
      if (stored === null || id === undefined) return;
      if (duplicateFlagOf(stored.management.flags ?? []) !== undefined) {
        const agency = stored.management.agencyId ?? '';
        removed.set(agency, (removed.get(agency) ?? 0) + 1);
      }
      platform.listings.remove(id);
      return;
    }
    case 'dropProfile': {
      const id = pickId(disturbance.listing);
      const before = id === undefined ? null : await platform.index.getProfile(id);
      if (before === null) return;
      await platform.transactor.transact(platform.index.syncOps(before, null));
      return;
    }
  }
}

/** Status and version of every listing (the Abgleich changes neither, Req 10.3). */
export async function statusAndVersions(platform: DuplicatePlatform) {
  return (await platform.all()).map((l) => ({
    id: l.listing.id,
    status: l.management.status,
    version: l.management.version,
  }));
}

/**
 * Property 17's target state under `config`: the index equals the recomputation from the stock,
 * each exact key has exactly one owner among its listings, every Markierung is the reference
 * model's, no Verwerfung names a missing listing, and the flag counters match.
 */
export async function expectConverged(
  platform: DuplicatePlatform,
  config: DuplicateConfig,
  removed: RemovedFlags,
): Promise<void> {
  const all = await platform.all();
  const ids = new Set(all.map((l) => l.listing.id));
  const snapshot = platform.index.snapshot();

  // Index = recomputation (Req 10.4, 10.6).
  const expected = await expectedIndex(platform, config);
  const createdAt = new Map(all.map((l) => [l.listing.id, creationTime(l)]));
  expect(
    snapshot.profiles.map((p) => ({
      listingId: p.listingId,
      scope: p.scope,
      listingVersion: p.listingVersion,
      profile: p.profile,
      blockKeys: p.blockKeys,
    })),
  ).toEqual(expected);
  for (const p of snapshot.profiles) expect(p.createdAt).toBe(createdAt.get(p.listingId));
  const blocks = expected
    .flatMap((e) => e.blockKeys.map((key) => ({ key, listingId: e.listingId, scope: e.scope })))
    .sort((a, b) =>
      a.key === b.key ? (a.listingId < b.listingId ? -1 : 1) : a.key < b.key ? -1 : 1,
    );
  expect(snapshot.blocks).toEqual(blocks);

  // Exact keys: one owner per key and Prüfbereich, claimed by its profile (Req 9.1).
  const groups = new Map<string, string[]>();
  for (const e of expected) {
    const key = `X#${e.scope}#${e.profile.exactKey}`;
    groups.set(key, [...(groups.get(key) ?? []), e.listingId]);
  }
  expect(snapshot.exact.map((x) => x.key).sort()).toEqual([...groups.keys()].sort());
  for (const { key, listingId } of snapshot.exact) {
    expect(groups.get(key)).toContain(listingId);
  }
  const owners = new Set(snapshot.exact.map((x) => x.listingId));
  for (const p of snapshot.profiles) expect(p.exactClaimed === true).toBe(owners.has(p.listingId));

  // No Verwerfung names a missing listing (Req 12.4).
  for (const p of snapshot.profiles) for (const id of p.dismissed) expect(ids.has(id)).toBe(true);

  // Markierungen = reference model (Req 10.3).
  for (const listing of all) {
    const matches = await expectedMatches(platform, listing, config);
    const reference = duplicateFlag(
      { listingId: listing.listing.id, createdAt: creationTime(listing) },
      matches,
      'SWEEP',
      '2026-01-01T00:00:00.000Z',
    );
    const stored = duplicateFlagOf(listing.management.flags ?? []) ?? null;
    expect(stored === null).toBe(reference === null);
    if (stored !== null && reference !== null) {
      expect({ originalId: stored.originalId, matches: stored.matches }).toEqual({
        originalId: reference.originalId,
        matches: reference.matches,
      });
    }
  }

  // `listing.flags.DUPLICATE` per agency: flagged listings plus those removed outside the
  // deletion workflow (which would have decremented them).
  for (const agencyId of AGENCY_IDS) {
    const flagged = all.filter(
      (l) =>
        l.management.agencyId === agencyId &&
        duplicateFlagOf(l.management.flags ?? []) !== undefined,
    ).length;
    expect(
      await platform.counters.get(agencyScope(agencyId), LISTING_COUNTER_CODES.duplicateFlags),
    ).toBe(flagged + (removed.get(agencyId) ?? 0));
  }
}

/**
 * Pairs of listings of different Prüfbereiche that are duplicates under `config` (Property 18),
 * as report keys `a|b` with `a < b`.
 */
export async function expectedCrossPairs(
  platform: DuplicatePlatform,
  config: DuplicateConfig,
): Promise<Set<string>> {
  const all = await platform.all();
  const pairs = new Set<string>();
  const profiles = new Map<string, ReturnType<typeof profileOfStored>>(
    all.map((l) => [l.listing.id, profileOfStored(platform, l, config)]),
  );
  for (const a of all) {
    for (const b of all) {
      if (a.listing.id >= b.listing.id) continue;
      if (agencyScope(a.management.agencyId) === agencyScope(b.management.agencyId)) continue;
      const pa = profiles.get(a.listing.id);
      const pb = profiles.get(b.listing.id);
      if (pa === undefined || pb === undefined) continue;
      if (scoreMatch(pa, pb, config).duplicate) pairs.add(`${a.listing.id}|${b.listing.id}`);
    }
  }
  return pairs;
}

export type { ManagedListing };
