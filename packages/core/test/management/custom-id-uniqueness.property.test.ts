// Feature: listing-management, Property 12: Custom_Id-Eindeutigkeit und Abruf
import {
  contentRules,
  InMemoryAgencyStore,
  InMemoryAuditService,
  InMemoryDeletionBlocklistCheck,
  InMemoryListingKeyStore,
  InMemoryListingVersionStore,
  InMemoryManagedListingStore,
  InMemoryMetricCounterStore,
  InMemorySnapshotStore,
  InMemoryTransactor,
  ListingCommandService,
  ListingQueryService,
  listingKey,
  manualContentSchema,
  VersionedListingWriter,
  VersionService,
  type AgencyActor,
  type AgencyRecord,
} from '@open-estate/core';
import {
  CHANNELS,
  LISTING_STATUSES,
  type ActorRef,
  type Channel,
  type ListingContent,
  type ListingStatus,
  type Principal,
  type Taxonomy,
  type VersionedState,
} from '@open-estate/shared';
import fc from 'fast-check';
import { arbActorRef, arbCustomId, arbListingContent } from '../../../shared/test/arbitraries';

/**
 * Property 12: for any sequence of creations, edits and imports with Custom_Ids, every Custom_Id
 * is assigned to at most one listing per agency; an assignment to a second listing is rejected
 * with `CUSTOM_ID_TAKEN` (Management_API) or as identity conflict (import via the shared
 * `VersionedListingWriter`) and leaves the data unchanged; for any stored assignment the lookup
 * by Custom_Id returns the same listing as the lookup by id, and the same Custom_Id may denote
 * different listings in different agencies.
 *
 * **Validates: Requirements 4.11, 4.12, 4.13, 12.14**
 */

const RUNS = { numRuns: 100 };
const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const ORIGIN = 'https://www.example.org';
const AGENCIES = ['agy-1', 'agy-2'] as const;
const LISTING_IDS = ['lst-0', 'lst-1', 'lst-2', 'lst-3'] as const;

const member = (agencyId: string): AgencyActor => ({
  principal: { kind: 'user', userId: 'm1', displayName: 'M', role: 'AGENCY_MEMBER', agencyId },
  channel: 'PORTAL',
});
const admin: AgencyActor = {
  principal: { kind: 'user', userId: 'pa', displayName: 'Root', role: 'PLATFORM_ADMIN' },
  channel: 'ADMIN',
};

function setup() {
  let now = T0;
  const stores = {
    listings: new InMemoryManagedListingStore(),
    versions: new InMemoryListingVersionStore(),
    keys: new InMemoryListingKeyStore(),
    blocklist: new InMemoryDeletionBlocklistCheck(),
    snapshots: new InMemorySnapshotStore(),
  };
  const writer = new VersionedListingWriter({
    ...stores,
    counters: new InMemoryMetricCounterStore(),
    transactor: new InMemoryTransactor(),
    clock: () => (now += 1000),
  });
  const audit = new InMemoryAuditService();
  const queries = new ListingQueryService({ ...stores, audit, frontendOrigin: ORIGIN });
  const versionService = new VersionService({ ...stores, audit });
  return { ...stores, writer, queries, versionService };
}

/** One write of the sequence; `customId` index into the pool, `null` = without Custom_Id. */
interface Step {
  listing: number;
  agency: number;
  customId: number | null;
  content: ListingContent;
  status: ListingStatus;
  channel: Channel;
  actor: ActorRef;
}

const arbStep: fc.Arbitrary<Step> = fc.constantFrom(...CHANNELS).chain((channel) =>
  fc.record({
    listing: fc.integer({ min: 0, max: LISTING_IDS.length - 1 }),
    agency: fc.integer({ min: 0, max: AGENCIES.length - 1 }),
    customId: fc.option(fc.integer({ min: 0, max: 2 }), { nil: null }),
    content: arbListingContent(),
    status: fc.constantFrom(...LISTING_STATUSES),
    channel: fc.constant(channel),
    actor: arbActorRef(channel),
  }),
);

