// Feature: listing-management, Property 10: Keine Version ohne Änderung
import {
  InMemoryDeletionBlocklistCheck,
  InMemoryListingKeyStore,
  InMemoryListingVersionStore,
  InMemoryManagedListingStore,
  InMemoryMetricCounterStore,
  InMemorySnapshotStore,
  InMemoryTransactor,
  VersionedListingWriter,
  type StateChange,
} from '@open-estate/core';
import {
  CHANNELS,
  LISTING_STATUSES,
  type ChangeType,
  type Channel,
  type ListingContent,
  type ListingStatus,
  type VersionedState,
} from '@open-estate/shared';
import fc from 'fast-check';
import {
  arbActorRef,
  arbAgencyId,
  arbCustomId,
  arbListingContent,
  arbListingId,
  arbVersionedState,
} from '../../../shared/test/arbitraries';

/**
 * Property 10: for any listing and any edit, status change or import whose resulting state
 * (Inhalts_Hash, Listing_Status, Custom_Id, Agentur) equals the current one, the response is
 * successful and the version history is unchanged; every change of at least one of these values
 * creates exactly one version.
 *
 * **Validates: Requirements 4.7, 6.9, 7.1, 7.3**
 */

const RUNS = { numRuns: 100 };
const T0 = Date.parse('2026-03-01T10:00:00.000Z');

/**
 * Per field: keep the current value or replace it. The Custom_Id may also be removed; the agency
 * is only reassigned, since a MANUAL listing always has an owning agency.
 */
interface Mutation {
  content?: ListingContent;
  status?: ListingStatus;
  customId?: { value: string | undefined };
  agencyId?: string;
}

const optional = <T>(arb: fc.Arbitrary<T>) =>
  fc.option(arb, { nil: undefined, freq: 2 }).map((value) => ({ value }));

const arbMutation: fc.Arbitrary<Mutation> = fc.record(
  {
    content: arbListingContent(),
    status: fc.constantFrom(...LISTING_STATUSES),
    customId: optional(arbCustomId),
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

/** Creation channel and state; only imported listings may lack an owning agency. */
const arbCreation = fc.constantFrom(...CHANNELS).chain((channel) =>
  fc.record({
    channel: fc.constant(channel),
    actor: arbActorRef(channel),
    initial: arbVersionedState({ agencyless: channel === 'IMPORT' }),
  }),
);

const arbStep = fc.record({
  mutation: arbMutation,
  channel: fc.constantFrom(...CHANNELS),
});

/** Deep copy with reversed key order: same content, different representation. */
function reorder<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reorder) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reorder(child)]),
    ) as T;
  }
  return value;
}

function apply(current: VersionedState, m: Mutation): VersionedState {
  const customId = m.customId === undefined ? current.customId : m.customId.value;
  const agencyId = m.agencyId ?? current.agencyId;
  return {
    content: m.content ?? reorder(current.content),
    status: m.status ?? current.status,
    ...(customId !== undefined && { customId }),
    ...(agencyId !== undefined && { agencyId }),
  };
}

/** Key-order- and prototype-independent JSON (test-local reference, not `canonicalJson`). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sameState = (a: VersionedState, b: VersionedState) =>
  canonical(a.content) === canonical(b.content) &&
  a.status === b.status &&
  a.customId === b.customId &&
  a.agencyId === b.agencyId;

function setup() {
  let now = T0;
  const listings = new InMemoryManagedListingStore();
  const versions = new InMemoryListingVersionStore();
  const writer = new VersionedListingWriter({
    listings,
    versions,
    keys: new InMemoryListingKeyStore(),
    blocklist: new InMemoryDeletionBlocklistCheck(),
    counters: new InMemoryMetricCounterStore(),
    snapshots: new InMemorySnapshotStore(),
    transactor: new InMemoryTransactor(),
    clock: () => (now += 1000),
  });
  return { listings, versions, writer };
}

describe('Property 10: Keine Version ohne Änderung', () => {
  it('writes exactly one version per changed state and none for an unchanged one', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbListingId,
        arbCreation,
        fc.array(
          fc.tuple(arbStep, fc.boolean()).chain(([step, identical]) =>
            // Half the steps resubmit the current state unchanged (only the representation differs).
            fc.record({
              mutation: fc.constant(identical ? {} : step.mutation),
              channel: fc.constant(step.channel),
              changeType: fc.constantFrom(...CHANGE_TYPE[step.channel]),
              actor: arbActorRef(step.channel),
            }),
          ),
          { minLength: 1, maxLength: 6 },
        ),
        async (listingId, { initial, ...creation }, steps) => {
          const s = setup();
          const created = await s.writer.write({
            listingId,
            expectedVersion: null,
            next: initial,
            changeType: 'CREATE',
            channel: creation.channel,
            actor: creation.actor,
          });
          expect(created.ok && created.value.outcome).toBe('created');

          let state = initial;
          let version = 1;
          for (const { mutation, channel, changeType, actor } of steps) {
            const next = apply(state, mutation);
            const changed = !sameState(state, next);
            const historyBefore = s.versions.all();
            const change: StateChange = {
              listingId,
              expectedVersion: version,
              next,
              changeType,
              channel,
              actor,
            };

            const result = await s.writer.write(change);

            expect(result.ok).toBe(true);
            if (!result.ok) return;
            const history = s.versions.all();
            const stored = await s.listings.get(listingId);
            if (changed) {
              version += 1;
              expect(result.value.outcome).toBe('updated');
              expect(history).toHaveLength(historyBefore.length + 1);
              expect(history.slice(0, historyBefore.length)).toEqual(historyBefore);
              expect(history.filter((v) => v.version === version)).toHaveLength(1);
            } else {
              expect(result.value.outcome).toBe('unchanged');
              expect(history).toEqual(historyBefore);
            }
            expect(stored?.management.version).toBe(version);
            state = next;
          }
        },
      ),
      RUNS,
    );
  });
});
