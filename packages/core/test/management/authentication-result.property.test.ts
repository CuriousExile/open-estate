// Feature: listing-management, Property 4: Authentifizierungsergebnis
import {
  CachingAuthenticator,
  InMemoryAgencyStore,
  InMemoryMachineAccessStore,
  InMemoryMembershipStore,
  hashMachineSecret,
  type AccessTokenVerifier,
  type AgencyRecord,
  type MachineAccessRecord,
  type MembershipRecord,
} from '@open-estate/core';
import {
  AGENCY_ROLES,
  AGENCY_STATES,
  type AgencyRole,
  type AgencyState,
  type Principal,
} from '@open-estate/shared';
import fc from 'fast-check';
import {
  arbAgencyId,
  arbClockStart,
  arbKeyId,
  arbPermissionSet,
  arbUserId,
  SimulatedClock,
} from '../../../shared/test/arbitraries';

// For any set of agencies, memberships and machine accesses (active, revoked, expired), any
// simulated clock and any `Authorization` value, the authenticator yields exactly the result of
// a reference model; after a change to a membership, a revocation or a suspension the new
// result holds at the latest 60 s later.

const CACHE_TTL_MS = 60_000;
const CREATED = '2000-01-01T00:00:00.000Z';
const UNKNOWN_AGENCY = 'agy-unknown_';

/** Token `valid-<sub>` verifies to `<sub>`; everything else is invalid. */
const verifier: AccessTokenVerifier = {
  verify: async (token) => (token.startsWith('valid-') ? token.slice('valid-'.length) : null),
};

type Expected = { ok: true; value: Principal } | { ok: false; code: string };

interface World {
  agencies: Map<string, AgencyState>;
  memberships: Map<string, MembershipRecord>;
  machines: Map<string, { record: MachineAccessRecord; secret: string }>;
}

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

const arbSecret = fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/);

interface Scenario {
  start: number;
  agencies: { agencyId: string; state: AgencyState }[];
  users: { userId: string; role: MembershipRecord['role']; agencyPick: number }[];
  machines: {
    keyId: string;
    secret: string;
    agencyPick: number;
    permissions: MachineAccessRecord['permissions'];
    revoked: boolean;
    expiresInMs: number | null;
  }[];
}

const arbScenario: fc.Arbitrary<Scenario> = fc.record({
  start: arbClockStart,
  agencies: fc.uniqueArray(
    fc.record({ agencyId: arbAgencyId, state: fc.constantFrom(...AGENCY_STATES) }),
    { selector: (a) => a.agencyId, minLength: 1, maxLength: 4 },
  ),
  users: fc.uniqueArray(
    fc.record({
      userId: arbUserId,
      role: fc.constantFrom('PLATFORM_ADMIN' as const, ...AGENCY_ROLES),
      agencyPick: fc.nat(),
    }),
    { selector: (u) => u.userId, maxLength: 5 },
  ),
  machines: fc.uniqueArray(
    fc.record({
      keyId: arbKeyId,
      secret: arbSecret,
      agencyPick: fc.nat(),
      permissions: arbPermissionSet(),
      revoked: fc.boolean(),
      // Relative to the clock start; up to ±3 cache periods, so expiry also happens later.
      expiresInMs: fc.option(fc.integer({ min: -180_000, max: 180_000 }), { nil: null }),
    }),
    { selector: (m) => m.keyId, maxLength: 5 },
  ),
});

/** Agency of a user/key: one of the agencies or (sometimes) an unknown agency. */
function pickAgency(scenario: Scenario, pick: number): string {
  const ids = [...scenario.agencies.map((a) => a.agencyId), UNKNOWN_AGENCY];
  return ids[pick % ids.length] as string;
}

function buildWorld(scenario: Scenario): World {
  const memberships = new Map<string, MembershipRecord>();
  for (const u of scenario.users) {
    memberships.set(u.userId, {
      userId: u.userId,
      email: `${u.userId}@example.test`,
      displayName: `User ${u.userId}`,
      role: u.role,
      ...(u.role !== 'PLATFORM_ADMIN' && { agencyId: pickAgency(scenario, u.agencyPick) }),
      createdAt: CREATED,
    });
  }
  const machines = new Map<string, { record: MachineAccessRecord; secret: string }>();
  for (const m of scenario.machines) {
    machines.set(m.keyId, {
      secret: m.secret,
      record: {
        keyId: m.keyId,
        agencyId: pickAgency(scenario, m.agencyPick),
        label: `Key ${m.keyId}`,
        keyHash: hashMachineSecret(m.secret),
        permissions: m.permissions,
        createdBy: 'usr-creator',
        createdAt: CREATED,
        ...(m.expiresInMs !== null && {
          expiresAt: new Date(scenario.start + m.expiresInMs).toISOString(),
        }),
        ...(m.revoked && { revokedAt: CREATED }),
      },
    });
  }
  return {
    agencies: new Map(scenario.agencies.map((a) => [a.agencyId, a.state])),
    memberships,
    machines,
  };
}

