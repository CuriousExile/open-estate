// Feature: listing-management, Property 33: Ableitung der Provenienzfelder
import {
  InMemoryDeletionBlocklistCheck,
  InMemoryListingKeyStore,
  InMemoryListingVersionStore,
  InMemoryManagedListingStore,
  InMemoryMetricCounterStore,
  InMemorySnapshotStore,
  InMemoryTransactor,
  VersionedListingWriter,
} from '@open-estate/core';
import {
  CHANNELS,
  CONTENT_FIELDS,
  LISTING_STATUSES,
  contentHash,
  type ActorRef,
  type ChangeType,
  type Channel,
  type ListingContent,
  type ListingStatus,
  type VersionedState,
} from '@open-estate/shared';
import fc from 'fast-check';
import {
  SimulatedClock,
  arbActorRef,
  arbAgencyId,
  arbClockStart,
  arbCustomId,
  arbListingContent,
  arbListingId,
  arbVersionedState,
} from '../../../shared/test/arbitraries';

/**
 * Property 33: for any sequence of writes and import runs without change (simulated clock), after
 * every operation `lastImportedAt` is the time of the last operation that created a version or was
 * an import run; `lastRunId` is its `runId` or `{channel}#{version}`; `source` is the connector id
 * for origin `IMPORT` and `agency:{agencyId}` of the current owning agency for `MANUAL`; no part of
 * the Inhalts_Hash is one of these fields.
 *
 * **Validates: Requirements 4.16, 4.17**
 */

const RUNS = { numRuns: 100 };
const PROVENANCE_FIELDS = ['source', 'lastImportedAt', 'lastRunId'] as const;

/** Per field: keep or replace; the agency is only reassigned (MANUAL always has an owner). */
interface Mutation {
  content?: ListingContent;
  status?: ListingStatus;
  customId?: string;
  agencyId?: string;
}

const arbMutation: fc.Arbitrary<Mutation> = fc.record(
  {
    content: arbListingContent(),
    status: fc.constantFrom(...LISTING_STATUSES),
    customId: arbCustomId,
    agencyId: arbAgencyId,
  },
  { requiredKeys: [] },
);

const CHANGE_TYPE: Record<Channel, readonly ChangeType[]> = {
  PORTAL: ['UPDATE', 'STATUS'],
  API: ['UPDATE', 'STATUS'],
  ADMIN: ['UPDATE', 'STATUS'],
  IMPORT: ['IMPORT'],
};

const arbCreation = fc.constantFrom(...CHANNELS).chain((channel) =>
  fc.record({
    channel: fc.constant(channel),
    actor: arbActorRef(channel),
    initial: arbVersionedState({ agencyless: channel === 'IMPORT' }),
  }),
);

/** One operation; `identical` resubmits the current state (no version; import = run without change). */
const arbStep = fc.constantFrom(...CHANNELS).chain((channel) =>
  fc.record({
    advanceMs: fc.integer({ min: 1, max: 30 * 24 * 3600 * 1000 }),
    channel: fc.constant(channel),
    changeType: fc.constantFrom(...CHANGE_TYPE[channel]),
    actor: arbActorRef(channel),
    identical: fc.boolean(),
    mutation: arbMutation,
  }),
);

function apply(current: VersionedState, m: Mutation): VersionedState {
  const customId = m.customId ?? current.customId;
  const agencyId = m.agencyId ?? current.agencyId;
  return {
    content: m.content ?? current.content,
    status: m.status ?? current.status,
    ...(customId !== undefined && { customId }),
    ...(agencyId !== undefined && { agencyId }),
  };
}

const runIdOf = (actor: ActorRef, channel: Channel, version: number) =>
  actor.kind === 'connector' ? actor.runId : `${channel}#${version}`;

function setup(startMs: number) {
  const clock = new SimulatedClock(startMs);
  const listings = new InMemoryManagedListingStore();
  const writer = new VersionedListingWriter({
    listings,
    versions: new InMemoryListingVersionStore(),
    keys: new InMemoryListingKeyStore(),
    blocklist: new InMemoryDeletionBlocklistCheck(),
    counters: new InMemoryMetricCounterStore(),
    snapshots: new InMemorySnapshotStore(),
    transactor: new InMemoryTransactor(),
    clock: () => clock.now(),
  });
  return { clock, listings, writer };
}

describe('Property 33: Ableitung der Provenienzfelder', () => {
  it('keeps no provenance field among the content fields', () => {
    for (const field of PROVENANCE_FIELDS) {
      expect(CONTENT_FIELDS as readonly string[]).not.toContain(field);
    }
  });

  it('derives source, lastImportedAt and lastRunId of the stored listing after every operation', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbClockStart,
        arbListingId,
        arbCreation,
        fc.array(arbStep, { minLength: 1, maxLength: 8 }),
        fc.record({ source: fc.string(), lastImportedAt: fc.string(), lastRunId: fc.string() }),
        async (startMs, listingId, creation, steps, foreign) => {
          const s = setup(startMs);
          const origin = creation.channel === 'IMPORT' ? 'IMPORT' : 'MANUAL';
          const connectorSource =
            creation.actor.kind === 'connector' ? creation.actor.connectorId : undefined;

          const created = await s.writer.write({
            listingId,
            expectedVersion: null,
            next: creation.initial,
            changeType: 'CREATE',
            channel: creation.channel,
            actor: creation.actor,
          });
          expect(created.ok).toBe(true);

          let state = creation.initial;
          let version = 1;
          let lastAt = new Date(startMs).toISOString();
          let lastRunId = runIdOf(creation.actor, creation.channel, 1);

          const check = async () => {
            const stored = await s.listings.get(listingId);
            expect(stored).not.toBeNull();
            if (stored === null) return;
            const { listing, management } = stored;
            expect(management.origin).toBe(origin);
            expect(listing.lastImportedAt).toBe(lastAt);
            expect(listing.lastRunId).toBe(lastRunId);
            expect(listing.source).toBe(
              origin === 'IMPORT' ? connectorSource : `agency:${management.agencyId}`,
            );
            if (origin === 'MANUAL') expect(management.agencyId).toBe(state.agencyId);
            // The Inhalts_Hash ignores the provenance fields.
            expect(contentHash(listing as ListingContent)).toBe(management.contentHash);
            expect(contentHash({ ...listing, ...foreign } as ListingContent)).toBe(
              management.contentHash,
            );
          };
          await check();

          for (const step of steps) {
            s.clock.advance(step.advanceMs);
            const next = step.identical ? state : apply(state, step.mutation);
            const result = await s.writer.write({
              listingId,
              expectedVersion: version,
              next,
              changeType: step.changeType,
              channel: step.channel,
              actor: step.actor,
            });
            expect(result.ok).toBe(true);
            if (!result.ok) return;

            if (result.value.outcome === 'updated') {
              version += 1;
              lastAt = s.clock.nowIso();
              lastRunId = runIdOf(step.actor, step.channel, version);
            } else if (step.channel === 'IMPORT') {
              // Import run without change: refreshes lastImportedAt/lastRunId, no version.
              lastAt = s.clock.nowIso();
              lastRunId = runIdOf(step.actor, step.channel, version);
            }
            state = next;
            await check();
            expect(result.value.listing.listing).toEqual(
              (await s.listings.get(listingId))?.listing,
            );
          }
        },
      ),
      RUNS,
    );
  });
});