const sortedEntries = (model: Map<string, string>): [string, string][] =>
  [...model.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

describe('Property 12: Custom_Id-Eindeutigkeit und Abruf', () => {
  it('assigns each Custom_Id per agency to at most one listing and resolves it like the id', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(arbCustomId, { minLength: 3, maxLength: 3 }),
        fc.array(arbStep, { minLength: 1, maxLength: 12 }),
        async (pool, steps) => {
          const s = setup();
          /** Reference model: `agencyId#customId` → listing id. */
          const model = new Map<string, string>();
          const states = new Map<string, VersionedState>();

          for (const step of steps) {
            const listingId = LISTING_IDS[step.listing] as string;
            const agencyId = AGENCIES[step.agency] as string;
            const customId = step.customId === null ? undefined : pool[step.customId];
            const current = await s.listings.get(listingId);
            const next: VersionedState = {
              content: step.content,
              status: step.status,
              agencyId,
              ...(customId !== undefined && { customId }),
            };
            const owner =
              customId === undefined ? undefined : model.get(listingKey(agencyId, customId));
            const taken = owner !== undefined && owner !== listingId;
            const versionsBefore = s.versions.all().length;
            const keysBefore = s.keys.entries();

            const result = await s.writer.write({
              listingId,
              expectedVersion: current?.management.version ?? null,
              next,
              changeType:
                step.channel === 'IMPORT' ? 'IMPORT' : current === null ? 'CREATE' : 'UPDATE',
              channel: step.channel,
              actor: step.actor,
            });

            if (taken) {
              // Second assignment: rejected, nothing changed (Req 4.12, 12.14).
              expect(result.ok || result.error).toEqual({ code: 'CUSTOM_ID_TAKEN' });
              expect(await s.listings.get(listingId)).toEqual(current);
              expect(s.versions.all()).toHaveLength(versionsBefore);
              expect(s.keys.entries()).toEqual(keysBefore);
            } else {
              expect(result.ok).toBe(true);
              if (result.ok && result.value.outcome !== 'unchanged') {
                const previous = states.get(listingId);
                if (previous?.customId !== undefined) {
                  model.delete(listingKey(previous.agencyId as string, previous.customId));
                }
                if (customId !== undefined) model.set(listingKey(agencyId, customId), listingId);
                states.set(listingId, next);
                // The Custom_Id is part of the new version (Req 4.11).
                const latest = s.versions
                  .all()
                  .filter((r) => r.listingId === listingId)
                  .sort((a, b) => b.version - a.version)[0];
                expect(latest?.customId).toBe(customId);
              }
            }

            // At most one listing per agency and Custom_Id, keys exactly as in the model.
            expect(s.keys.entries()).toEqual(sortedEntries(model));
            const carried = new Map<string, string[]>();
            for (const id of LISTING_IDS) {
              const managed = await s.listings.get(id);
              const { customId: cid, agencyId: aid } = managed?.management ?? {};
              if (cid === undefined || aid === undefined) continue;
              const key = listingKey(aid, cid);
              carried.set(key, [...(carried.get(key) ?? []), id]);
            }
            for (const [key, ids] of carried) {
              expect(ids).toHaveLength(1);
              expect(model.get(key)).toBe(ids[0]);
            }

            // Lookup by Custom_Id = lookup by id (Req 4.13), for members and Plattform_Admins.
            for (const agency of AGENCIES) {
              for (const cid of pool) {
                const assigned = model.get(listingKey(agency, cid));
                const byCustomId = await s.queries.getByCustomId(member(agency), cid);
                const byAdmin = await s.queries.getByCustomId(admin, cid, agency);
                if (assigned === undefined) {
                  expect(byCustomId.ok || byCustomId.error[0]?.code).toBe('NOT_FOUND');
                  expect(byAdmin.ok || byAdmin.error[0]?.code).toBe('NOT_FOUND');
                  continue;
                }
                const byId = await s.queries.get(member(agency), assigned);
                expect(byId.ok).toBe(true);
                expect(byCustomId).toEqual(byId);
                expect(byAdmin).toEqual(byId);
                const history = await s.versionService.list(member(agency), assigned, {
                  limit: 1,
                });
                expect(history.ok && history.value.items[0]?.customId).toBe(cid);
              }
            }
          }
        },
      ),
      RUNS,
    );
  });

  it('allows the same Custom_Id for different listings in different agencies', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbCustomId,
        fc.tuple(arbListingContent(), arbListingContent()),
        fc.constantFrom(...CHANNELS).chain((c) => fc.tuple(fc.constant(c), arbActorRef(c))),
        async (customId, [first, second], [channel, actor]) => {
          const s = setup();
          for (const [i, content] of [first, second].entries()) {
            const result = await s.writer.write({
              listingId: LISTING_IDS[i] as string,
              expectedVersion: null,
              next: { content, status: 'ACTIVE', agencyId: AGENCIES[i] as string, customId },
              changeType: channel === 'IMPORT' ? 'IMPORT' : 'CREATE',
              channel,
              actor,
            });
            expect(result.ok && result.value.outcome).toBe('created');
          }
          for (const [i, agency] of AGENCIES.entries()) {
            const found = await s.queries.getByCustomId(member(agency), customId);
            expect(found.ok && found.value.id).toBe(LISTING_IDS[i]);
          }
        },
      ),
      RUNS,
    );
  });
});