const agencyRecord = (agencyId: string, state: AgencyState): AgencyRecord => ({
  agencyId,
  displayName: `Agency ${agencyId}`,
  state,
  createdAt: CREATED,
  agencyAdmins: 1,
});

/** `Authorization` values covering every branch; indices are resolved against the world. */
type HeaderSpec =
  | { kind: 'raw'; value: string | undefined }
  | { kind: 'userToken'; pick: number; scheme: string }
  | { kind: 'unknownUser'; userId: string }
  | { kind: 'forgedToken'; token: string }
  | { kind: 'machine'; pick: number; correctSecret: boolean; wrong: string; scheme: string }
  | { kind: 'unknownMachine'; keyId: string; secret: string }
  | { kind: 'malformedMachine'; value: string };

const arbScheme = fc.constantFrom('Bearer ', 'bearer ', 'BEARER\t', 'Bearer  ');

const arbHeaderSpec: fc.Arbitrary<HeaderSpec> = fc.oneof(
  fc.record({
    kind: fc.constant('raw' as const),
    value: fc.constantFrom(
      undefined,
      '',
      '   ',
      'Bearer',
      'Basic dXNlcjpwdw==',
      'valid-usr-x',
      'Bearer a b',
    ),
  }),
  fc.record({ kind: fc.constant('userToken' as const), pick: fc.nat(), scheme: arbScheme }),
  fc.record({ kind: fc.constant('unknownUser' as const), userId: arbUserId }),
  fc.record({
    kind: fc.constant('forgedToken' as const),
    token: fc.stringMatching(/^[a-z][A-Za-z0-9.]{0,20}$/).filter((t) => !t.startsWith('valid-')),
  }),
  fc.record({
    kind: fc.constant('machine' as const),
    pick: fc.nat(),
    correctSecret: fc.boolean(),
    wrong: arbSecret,
    scheme: arbScheme,
  }),
  fc.record({ kind: fc.constant('unknownMachine' as const), keyId: arbKeyId, secret: arbSecret }),
  fc.record({
    kind: fc.constant('malformedMachine' as const),
    value: fc.constantFrom('oem_', 'oem_mk-1', 'oem_mk-1_', 'oem__secret'),
  }),
);

function pickFrom<T>(items: readonly T[], pick: number): T | undefined {
  return items.length === 0 ? undefined : items[pick % items.length];
}

