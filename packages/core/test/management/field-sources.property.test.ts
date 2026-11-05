// Feature: listing-management, Property 15: Feldherkunft
import {
  InMemoryDeletionBlocklistCheck,
  InMemoryListingKeyStore,
  InMemoryListingVersionStore,
  InMemoryManagedListingStore,
  InMemoryMetricCounterStore,
  InMemorySnapshotStore,
  InMemoryTransactor,
  VersionedListingWriter,
  type ListingVersionRecord,
  type VersionChangedPath,
} from '@open-estate/core';
import {
  CHANNELS,
  CONTENT_FIELDS,
  LISTING_STATUSES,
  type ActorRef,
  type Channel,
  type FieldSources,
  type ListingContent,
  type ListingStatus,
  type VersionedState,
} from '@open-estate/shared';
import fc from 'fast-check';
import {
  arbActorRef,
  arbListingContent,
  arbListingId,
  arbVersionedState,
  referenceContentPaths,
} from '../../../shared/test/arbitraries';

/**
 * Property 15: for any sequence of changes, after every version the keys of the Feldherkunft are
 * exactly the Inhaltsfelder (`contentPaths`) of the current Listing_Inhalt, and the Feldherkunft
 * of every Inhaltsfeld refers to the last version that changed this field, with its channel and
 * actor; every version lists exactly the Inhaltsfelder added, removed or changed against the
 * previous version with their previous Feldherkunft; an import overwriting an Inhaltsfeld last
 * not changed by `IMPORT` is marked "durch Listenimport überschrieben" for exactly this
 * Inhaltsfeld (e.g. only `address.city`, not `address.street`).
 *
 * **Validates: Requirements 7.2, 12.11, 12.15**
 */

const RUNS = { numRuns: 100 };
const T0 = Date.parse('2026-03-01T10:00:00.000Z');

/** Nested content objects whose keys are separate Inhaltsfelder. */
const NESTED: ReadonlySet<string> = new Set(['address', 'geo', 'contact']);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Key-order-independent JSON (test-local reference). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Inhaltsfeld → canonical leaf value (objects resolved recursively, lists and scalars leaves). */
function leaves(content: ListingContent): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (value: unknown, path: string): void => {
    if (value === undefined) return;
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
    } else {
      result.set(path, canonical(value));
    }
  };
  for (const field of CONTENT_FIELDS) walk(content[field], field);
  return result;
}

/** Reference diff: added, removed or changed Inhaltsfelder, sorted. */
function referenceChanged(before: ListingContent, after: ListingContent): string[] {
  const a = leaves(before);
  const b = leaves(after);
  const changed = new Set<string>();
  for (const [path, value] of b) if (a.get(path) !== value) changed.add(path);
  for (const path of a.keys()) if (!b.has(path)) changed.add(path);
  return [...changed].sort();
}

/**
 * Per top-level field (and per key of the nested objects) either the current or the fresh value;
 * a missing fresh value removes the field. Yields partial changes such as only `address.city`.
 */
function mix(current: ListingContent, fresh: ListingContent, picks: readonly boolean[]) {
  let i = 0;
  const pick = () => picks[i++ % picks.length] ?? false;
  const result: Record<string, unknown> = {};
  const cur = current as Record<string, unknown>;
  const frs = fresh as Record<string, unknown>;
  for (const field of CONTENT_FIELDS) {
    const a = cur[field];
    const b = frs[field];
    let value: unknown;
    if (NESTED.has(field) && isPlainObject(a) && isPlainObject(b)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      value = Object.fromEntries(
        keys.flatMap((key) => {
          const chosen = pick() ? b[key] : a[key];
          return chosen === undefined ? [] : [[key, chosen]];
        }),
      );
    } else {
      value = pick() ? b : a;
    }
    if (value !== undefined) result[field] = value;
  }
  return result as ListingContent;
}

interface Step {
  fresh: ListingContent;
  picks: boolean[];
  status: ListingStatus | undefined;
  channel: Channel;
  actor: ActorRef;
}

const arbStep: fc.Arbitrary<Step> = fc.constantFrom(...CHANNELS).chain((channel) =>
  fc.record({
    fresh: arbListingContent(),
    picks: fc.array(fc.boolean(), { minLength: 1, maxLength: 24 }),
    status: fc.option(fc.constantFrom(...LISTING_STATUSES), { nil: undefined }),
    channel: fc.constant(channel),
    actor: arbActorRef(channel),
  }),
);

const arbCreation = fc.constantFrom(...CHANNELS).chain((channel) =>
  fc.record({
    channel: fc.constant(channel),
    actor: arbActorRef(channel),
    initial: arbVersionedState({ agencyless: channel === 'IMPORT' }),
  }),
);

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

