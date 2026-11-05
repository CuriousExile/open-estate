// Feature: listing-management, Property 6: Admin-Invarianten
import {
  AgencyService,
  InMemoryAgencyStore,
  InMemoryAuditService,
  InMemoryIdentityDirectory,
  InMemoryMembershipStore,
  InMemoryMetricCounterStore,
  InMemoryPlatformCounterStore,
  InMemoryTransactor,
  MembershipService,
  type AgencyActor,
  type MembershipRecord,
} from '@open-estate/core';
import { AGENCY_ROLES, ERROR_HTTP_STATUS, type AgencyRole } from '@open-estate/shared';
import fc from 'fast-check';
import { arbAgencyId, arbPlatformAdminPrincipal } from '../../../shared/test/arbitraries';

/**
 * Property 6: for any sequence of role changes, additions and removals, afterwards every agency
 * with at least one user has at least one Agentur_Admin, the platform has at least one
 * Plattform_Admin, and every user has exactly one agency with an agency role or the role
 * Plattform_Admin without agency; every operation that would violate this is rejected with 409
 * and leaves the state unchanged.
 *
 * Sequential steps are compared with a reference model (outcome and resulting state). Concurrent
 * steps (2–3 calls via `Promise.all`, interleaving at every `await`) must be linearizable: some
 * serial order of the calls yields the observed outcomes and state in the model.
 *
 * **Validates: Requirements 1.2, 1.7, 10.9**
 */

const RUNS = { numRuns: 100 };
const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const CREATED = '2026-01-01T00:00:00.000Z';
const ROOT = { userId: 'usr-root', email: 'root@example.org', displayName: 'Root' };
/** Users known to the directory; ROOT is the bootstrap Plattform_Admin. */
const KNOWN_EMAILS = [ROOT.email, 'u0@example.org', 'u1@example.org', 'u2@example.org'];
/** Unknown addresses get an invitation; only used in sequential steps (one invite per address). */
const UNKNOWN_EMAILS = ['new0@example.org', 'new1@example.org'];
const UNKNOWN_AGENCY = 'agy-unknown';
const PAGE = { limit: 100 };

type Assignment = { role: AgencyRole; agencyId: string } | { role: 'PLATFORM_ADMIN' };
/** Model and observed state: assignment per e-mail address. */
type State = ReadonlyMap<string, Assignment>;
type Outcome = 'ok' | string;

type Op =
  | { kind: 'addMember'; agencyId: string; email: string; role: AgencyRole }
  | { kind: 'changeRole'; agencyId: string; email: string; role: AgencyRole }
  | { kind: 'removeMember'; agencyId: string; email: string; dryRun: boolean }
  | { kind: 'addPlatformAdmin'; email: string }
  | { kind: 'removePlatformAdmin'; email: string; dryRun: boolean };

type Step = { concurrent: false; op: Op } | { concurrent: true; ops: Op[] };

// ---------------------------------------------------------------------------------------------
// Reference model
// ---------------------------------------------------------------------------------------------

const agencyAdmins = (state: State, agencyId: string) =>
  [...state.values()].filter((a) => a.role === 'AGENCY_ADMIN' && a.agencyId === agencyId).length;
const platformAdmins = (state: State) =>
  [...state.values()].filter((a) => a.role === 'PLATFORM_ADMIN').length;
const memberOf = (state: State, email: string, agencyId: string) => {
  const current = state.get(email);
  return current !== undefined && current.role !== 'PLATFORM_ADMIN' && current.agencyId === agencyId
    ? current
    : undefined;
};
const withEntry = (state: State, email: string, assignment: Assignment | undefined): State => {
  const next = new Map(state);
  if (assignment === undefined) next.delete(email);
  else next.set(email, assignment);
  return next;
};

/** Expected outcome and state of one call, given the existing agencies. */
function model(state: State, op: Op, agencies: ReadonlySet<string>): [Outcome, State] {
  switch (op.kind) {
    case 'addMember':
      if (!agencies.has(op.agencyId)) return ['NOT_FOUND', state];
      if (op.role === 'AGENCY_MEMBER' && agencyAdmins(state, op.agencyId) === 0) {
        return ['LAST_AGENCY_ADMIN', state];
      }
      if (state.has(op.email)) return ['USER_ALREADY_ASSIGNED', state];
      return ['ok', withEntry(state, op.email, { role: op.role, agencyId: op.agencyId })];
    case 'changeRole': {
      const current = memberOf(state, op.email, op.agencyId);
      if (current === undefined) return ['NOT_FOUND', state];
      if (current.role === op.role) return ['ok', state];
      if (op.role === 'AGENCY_MEMBER' && agencyAdmins(state, op.agencyId) <= 1) {
        return ['LAST_AGENCY_ADMIN', state];
      }
      return ['ok', withEntry(state, op.email, { role: op.role, agencyId: op.agencyId })];
    }
    case 'removeMember': {
      const current = memberOf(state, op.email, op.agencyId);
      if (current === undefined) return ['NOT_FOUND', state];
      // Req 1.7: the agency must keep an Agentur_Admin, even if it is the last user.
      if (current.role === 'AGENCY_ADMIN' && agencyAdmins(state, op.agencyId) <= 1) {
        return ['LAST_AGENCY_ADMIN', state];
      }
      return ['ok', op.dryRun ? state : withEntry(state, op.email, undefined)];
    }
    case 'addPlatformAdmin':
      if (state.has(op.email)) return ['USER_ALREADY_ASSIGNED', state];
      return ['ok', withEntry(state, op.email, { role: 'PLATFORM_ADMIN' })];
    case 'removePlatformAdmin':
      if (state.get(op.email)?.role !== 'PLATFORM_ADMIN') return ['NOT_FOUND', state];
      if (platformAdmins(state) <= 1) return ['LAST_PLATFORM_ADMIN', state];
      return ['ok', op.dryRun ? state : withEntry(state, op.email, undefined)];
  }
}