// Management_API level: the writer conflict is answered as 409 `CUSTOM_ID_TAKEN` (Req 4.12).

const TAXONOMY: Taxonomy = { groups: [{ code: 'residential', types: ['apartment_unit'] }] };
const agency = (agencyId: string): AgencyRecord => ({
  agencyId,
  displayName: agencyId,
  state: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00.000Z',
  agencyAdmins: 1,
});
const principalOf = (agencyId: string): Principal => member(agencyId).principal;

/** Listing_Inhalt in the API representation. */
const apiContent = (title: string): Record<string, unknown> => ({
  originalLocale: 'de',
  title,
  description: '',
  translations: [],
  offers: [{ offerType: 'SALE', price: '250000.00', currency: 'EUR' }],
  listingType: 'apartment_unit',
  rooms: 3,
  area: '75.5',
  address: { city: 'Berlin', postalCode: '10115', country: 'DE' },
  media: [],
  tours: [],
});

/** Create (`listing` = null) or edit of a listing; `customId` index, `null` = remove. */
interface Command {
  listing: number | null;
  agency: number;
  customId: number | null;
  title: string;
}

const arbCommand: fc.Arbitrary<Command> = fc.record({
  listing: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }),
  agency: fc.integer({ min: 0, max: AGENCIES.length - 1 }),
  customId: fc.option(fc.integer({ min: 0, max: 2 }), { nil: null }),
  title: fc.constantFrom('Altbau', 'Neubau', 'Loft'),
});

describe('Property 12 via ListingCommandService', () => {
  it('rejects a taken Custom_Id with CUSTOM_ID_TAKEN and resolves stored ones like the id', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(arbCustomId, { minLength: 3, maxLength: 3 }),
        fc.array(arbCommand, { minLength: 1, maxLength: 10 }),
        async (pool, commands) => {
          const s = setup();
          let ids = 0;
          const svc = new ListingCommandService({
            listings: s.listings,
            versions: s.versions,
            snapshots: s.snapshots,
            agencies: new InMemoryAgencyStore(AGENCIES.map(agency)),
            writer: s.writer,
            audit: new InMemoryAuditService(),
            frontendOrigin: ORIGIN,
            contentSchema: manualContentSchema(TAXONOMY),
            rules: contentRules({ tourProviders: { providers: [] } }),
            newId: () => `l${++ids}`,
          });
          const model = new Map<string, string>();
          const created: { id: string; agencyId: string }[] = [];

          for (const command of commands) {
            const customId = command.customId === null ? null : (pool[command.customId] as string);
            const target = command.listing === null ? undefined : created[command.listing];
            const agencyId = target?.agencyId ?? (AGENCIES[command.agency] as string);
            const current = target === undefined ? null : await s.listings.get(target.id);
            const owner = customId === null ? undefined : model.get(listingKey(agencyId, customId));
            const taken = owner !== undefined && owner !== target?.id;
            const versionsBefore = s.versions.all().length;

            const result =
              target === undefined
                ? await svc.create(principalOf(agencyId), {
                    content: apiContent(command.title),
                    ...(customId !== null && { customId }),
                  })
                : await svc.replaceContent(principalOf(agencyId), target.id, {
                    content: apiContent(command.title),
                    customId,
                    baseVersion: current?.management.version,
                  });

            if (taken) {
              expect(result.ok || result.error).toEqual([
                expect.objectContaining({ code: 'CUSTOM_ID_TAKEN', field: 'customId' }),
              ]);
              expect(s.versions.all()).toHaveLength(versionsBefore);
              if (target !== undefined) expect(await s.listings.get(target.id)).toEqual(current);
            } else {
              if (!result.ok) throw new Error(`unexpected errors: ${JSON.stringify(result.error)}`);
              const id = result.value.id;
              if (target === undefined) created.push({ id, agencyId });
              const previous = current?.management.customId;
              if (previous !== undefined) model.delete(listingKey(agencyId, previous));
              if (customId !== null) model.set(listingKey(agencyId, customId), id);
              expect(result.value.customId).toBe(customId ?? undefined);
            }

            expect(s.keys.entries()).toEqual(sortedEntries(model));
            for (const [key, id] of model) {
              const [aid, ...rest] = key.split('#');
              const byCustomId = await s.queries.getByCustomId(
                member(aid as string),
                rest.join('#'),
              );
              expect(byCustomId).toEqual(await s.queries.get(member(aid as string), id));
            }
          }
        },
      ),
      RUNS,
    );
  });
});