/** Concrete header for a spec; the user/key pool is the initial one (also removed entries). */
function header(
  spec: HeaderSpec,
  users: readonly string[],
  keys: World['machines'],
): string | undefined {
  switch (spec.kind) {
    case 'raw':
      return spec.value;
    case 'userToken': {
      const userId = pickFrom(users, spec.pick) ?? 'usr-none';
      return `${spec.scheme}valid-${userId}`;
    }
    case 'unknownUser':
      return `Bearer valid-${spec.userId}_x`; // `_` never occurs in generated user ids
    case 'forgedToken':
      return `Bearer ${spec.token}`;
    case 'machine': {
      const entry = pickFrom([...keys.values()], spec.pick);
      if (entry === undefined) return `Bearer oem_mk-none_${spec.wrong}`;
      const secret = spec.correctSecret || spec.wrong === entry.secret ? entry.secret : spec.wrong;
      return `${spec.scheme}oem_${entry.record.keyId}_${secret}`;
    }
    case 'unknownMachine':
      return `Bearer oem_${spec.keyId}x_${spec.secret}`; // `x` suffix: not a generated key id
    case 'malformedMachine':
      return `Bearer ${spec.value}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Reference model
// ---------------------------------------------------------------------------------------------

const fail = (code: string): Expected => ({ ok: false, code });

function agencyCheck(world: World, agencyId: string): Expected | null {
  const state = world.agencies.get(agencyId);
  if (state === undefined) return fail('AUTH_INVALID');
  if (state === 'SUSPENDED') return fail('AGENCY_SUSPENDED');
  return null;
}

function expected(world: World, authorization: string | undefined, now: number): Expected {
  if (authorization === undefined || authorization.trim() === '') return fail('AUTH_MISSING');
  const match = /^bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization);
  if (match === null) return fail('AUTH_INVALID');
  const credential = match[1] as string;

  if (credential.startsWith('oem_')) {
    const rest = credential.slice('oem_'.length);
    const sep = rest.indexOf('_');
    if (sep <= 0 || sep === rest.length - 1) return fail('AUTH_INVALID');
    const entry = world.machines.get(rest.slice(0, sep));
    if (entry === undefined || entry.record.revokedAt !== undefined) return fail('AUTH_INVALID');
    if (entry.secret !== rest.slice(sep + 1)) return fail('AUTH_INVALID');
    const { record } = entry;
    if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now) {
      return fail('MACHINE_ACCESS_EXPIRED');
    }
    return (
      agencyCheck(world, record.agencyId) ?? {
        ok: true,
        value: {
          kind: 'machine',
          keyId: record.keyId,
          label: record.label,
          agencyId: record.agencyId,
          permissions: [...record.permissions],
        },
      }
    );
  }

  if (!credential.startsWith('valid-')) return fail('AUTH_INVALID');
  const membership = world.memberships.get(credential.slice('valid-'.length));
  if (membership === undefined) return fail('AUTH_INVALID');
  const { userId, displayName, role, agencyId } = membership;
  if (role === 'PLATFORM_ADMIN') {
    return { ok: true, value: { kind: 'user', userId, displayName, role } };
  }
  if (agencyId === undefined) return fail('AUTH_INVALID');
  return (
    agencyCheck(world, agencyId) ?? {
      ok: true,
      value: { kind: 'user', userId, displayName, role, agencyId },
    }
  );
}

// ---------------------------------------------------------------------------------------------
// Changes (membership, revocation, suspension)
// ---------------------------------------------------------------------------------------------

type Change =
  | { kind: 'changeRole'; pick: number; to: AgencyRole }
  | { kind: 'removeMembership'; pick: number }
  | { kind: 'addMembership'; userId: string; role: MembershipRecord['role']; agencyPick: number }
  | { kind: 'revoke'; pick: number }
  | { kind: 'setAgencyState'; pick: number; state: AgencyState };

const arbChange: fc.Arbitrary<Change> = fc.oneof(
  fc.record({
    kind: fc.constant('changeRole' as const),
    pick: fc.nat(),
    to: fc.constantFrom(...AGENCY_ROLES),
  }),
  fc.record({ kind: fc.constant('removeMembership' as const), pick: fc.nat() }),
  fc.record({
    kind: fc.constant('addMembership' as const),
    userId: arbUserId,
    role: fc.constantFrom('PLATFORM_ADMIN' as const, ...AGENCY_ROLES),
    agencyPick: fc.nat(),
  }),
  fc.record({ kind: fc.constant('revoke' as const), pick: fc.nat() }),
  fc.record({
    kind: fc.constant('setAgencyState' as const),
    pick: fc.nat(),
    state: fc.constantFrom(...AGENCY_STATES),
  }),
);

interface Step {
  change: Change;
  /** Optional authentication round shortly after the change (warms caches mid-period). */
  warmAfterMs: number | null;
  /** Additional time beyond the 60 s cache period before the assertion. */
  extraMs: number;
}

const arbStep: fc.Arbitrary<Step> = fc.record({
  change: arbChange,
  warmAfterMs: fc.option(fc.integer({ min: 0, max: CACHE_TTL_MS - 1 }), { nil: null }),
  extraMs: fc.integer({ min: 0, max: 30_000 }),
});

interface Stores {
  agencies: InMemoryAgencyStore;
  memberships: InMemoryMembershipStore;
  machineAccesses: InMemoryMachineAccessStore;
}

/** Applies a change to model and stores alike. */
async function applyChange(
  change: Change,
  world: World,
  stores: Stores,
  scenario: Scenario,
  clock: SimulatedClock,
): Promise<void> {
  switch (change.kind) {
    case 'changeRole': {
      const members = [...world.memberships.values()].filter(
        (m): m is MembershipRecord & { agencyId: string } => m.agencyId !== undefined,
      );
      const target = pickFrom(members, change.pick);
      if (target === undefined) return;
      const op = stores.memberships.changeRoleOp(
        target.userId,
        target.agencyId,
        target.role as AgencyRole,
        change.to,
      );
      if (!op.check()) throw new Error('model and store diverged (changeRole)');
      op.apply();
      world.memberships.set(target.userId, { ...target, role: change.to });
      return;
    }
    case 'removeMembership': {
      const target = pickFrom([...world.memberships.values()], change.pick);
      if (target === undefined) return;
      const expectedAssignment =
        target.role === 'PLATFORM_ADMIN'
          ? { role: 'PLATFORM_ADMIN' as const }
          : { role: target.role, agencyId: target.agencyId as string };
      const op = stores.memberships.deleteOp(target.userId, expectedAssignment);
      if (!op.check()) throw new Error('model and store diverged (removeMembership)');
      op.apply();
      world.memberships.delete(target.userId);
      return;
    }
    case 'addMembership': {
      if (world.memberships.has(change.userId)) return;
      const record: MembershipRecord = {
        userId: change.userId,
        email: `${change.userId}@example.test`,
        displayName: `User ${change.userId}`,
        role: change.role,
        ...(change.role !== 'PLATFORM_ADMIN' && {
          agencyId: pickAgency(scenario, change.agencyPick),
        }),
        createdAt: CREATED,
      };
      const op = stores.memberships.createOp(record);
      if (!op.check()) throw new Error('model and store diverged (addMembership)');
      op.apply();
      world.memberships.set(record.userId, record);
      return;
    }
    case 'revoke': {
      const entry = pickFrom([...world.machines.values()], change.pick);
      if (entry === undefined) return;
      const revokedAt = entry.record.revokedAt ?? clock.nowIso();
      await stores.machineAccesses.revoke(entry.record.keyId, clock.nowIso());
      world.machines.set(entry.record.keyId, { ...entry, record: { ...entry.record, revokedAt } });
      return;
    }
    case 'setAgencyState': {
      const agencyId = pickFrom([...world.agencies.keys()], change.pick) as string;
      await stores.agencies.update(agencyId, { state: change.state });
      world.agencies.set(agencyId, change.state);
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------------------------

const normalize = (result: Awaited<ReturnType<CachingAuthenticator['authenticate']>>): Expected =>
  result.ok ? { ok: true, value: result.value } : { ok: false, code: result.error.code };

describe('Property 4: Authentifizierungsergebnis', () => {
  it('matches the reference model and reflects changes within 60 s', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbScenario,
        fc.array(arbHeaderSpec, { minLength: 1, maxLength: 12 }),
        fc.array(arbStep, { maxLength: 5 }),
        async (scenario, specs, steps) => {
          const world = buildWorld(scenario);
          const clock = new SimulatedClock(scenario.start);
          const stores: Stores = {
            agencies: new InMemoryAgencyStore(
              [...world.agencies].map(([id, state]) => agencyRecord(id, state)),
            ),
            memberships: new InMemoryMembershipStore([...world.memberships.values()]),
            machineAccesses: new InMemoryMachineAccessStore(
              [...world.machines.values()].map((m) => m.record),
            ),
          };
          const authenticator = new CachingAuthenticator({
            tokenVerifier: verifier,
            ...stores,
            clock: () => clock.now(),
          });
          // Header pool is fixed up front; later changes may remove or add the referenced entries.
          const userPool = [
            ...scenario.users.map((u) => u.userId),
            ...steps.flatMap((s) => (s.change.kind === 'addMembership' ? [s.change.userId] : [])),
          ];
          const headers = specs.map((spec) => header(spec, userPool, world.machines));

          const assertAll = async (): Promise<void> => {
            for (const h of headers) {
              expect(normalize(await authenticator.authenticate(h))).toEqual(
                expected(world, h, clock.now()),
              );
            }
          };

          await assertAll();
          for (const step of steps) {
            await applyChange(step.change, world, stores, scenario, clock);
            let elapsed = 0;
            if (step.warmAfterMs !== null) {
              clock.advance(step.warmAfterMs);
              elapsed = step.warmAfterMs;
              for (const h of headers) await authenticator.authenticate(h);
            }
            // At the latest 60 s after the change the new result holds.
            clock.advance(CACHE_TTL_MS - elapsed + step.extraMs);
            await assertAll();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