const VIOLATION_CODES = new Set([
  'LAST_AGENCY_ADMIN',
  'LAST_PLATFORM_ADMIN',
  'USER_ALREADY_ASSIGNED',
]);

const sameState = (a: State, b: State) =>
  a.size === b.size &&
  [...a].every(([email, x]) => JSON.stringify(b.get(email)) === JSON.stringify(x));

const permutations = <T>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
      );

// ---------------------------------------------------------------------------------------------
// System under test
// ---------------------------------------------------------------------------------------------

async function setup(agencyIds: readonly string[], actor: AgencyActor) {
  const deps = {
    agencies: new InMemoryAgencyStore(),
    memberships: new InMemoryMembershipStore([
      { ...ROOT, role: 'PLATFORM_ADMIN', createdAt: CREATED },
    ]),
    platformCounters: new InMemoryPlatformCounterStore({ platformAdmins: 1 }),
    identity: new InMemoryIdentityDirectory(
      KNOWN_EMAILS.map((email, i) =>
        email === ROOT.email ? ROOT : { userId: `usr-${i}`, email, displayName: email },
      ),
    ),
    audit: new InMemoryAuditService({ now: () => T0 }),
  };
  const ids = [...agencyIds];
  const agencyService = new AgencyService({
    agencies: deps.agencies,
    memberships: deps.memberships,
    counters: new InMemoryMetricCounterStore(),
    audit: deps.audit,
    clock: () => T0,
    newId: () => ids.shift() ?? 'agy-exhausted',
  });
  for (let i = 0; i < agencyIds.length; i++) {
    const created = await agencyService.create(actor, { displayName: 'Agency' });
    expect(created.ok).toBe(true);
  }
  const service = new MembershipService({
    ...deps,
    transactor: new InMemoryTransactor(),
    clock: () => T0,
  });
  return { ...deps, service };
}

type Sut = Awaited<ReturnType<typeof setup>>;

/** User id of an address; unknown addresses map to an id no membership can have. */
const userIdOf = async (sut: Sut, email: string) =>
  (await sut.identity.findByEmail(email))?.userId ?? `usr-none-${email}`;

async function execute(sut: Sut, actor: AgencyActor, op: Op): Promise<Outcome> {
  const { service } = sut;
  let result: { ok: true } | { ok: false; error: { code: string }[] };
  switch (op.kind) {
    case 'addMember':
      result = await service.addMember(actor, op.agencyId, { email: op.email, role: op.role });
      break;
    case 'changeRole':
      result = await service.changeRole(actor, op.agencyId, await userIdOf(sut, op.email), {
        role: op.role,
      });
      break;
    case 'removeMember':
      result = await service.removeMember(actor, op.agencyId, await userIdOf(sut, op.email), {
        dryRun: op.dryRun,
      });
      break;
    case 'addPlatformAdmin':
      result = await service.addPlatformAdmin(actor, { email: op.email });
      break;
    case 'removePlatformAdmin':
      result = await service.removePlatformAdmin(actor, await userIdOf(sut, op.email), {
        dryRun: op.dryRun,
      });
      break;
  }
  if (result.ok) return 'ok';
  expect(result.error).toHaveLength(1);
  return result.error[0]?.code ?? 'NO_ERROR_CODE';
}

