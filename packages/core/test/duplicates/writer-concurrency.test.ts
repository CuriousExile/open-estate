import {
  agencyScope,
  InMemoryMetricCounterStore,
  InMemoryTransactor,
  LISTING_COUNTER_CODES,
  setListingFlags,
  VersionedListingWriter,
  type StoredProfile,
} from '@open-estate/core';
import { duplicateFlagOf } from '@open-estate/shared';
import { duplicatePlatform, member, ORIGIN } from './support/duplicate-harness';

// Concurrency guards of the write paths (duplicate-detection Req 8.2, 10.5, 14.5): Markierungen
// and Duplikat_Index profiles change without a listing version, so writes are also conditioned
// on them.

const content = (overrides: Record<string, unknown> = {}) => ({
  originalLocale: 'de',
  title: 'Helle Altbauwohnung mit Balkon',
  description: 'Drei Zimmer, Blick in den Hof.',
  translations: [],
  offers: [{ offerType: 'SALE', price: '350000.00', currency: 'EUR' }],
  listingType: 'apartment_unit',
  rooms: 3,
  area: '85.50',
  address: { city: 'Berlin', postalCode: '10115', country: 'DE', street: 'Hauptstraße 12' },
  media: [],
  tours: [],
  ...overrides,
});

type Platform = ReturnType<typeof duplicatePlatform>;

/** A writer on the platform's stores that runs `hook` right after each profile read. */
function writerWithHook(p: Platform, hook: (listingId: string) => Promise<void>) {
  const index = Object.assign(Object.create(p.index) as typeof p.index, {
    getProfile: async (listingId: string): Promise<StoredProfile | null> => {
      const read = await p.index.getProfile(listingId);
      await hook(listingId);
      return read;
    },
  });
  return new VersionedListingWriter({
    listings: p.listings,
    versions: p.versions,
    keys: p.keys,
    blocklist: p.blocklist,
    counters: p.counters,
    snapshots: p.snapshots,
    transactor: p.transactor,
    clock: p.clock,
    duplicates: { index, detector: p.detector, frontendOrigin: ORIGIN },
  });
}

async function twoCopies(p: Platform) {
  const first = await p.commands.create(member('agy-a'), { content: content() });
  const second = await p.commands.create(member('agy-a'), { content: content() });
  if (!first.ok || !second.ok) throw new Error('create failed');
  return { first: first.value.id, second: second.value.id };
}

describe('guarded writes', () => {
  it('writes again when only the profile changed meanwhile', async () => {
    const p = duplicatePlatform();
    const { first } = await twoCopies(p);
    let races = 0;
    const writer = writerWithHook(p, async (id) => {
      if (races > 0) return;
      races += 1;
      // The Abgleich rewrites the profile (same content, new revision) in between.
      const stored = await p.index.getProfile(id);
      if (stored !== null) await p.transactor.transact(p.index.syncOps(stored, stored));
    });
    const current = await p.get(first);
    const result = await writer.write({
      listingId: first,
      expectedVersion: current?.management.version ?? 1,
      next: {
        content: { ...(current?.listing ?? {}), title: 'Helle Altbauwohnung, Balkon' } as never,
        status: 'ACTIVE',
        agencyId: 'agy-a',
      },
      changeType: 'UPDATE',
      channel: 'PORTAL',
      actor: { kind: 'user', userId: 'u', displayName: 'u' },
    });
    expect(result.ok).toBe(true);
    expect(races).toBe(1);
    expect((await p.get(first))?.listing.title).toBe('Helle Altbauwohnung, Balkon');
  });

  it('gives up with a version conflict when the profile keeps changing', async () => {
    const p = duplicatePlatform();
    const { first } = await twoCopies(p);
    const writer = writerWithHook(p, async (id) => {
      const stored = await p.index.getProfile(id);
      if (stored !== null) await p.transactor.transact(p.index.syncOps(stored, stored));
    });
    const current = await p.get(first);
    const result = await writer.write({
      listingId: first,
      expectedVersion: current?.management.version ?? 1,
      next: {
        content: { ...(current?.listing ?? {}), title: 'Andere Wohnung' } as never,
        status: 'ACTIVE',
        agencyId: 'agy-a',
      },
      changeType: 'UPDATE',
      channel: 'PORTAL',
      actor: { kind: 'user', userId: 'u', displayName: 'u' },
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'VERSION_CONFLICT', currentVersion: current?.management.version },
    });
  });

  it('does not undo a Verwerfung made between read and write; counters stay exact', async () => {
    const p = duplicatePlatform();
    const { second } = await twoCopies(p);
    let dismissed = false;
    const writer = writerWithHook(p, async (id) => {
      if (dismissed || id !== second) return;
      dismissed = true;
      const result = await p.commands.dismissFlag(member('agy-a'), second, 'DUPLICATE');
      expect(result.ok).toBe(true);
    });
    const current = await p.get(second);
    const flags = current?.management.flags ?? [];
    expect(duplicateFlagOf(flags)).toBeDefined();
    const result = await writer.write({
      listingId: second,
      expectedVersion: current?.management.version ?? 1,
      next: {
        content: { ...(current?.listing ?? {}), title: 'Helle Altbauwohnung, Balkon' } as never,
        status: 'INACTIVE',
        agencyId: 'agy-a',
      },
      changeType: 'UPDATE',
      channel: 'PORTAL',
      actor: { kind: 'user', userId: 'u', displayName: 'u' },
      // Decided before the Verwerfung: still flagged.
      flags,
    });
    expect(result.ok).toBe(false);
    expect(duplicateFlagOf((await p.get(second))?.management.flags ?? [])).toBeUndefined();
    expect(await p.counters.get(agencyScope('agy-a'), LISTING_COUNTER_CODES.duplicateFlags)).toBe(
      0,
    );
  });

  it('needs a Duplikat_Index to record Verwerfungen', async () => {
    const p = duplicatePlatform();
    const { second } = await twoCopies(p);
    const current = await p.get(second);
    await expect(
      setListingFlags(
        {
          listings: p.listings,
          counters: new InMemoryMetricCounterStore(),
          transactor: new InMemoryTransactor(),
        },
        {
          listingId: second,
          expectedVersion: current?.management.version ?? 1,
          flags: [],
          dismiss: ['x'],
        },
      ),
    ).rejects.toThrow(/Duplikat_Index/);
  });
});