/** Model step: expected changed paths of the version and the Feldherkunft after it. */
function expectVersion(
  model: FieldSources,
  before: ListingContent | undefined,
  after: ListingContent,
  write: { channel: Channel; actor: ActorRef; version: number },
): { fieldSources: FieldSources; changedPaths: VersionChangedPath[] } {
  const changed =
    before === undefined ? [...leaves(after).keys()].sort() : referenceChanged(before, after);
  const present = leaves(after);
  const fieldSources: FieldSources = {};
  for (const path of present.keys()) {
    const kept = model[path];
    if (!changed.includes(path) && kept === undefined) throw new Error(`no source for ${path}`);
    fieldSources[path] = changed.includes(path) || kept === undefined ? { ...write } : kept;
  }
  const changedPaths = changed.map((path): VersionChangedPath => {
    const previous = model[path];
    return {
      path,
      ...(previous !== undefined && { previous }),
      overwrittenByImport:
        write.channel === 'IMPORT' && previous !== undefined && previous.channel !== 'IMPORT',
    };
  });
  return { fieldSources, changedPaths };
}

/** Last version of the history that lists `path` as changed (independent of the stored sources). */
function lastChange(history: readonly ListingVersionRecord[], path: string) {
  return [...history]
    .filter((record) => record.changedPaths.some((entry) => entry.path === path))
    .sort((a, b) => b.version - a.version)[0];
}

describe('Property 15: Feldherkunft', () => {
  it('keeps the Feldherkunft per Inhaltsfeld and lists changed paths with their previous source', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbListingId,
        arbCreation,
        fc.array(arbStep, { minLength: 1, maxLength: 8 }),
        async (listingId, { initial, channel, actor }, steps) => {
          const s = setup();
          let state: VersionedState = initial;
          let version = 1;
          let model: FieldSources = {};

          const check = async (
            write: { channel: Channel; actor: ActorRef; version: number },
            before: ListingContent | undefined,
          ) => {
            const expected = expectVersion(model, before, state.content, write);
            const stored = await s.listings.get(listingId);
            const fieldSources = stored?.management.fieldSources ?? {};
            const history = s.versions.all().filter((r) => r.listingId === listingId);
            const record = history.find((r) => r.version === write.version);

            expect(Object.keys(fieldSources).sort()).toEqual(referenceContentPaths(state.content));
            expect(fieldSources).toEqual(expected.fieldSources);
            expect(record?.changedPaths).toEqual(expected.changedPaths);
            for (const [path, source] of Object.entries(fieldSources)) {
              const last = lastChange(history, path);
              expect(source).toEqual({
                channel: last?.channel,
                actor: last?.actor,
                version: last?.version,
              });
            }
            model = expected.fieldSources;
          };

          const created = await s.writer.write({
            listingId,
            expectedVersion: null,
            next: initial,
            changeType: 'CREATE',
            channel,
            actor,
          });
          expect(created.ok && created.value.outcome).toBe('created');
          await check({ channel, actor, version }, undefined);

          for (const step of steps) {
            const next: VersionedState = {
              ...state,
              content: mix(state.content, step.fresh, step.picks),
              status: step.status ?? state.status,
            };
            const result = await s.writer.write({
              listingId,
              expectedVersion: version,
              next,
              changeType: step.channel === 'IMPORT' ? 'IMPORT' : 'UPDATE',
              channel: step.channel,
              actor: step.actor,
            });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            const before = state.content;
            state = next;
            if (result.value.outcome === 'unchanged') {
              // No version: content and status equal the current state; sources unchanged.
              expect(referenceChanged(before, next.content)).toEqual([]);
              expect((await s.listings.get(listingId))?.management.fieldSources).toEqual(model);
              continue;
            }
            version += 1;
            await check({ channel: step.channel, actor: step.actor, version }, before);
          }
        },
      ),
      RUNS,
    );
  });

  it('marks only the overwritten Inhaltsfeld as "durch Listenimport überschrieben"', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbListingId,
        arbVersionedState({ agencyless: false }),
        fc
          .constantFrom<Channel>('PORTAL', 'API', 'ADMIN')
          .chain((channel) => fc.tuple(fc.constant(channel), arbActorRef(channel))),
        arbActorRef('IMPORT'),
        fc.string({ minLength: 1, maxLength: 20 }),
        async (listingId, initial, [manualChannel, manualActor], importActor, city) => {
          const content = {
            ...initial.content,
            address: { ...initial.content.address, street: 'Hauptstraße 1' },
          } as ListingContent;
          fc.pre(content.address.city !== city);
          const s = setup();
          await s.writer.write({
            listingId,
            expectedVersion: null,
            next: { ...initial, content },
            changeType: 'CREATE',
            channel: manualChannel,
            actor: manualActor,
          });
          const imported = { ...content, address: { ...content.address, city } } as ListingContent;
          const result = await s.writer.write({
            listingId,
            expectedVersion: 1,
            next: { ...initial, content: imported },
            changeType: 'IMPORT',
            channel: 'IMPORT',
            actor: importActor,
          });
          expect(result.ok && result.value.outcome).toBe('updated');

          const record = s.versions.all().find((r) => r.version === 2);
          expect(record?.changedPaths).toEqual([
            {
              path: 'address.city',
              previous: { channel: manualChannel, actor: manualActor, version: 1 },
              overwrittenByImport: true,
            },
          ]);
          const sources = (await s.listings.get(listingId))?.management.fieldSources;
          expect(sources?.['address.city']).toEqual({
            channel: 'IMPORT',
            actor: importActor,
            version: 2,
          });
          expect(sources?.['address.street']).toEqual({
            channel: manualChannel,
            actor: manualActor,
            version: 1,
          });
        },
      ),
      RUNS,
    );
  });
});