/** Observed assignments; also checks the invariants and the stored admin counters. */
async function observe(sut: Sut, agencyIds: readonly string[]): Promise<State> {
  const state = new Map<string, Assignment>();
  const userIds = new Set<string>();
  const record = (r: MembershipRecord) => {
    // Exactly one assignment per user (Req 1.2).
    expect(userIds.has(r.userId) || state.has(r.email)).toBe(false);
    userIds.add(r.userId);
    if (r.role === 'PLATFORM_ADMIN') {
      expect(r.agencyId).toBeUndefined();
      state.set(r.email, { role: 'PLATFORM_ADMIN' });
    } else {
      expect(AGENCY_ROLES).toContain(r.role);
      expect(agencyIds).toContain(r.agencyId);
      state.set(r.email, { role: r.role, agencyId: r.agencyId ?? 'missing-agency' });
    }
  };
  for (const agencyId of agencyIds) {
    const page = await sut.memberships.listByAgency(agencyId, PAGE);
    expect(page.nextCursor).toBeUndefined();
    page.items.forEach(record);
    const admins = agencyAdmins(state, agencyId);
    // Every agency with at least one user has an Agentur_Admin (Req 1.7).
    if (page.items.length > 0) expect(admins).toBeGreaterThanOrEqual(1);
    expect((await sut.agencies.get(agencyId))?.agencyAdmins).toBe(admins);
  }
  const pas = await sut.memberships.listPlatformAdmins(PAGE);
  pas.items.forEach(record);
  // The platform keeps a Plattform_Admin (Req 10.9).
  expect(platformAdmins(state)).toBeGreaterThanOrEqual(1);
  expect(await sut.platformCounters.platformAdmins()).toBe(platformAdmins(state));
  return state;
}

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

function arbOp(agencyIds: readonly string[], emails: readonly string[]): fc.Arbitrary<Op> {
  const agencyId = fc.constantFrom(...agencyIds, UNKNOWN_AGENCY);
  const email = fc.constantFrom(...emails);
  const role = fc.constantFrom(...AGENCY_ROLES);
  const dryRun = fc.boolean();
  return fc.oneof(
    // Additions and role changes weigh more, so sequences build up populated agencies.
    {
      weight: 3,
      arbitrary: fc.record({ kind: fc.constant('addMember' as const), agencyId, email, role }),
    },
    {
      weight: 3,
      arbitrary: fc.record({ kind: fc.constant('changeRole' as const), agencyId, email, role }),
    },
    {
      weight: 2,
      arbitrary: fc.record({ kind: fc.constant('removeMember' as const), agencyId, email, dryRun }),
    },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('addPlatformAdmin' as const), email }) },
    {
      weight: 2,
      arbitrary: fc.record({ kind: fc.constant('removePlatformAdmin' as const), email, dryRun }),
    },
  );
}

function arbStep(agencyIds: readonly string[]): fc.Arbitrary<Step> {
  return fc.oneof(
    {
      weight: 3,
      arbitrary: arbOp(agencyIds, [...KNOWN_EMAILS, ...UNKNOWN_EMAILS]).map((op): Step => ({
        concurrent: false,
        op,
      })),
    },
    {
      weight: 1,
      arbitrary: fc
        .array(arbOp(agencyIds, KNOWN_EMAILS), { minLength: 2, maxLength: 3 })
        .map((ops): Step => ({ concurrent: true, ops })),
    },
  );
}

const arbScenario = fc.uniqueArray(arbAgencyId, { minLength: 1, maxLength: 3 }).chain((agencyIds) =>
  fc.record({
    agencyIds: fc.constant(agencyIds),
    principal: arbPlatformAdminPrincipal,
    steps: fc.array(arbStep(agencyIds), { minLength: 1, maxLength: 25 }),
  }),
);

// ---------------------------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------------------------

describe('Property 6: Admin-Invarianten', () => {
  it('keeps the admin and assignment invariants and rejects every violation with 409', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async ({ agencyIds, principal, steps }) => {
        const actor: AgencyActor = { principal, channel: 'ADMIN' };
        const agencies = new Set(agencyIds);
        const sut = await setup(agencyIds, actor);
        let state: State = await observe(sut, agencyIds);

        for (const step of steps) {
          if (!step.concurrent) {
            const [expected, next] = model(state, step.op, agencies);
            const outcome = await execute(sut, actor, step.op);
            expect(outcome).toBe(expected);
            if (VIOLATION_CODES.has(outcome)) {
              expect(ERROR_HTTP_STATUS[outcome as keyof typeof ERROR_HTTP_STATUS]).toBe(409);
            }
            const observed = await observe(sut, agencyIds);
            // Rejections leave the state unchanged; successes match the model.
            if (outcome !== 'ok') expect(sameState(observed, state)).toBe(true);
            expect(sameState(observed, next)).toBe(true);
            state = observed;
            continue;
          }
          const outcomes = await Promise.all(step.ops.map((op) => execute(sut, actor, op)));
          const observed = await observe(sut, agencyIds);
          const before = state;
          const linearizable = permutations(step.ops.map((op, i) => ({ op, i }))).some((order) => {
            let s = before;
            for (const { op, i } of order) {
              const [expected, next] = model(s, op, agencies);
              if (expected !== outcomes[i]) return false;
              s = next;
            }
            return sameState(s, observed);
          });
          expect({ ops: step.ops, outcomes, linearizable }).toEqual({
            ops: step.ops,
            outcomes,
            linearizable: true,
          });
          state = observed;
        }
      }),
      RUNS,
    );
  });
});
