// Feature: listing-management, Property 29: Audit-Abfrage
import {
  AUDIT_SERVICE_CATEGORIES,
  auditActorId,
  InMemoryAuditService,
  type AuditQuery,
  type AuditRecord,
} from '@open-estate/core';
import { CHANNELS, type ActorRef } from '@open-estate/shared';
import fc from 'fast-check';
import { arbActorRef, arbAgencyId } from '../../../shared/test/arbitraries';

// **Validates: Requirements 11.1, 11.2, 11.4**
//
// For any set of audit entries and filter combination (actor, agency, action, period) the query
// returns exactly the matching entries in descending order of time, each exactly once across all
// pages; every audited action produces exactly one entry with actor, channel, action, target,
// agency, result and timestamp.

const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const ACTIONS = ['agency.created', 'user.updated', 'machine-access.revoked', 'listing.update'];

/**
 * Small pools for actors and agencies, so filters hit entries regularly. `advanceMs` is the time
 * the clock advances before the entry is appended (0 → equal timestamps).
 */
const arbScenario = fc
  .record({
    actors: fc.uniqueArray(arbActorRef(), {
      minLength: 1,
      maxLength: 3,
      selector: auditActorId,
    }),
    agencies: fc.uniqueArray(arbAgencyId, { minLength: 1, maxLength: 3 }),
  })
  .chain(({ actors, agencies }) =>
    fc.record({
      actors: fc.constant(actors),
      agencies: fc.constant(agencies),
      generated: fc.array(
        fc.record({
          advanceMs: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 5_000 })),
          entry: fc.record(
            {
              category: fc.constantFrom(...AUDIT_SERVICE_CATEGORIES),
              actor: fc.constantFrom(...actors),
              channel: fc.constantFrom(...CHANNELS),
              action: fc.constantFrom(...ACTIONS),
              target: fc.stringMatching(/^[a-z]{1,8}\/[a-z0-9]{1,8}$/),
              agencyId: fc.constantFrom(...agencies),
              result: fc.constantFrom('success', 'FORBIDDEN', 'UNAUTHENTICATED'),
            },
            { requiredKeys: ['category', 'action', 'target', 'result'] },
          ),
        }),
        { maxLength: 30 },
      ),
    }),
  );

/** Filter combination; values come from the pools or are absent from every entry. */
const arbFilter = (
  actors: readonly ActorRef[],
  agencies: readonly string[],
  span: number,
): fc.Arbitrary<AuditQuery> => {
  const arbInstant = fc
    .integer({ min: -1_000, max: span + 1_000 })
    .map((offset) => new Date(T0 + offset).toISOString());
  return fc.record(
    {
      actor: fc.oneof(fc.constantFrom(...actors.map(auditActorId)), fc.constant('usr-unknown')),
      agencyId: fc.oneof(fc.constantFrom(...agencies), fc.constant('agy-unknown')),
      action: fc.constantFrom(...ACTIONS, 'unknown.action'),
      from: arbInstant,
      to: arbInstant,
    },
    { requiredKeys: [] },
  );
};

function matches(record: AuditRecord, filter: AuditQuery): boolean {
  const time = Date.parse(record.timestamp);
  return (
    (filter.actor === undefined ||
      (record.actor !== undefined && auditActorId(record.actor) === filter.actor)) &&
    (filter.agencyId === undefined || record.agencyId === filter.agencyId) &&
    (filter.action === undefined || record.action === filter.action) &&
    (filter.from === undefined || time >= Date.parse(filter.from)) &&
    (filter.to === undefined || time <= Date.parse(filter.to))
  );
}

async function collectAll(
  service: InMemoryAuditService,
  filter: AuditQuery,
  limit: number,
): Promise<AuditRecord[]> {
  const items: AuditRecord[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 100; pages++) {
    const page = await service.query(filter, { limit, ...(cursor !== undefined && { cursor }) });
    expect(page.items.length).toBeLessThanOrEqual(limit);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor === undefined) return items;
  }
  throw new Error('pagination did not terminate');
}

describe('Property 29: Audit-Abfrage', () => {
  it('returns exactly the matching entries, newest first, each once across all pages', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbScenario.chain((scenario) => {
          const span = scenario.generated.reduce((sum, g) => sum + g.advanceMs, 0);
          return fc.record({
            scenario: fc.constant(scenario),
            filter: arbFilter(scenario.actors, scenario.agencies, span),
            limit: fc.integer({ min: 1, max: 7 }),
          });
        }),
        async ({ scenario, filter, limit }) => {
          let now = T0;
          let nextId = 0;
          const service = new InMemoryAuditService({
            now: () => now,
            // Ids descending in append order, so the id tie-break differs from append order.
            newId: () => `e${String(1_000 - nextId++).padStart(4, '0')}`,
          });

          // Req 11.1, 11.2: each append yields exactly one entry carrying all given fields.
          const appended: AuditRecord[] = [];
          for (const { entry, advanceMs } of scenario.generated) {
            now += advanceMs;
            const before = service.entries.length;
            const record = await service.append(entry);
            expect(service.entries).toHaveLength(before + 1);
            expect(service.entries.at(-1)).toEqual(record);
            expect(record).toEqual({
              ...entry,
              id: expect.any(String),
              timestamp: new Date(now).toISOString(),
            });
            appended.push(record);
          }

          // Req 11.4: filtered, paginated, newest first, each matching entry exactly once.
          const result = await collectAll(service, filter, limit);
          const ids = result.map((record) => record.id);
          expect(new Set(ids).size).toBe(ids.length);
          const expected = appended.filter((record) => matches(record, filter));
          expect([...ids].sort()).toEqual(expected.map((record) => record.id).sort());
          for (const record of result) {
            expect(record).toEqual(appended.find((a) => a.id === record.id));
          }
          const times = result.map((record) => Date.parse(record.timestamp));
          times.slice(1).forEach((time, i) => {
            expect(times[i]).toBeGreaterThanOrEqual(time);
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});
