import {
  agencyScope,
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
  type AgencyRecord,
  type InMemoryOp,
  type MembershipRecord,
  type Transactor,
} from '@open-estate/core';
import type { Principal } from '@open-estate/shared';

const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const CREATED = '2026-01-01T00:00:00.000Z';

const platform: AgencyActor = {
  principal: { kind: 'user', userId: 'pa-1', displayName: 'Root', role: 'PLATFORM_ADMIN' },
  channel: 'ADMIN',
};
const agencyUser = (role: 'AGENCY_ADMIN' | 'AGENCY_MEMBER', agencyId = 'a1'): AgencyActor => ({
  principal: { kind: 'user', userId: `${role}-${agencyId}`, displayName: 'U', role, agencyId },
  channel: 'PORTAL',
});
const machine: AgencyActor = {
  principal: {
    kind: 'machine',
    keyId: 'k1',
    label: 'CRM',
    agencyId: 'a1',
    permissions: ['listing:read'],
  } satisfies Principal,
  channel: 'API',
};

const agency = (agencyId: string, overrides: Partial<AgencyRecord> = {}): AgencyRecord => ({
  agencyId,
  displayName: `Agency ${agencyId}`,
  state: 'ACTIVE',
  createdAt: CREATED,
  agencyAdmins: 0,
  ...overrides,
});

const member = (
  userId: string,
  role: MembershipRecord['role'],
  agencyId?: string,
): MembershipRecord => ({
  userId,
  email: `${userId}@example.org`,
  displayName: userId,
  role,
  ...(agencyId !== undefined && { agencyId }),
  createdAt: CREATED,
});

function setup({
  agencies = [agency('a1', { agencyAdmins: 1 }), agency('a2', { agencyAdmins: 0 })],
  memberships = [member('pa-1', 'PLATFORM_ADMIN'), member('adm-1', 'AGENCY_ADMIN', 'a1')],
  platformAdmins = 1,
  transactor = new InMemoryTransactor() as Transactor<InMemoryOp>,
} = {}) {
  const deps = {
    agencies: new InMemoryAgencyStore(agencies),
    memberships: new InMemoryMembershipStore(memberships),
    platformCounters: new InMemoryPlatformCounterStore({ platformAdmins }),
    identity: new InMemoryIdentityDirectory([
      { userId: 'known-1', email: 'known@example.org', displayName: 'Known' },
      { userId: 'adm-1', email: 'adm-1@example.org', displayName: 'adm-1' },
    ]),
    audit: new InMemoryAuditService({ now: () => T0 }),
  };
  const service = new MembershipService({ ...deps, transactor, clock: () => T0 });
  return { ...deps, service };
}

const codes = (result: { ok: boolean; error?: { code: string }[] }) =>
  result.ok ? [] : result.error?.map((e) => e.code);

describe('MembershipService.addMember', () => {
  it('adds a known user with the role and counts the admin in the same transaction', async () => {
    const { service, memberships, agencies, identity, audit } = setup();
    const result = await service.addMember(platform, 'a1', {
      email: 'known@example.org',
      role: 'AGENCY_ADMIN',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        userId: 'known-1',
        email: 'known@example.org',
        displayName: 'Known',
        role: 'AGENCY_ADMIN',
        agencyId: 'a1',
        createdAt: new Date(T0).toISOString(),
      },
    });
    expect((await memberships.get('known-1'))?.role).toBe('AGENCY_ADMIN');
    expect((await agencies.get('a1'))?.agencyAdmins).toBe(2);
    expect(identity.invited).toEqual([]);
    expect(audit.entries).toMatchObject([
      {
        category: 'management',
        action: 'member.add',
        target: 'member/known-1',
        agencyId: 'a1',
        channel: 'ADMIN',
        actor: { kind: 'user', userId: 'pa-1' },
        result: 'SUCCESS',
      },
    ]);
  });

  it('invites an unknown e-mail address (Req 1.5) and never audits the address', async () => {
    const { service, identity, memberships, agencies, audit } = setup();
    const result = await service.addMember(agencyUser('AGENCY_ADMIN'), 'a1', {
      email: 'new@example.org',
      role: 'AGENCY_MEMBER',
    });
    expect(result.ok).toBe(true);
    expect(identity.invited).toEqual(['new@example.org']);
    expect((await memberships.get('invited-1'))?.agencyId).toBe('a1');
    expect((await agencies.get('a1'))?.agencyAdmins).toBe(1);
    expect(JSON.stringify(audit.entries)).not.toContain('new@example.org');
  });

  it('rejects a user who already has a membership (Req 1.2)', async () => {
    const { service, memberships, agencies } = setup();
    const result = await service.addMember(platform, 'a2', {
      email: 'adm-1@example.org',
      role: 'AGENCY_ADMIN',
    });
    expect(codes(result)).toEqual(['USER_ALREADY_ASSIGNED']);
    expect((await memberships.get('adm-1'))?.agencyId).toBe('a1');
    expect((await agencies.get('a2'))?.agencyAdmins).toBe(0);
  });

  it('maps a concurrent assignment (failed create condition) to USER_ALREADY_ASSIGNED', async () => {
    const transactor = new InMemoryTransactor();
    const { service, memberships } = setup({ transactor });
    // Another call assigns the user between the pre-check and the transaction.
    jest.spyOn(transactor, 'transact').mockImplementationOnce(async (ops) => {
      await new InMemoryTransactor().transact([
        memberships.createOp(member('known-1', 'AGENCY_MEMBER', 'a1')),
      ]);
      return new InMemoryTransactor().transact(ops);
    });
    const result = await service.addMember(platform, 'a1', {
      email: 'known@example.org',
      role: 'AGENCY_ADMIN',
    });
    expect(codes(result)).toEqual(['USER_ALREADY_ASSIGNED']);
    expect((await memberships.get('known-1'))?.role).toBe('AGENCY_MEMBER');
  });

  it('requires the first member of an agency to be an AGENCY_ADMIN', async () => {
    const { service, memberships } = setup();
    const member = await service.addMember(platform, 'a2', {
      email: 'known@example.org',
      role: 'AGENCY_MEMBER',
    });
    expect(codes(member)).toEqual(['LAST_AGENCY_ADMIN']);
    expect(await memberships.get('known-1')).toBeNull();
    const admin = await service.addMember(platform, 'a2', {
      email: 'known@example.org',
      role: 'AGENCY_ADMIN',
    });
    expect(admin.ok).toBe(true);
  });

  it.each([
    ['foreign agency', agencyUser('AGENCY_ADMIN', 'a2'), 'a1', 'NOT_FOUND'],
    ['agency member', agencyUser('AGENCY_MEMBER'), 'a1', 'FORBIDDEN'],
    ['machine access', machine, 'a1', 'FORBIDDEN'],
    ['unknown agency', platform, 'nope', 'NOT_FOUND'],
  ])('rejects %s without change and audits it', async (_, actor, agencyId, code) => {
    const { service, identity, memberships, audit } = setup();
    const result = await service.addMember(actor, agencyId, {
      email: 'new@example.org',
      role: 'AGENCY_ADMIN',
    });
    expect(codes(result)).toEqual([code]);
    expect(identity.invited).toEqual([]);
    expect(await memberships.get('invited-1')).toBeNull();
    expect(audit.entries).toMatchObject([
      {
        action: 'member.add',
        result: code,
        category: code === 'FORBIDDEN' ? 'access-denied' : 'management',
      },
    ]);
  });
});

describe('MembershipService.changeRole', () => {
  it('promotes and demotes while keeping the admin counter exact (Req 1.6)', async () => {
    const { service, memberships, agencies } = setup({
      memberships: [member('adm-1', 'AGENCY_ADMIN', 'a1'), member('m-1', 'AGENCY_MEMBER', 'a1')],
    });
    const promoted = await service.changeRole(platform, 'a1', 'm-1', { role: 'AGENCY_ADMIN' });
    expect(promoted.ok && promoted.value.role).toBe('AGENCY_ADMIN');
    expect((await agencies.get('a1'))?.agencyAdmins).toBe(2);
    const demoted = await service.changeRole(agencyUser('AGENCY_ADMIN'), 'a1', 'adm-1', {
      role: 'AGENCY_MEMBER',
    });
    expect(demoted.ok).toBe(true);
    expect((await memberships.get('adm-1'))?.role).toBe('AGENCY_MEMBER');
    expect((await agencies.get('a1'))?.agencyAdmins).toBe(1);
  });

  it('rejects demoting the last AGENCY_ADMIN with 409 and keeps the state (Req 1.7)', async () => {
    const { service, memberships, agencies, audit } = setup();
    const result = await service.changeRole(platform, 'a1', 'adm-1', { role: 'AGENCY_MEMBER' });
    expect(codes(result)).toEqual(['LAST_AGENCY_ADMIN']);
    expect((await memberships.get('adm-1'))?.role).toBe('AGENCY_ADMIN');
    expect((await agencies.get('a1'))?.agencyAdmins).toBe(1);
    expect(audit.entries).toMatchObject([{ action: 'member.role', result: 'LAST_AGENCY_ADMIN' }]);
  });

  it('treats the current role as a successful no-op', async () => {
    const { service, agencies } = setup();
    const result = await service.changeRole(platform, 'a1', 'adm-1', { role: 'AGENCY_ADMIN' });
    expect(result.ok).toBe(true);
    expect((await agencies.get('a1'))?.agencyAdmins).toBe(1);
  });

  it('answers 404 for users of another agency and Plattform_Admins', async () => {
    const { service } = setup();
    expect(
      codes(await service.changeRole(platform, 'a2', 'adm-1', { role: 'AGENCY_ADMIN' })),
    ).toEqual(['NOT_FOUND']);
    expect(
      codes(await service.changeRole(platform, 'a1', 'pa-1', { role: 'AGENCY_ADMIN' })),
    ).toEqual(['NOT_FOUND']);
  });

  it('re-plans after a concurrent change of the same membership', async () => {
    const transactor = new InMemoryTransactor();
    const { service, memberships, agencies } = setup({
      memberships: [member('adm-1', 'AGENCY_ADMIN', 'a1'), member('m-1', 'AGENCY_MEMBER', 'a1')],
      transactor,
    });
    // Concurrently, m-1 is promoted; the planned MEMBER → ADMIN change then fails its condition.
    jest.spyOn(transactor, 'transact').mockImplementationOnce(async (ops) => {
      await new InMemoryTransactor().transact([
        memberships.changeRoleOp('m-1', 'a1', 'AGENCY_MEMBER', 'AGENCY_ADMIN'),
        agencies.adjustAdminsOp('a1', 1),
      ]);
      return new InMemoryTransactor().transact(ops);
    });
    const result = await service.changeRole(platform, 'a1', 'm-1', { role: 'AGENCY_ADMIN' });
    expect(result.ok).toBe(true);
    expect((await agencies.get('a1'))?.agencyAdmins).toBe(2);
  });
});

describe('MembershipService.removeMember', () => {
  it('removes a member; dryRun reports one user and changes nothing (Req 10.8)', async () => {
    const { service, memberships, audit } = setup({
      memberships: [member('adm-1', 'AGENCY_ADMIN', 'a1'), member('m-1', 'AGENCY_MEMBER', 'a1')],
    });
    const preview = await service.removeMember(platform, 'a1', 'm-1', { dryRun: true });
    expect(preview).toEqual({ ok: true, value: { dryRun: true, affectedUsers: 1 } });
    expect(await memberships.get('m-1')).not.toBeNull();
    expect(audit.entries).toEqual([]);

    const removed = await service.removeMember(platform, 'a1', 'm-1');
    expect(removed.ok && removed.value).toMatchObject({ dryRun: false, value: { userId: 'm-1' } });
    expect(await memberships.get('m-1')).toBeNull();
    expect(audit.entries).toMatchObject([{ action: 'member.remove', target: 'member/m-1' }]);
  });

  it('rejects removing the last AGENCY_ADMIN, also in dryRun (Req 1.7)', async () => {
    const { service, memberships } = setup();
    for (const dryRun of [true, false]) {
      const result = await service.removeMember(platform, 'a1', 'adm-1', { dryRun });
      expect(codes(result)).toEqual(['LAST_AGENCY_ADMIN']);
    }
    expect(await memberships.get('adm-1')).not.toBeNull();
  });

  it('removes an admin while another remains', async () => {
    const { service, agencies } = setup({
      agencies: [agency('a1', { agencyAdmins: 2 })],
      memberships: [member('adm-1', 'AGENCY_ADMIN', 'a1'), member('adm-2', 'AGENCY_ADMIN', 'a1')],
    });
    expect((await service.removeMember(platform, 'a1', 'adm-2')).ok).toBe(true);
    expect((await agencies.get('a1'))?.agencyAdmins).toBe(1);
  });

  it('answers 404 for a user of another agency', async () => {
    const { service } = setup();
    expect(
      codes(await service.removeMember(agencyUser('AGENCY_ADMIN', 'a2'), 'a2', 'adm-1')),
    ).toEqual(['NOT_FOUND']);
  });
});

describe('MembershipService platform admins', () => {
  it('adds a Plattform_Admin without agency and counts it (Req 1.2)', async () => {
    const { service, memberships, platformCounters, audit } = setup();
    const result = await service.addPlatformAdmin(platform, { email: 'known@example.org' });
    expect(result.ok && result.value).toMatchObject({ userId: 'known-1', role: 'PLATFORM_ADMIN' });
    expect((await memberships.get('known-1'))?.agencyId).toBeUndefined();
    expect(await platformCounters.platformAdmins()).toBe(2);
    expect(audit.entries).toMatchObject([
      { action: 'platform-admin.add', target: 'platform-admin/known-1', result: 'SUCCESS' },
    ]);
    expect(audit.entries[0]).not.toHaveProperty('agencyId');
  });

  it('rejects agency users as Plattform_Admin (Req 1.2)', async () => {
    const { service, platformCounters } = setup();
    const result = await service.addPlatformAdmin(platform, { email: 'adm-1@example.org' });
    expect(codes(result)).toEqual(['USER_ALREADY_ASSIGNED']);
    expect(await platformCounters.platformAdmins()).toBe(1);
  });

  it('rejects revoking the last Plattform_Admin, also in dryRun (Req 10.9)', async () => {
    const { service, memberships } = setup();
    for (const dryRun of [true, false]) {
      const result = await service.removePlatformAdmin(platform, 'pa-1', { dryRun });
      expect(codes(result)).toEqual(['LAST_PLATFORM_ADMIN']);
    }
    expect(await memberships.get('pa-1')).not.toBeNull();
  });

  it('revokes a Plattform_Admin while another remains; dryRun counts one user', async () => {
    const { service, memberships, platformCounters } = setup({
      memberships: [member('pa-1', 'PLATFORM_ADMIN'), member('pa-2', 'PLATFORM_ADMIN')],
      platformAdmins: 2,
    });
    expect(await service.removePlatformAdmin(platform, 'pa-2', { dryRun: true })).toEqual({
      ok: true,
      value: { dryRun: true, affectedUsers: 1 },
    });
    expect((await service.removePlatformAdmin(platform, 'pa-2')).ok).toBe(true);
    expect(await memberships.get('pa-2')).toBeNull();
    expect(await platformCounters.platformAdmins()).toBe(1);
  });

  it('answers 404 when the user is no Plattform_Admin', async () => {
    const { service } = setup();
    expect(codes(await service.removePlatformAdmin(platform, 'adm-1'))).toEqual(['NOT_FOUND']);
  });

  it('denies agency actors with FORBIDDEN, audited even for dryRun', async () => {
    const { service, audit } = setup();
    const actor = agencyUser('AGENCY_ADMIN');
    expect(codes(await service.listPlatformAdmins(actor, { limit: 10 }))).toEqual(['FORBIDDEN']);
    expect(codes(await service.addPlatformAdmin(actor, { email: 'known@example.org' }))).toEqual([
      'FORBIDDEN',
    ]);
    expect(codes(await service.removePlatformAdmin(actor, 'pa-1', { dryRun: true }))).toEqual([
      'FORBIDDEN',
    ]);
    expect(audit.entries.map((e) => [e.category, e.action, e.result])).toEqual([
      ['access-denied', 'platform-admin.list', 'FORBIDDEN'],
      ['access-denied', 'platform-admin.add', 'FORBIDDEN'],
      ['access-denied', 'platform-admin.remove', 'FORBIDDEN'],
    ]);
  });

  it('lists Plattform_Admins and agency members', async () => {
    const { service } = setup();
    const admins = await service.listPlatformAdmins(platform, { limit: 10 });
    expect(admins.ok && admins.value.items.map((m) => m.userId)).toEqual(['pa-1']);
    const members = await service.listMembers(agencyUser('AGENCY_ADMIN'), 'a1', { limit: 10 });
    expect(members.ok && members.value.items.map((m) => m.userId)).toEqual(['adm-1']);
    expect(
      codes(await service.listMembers(agencyUser('AGENCY_ADMIN'), 'a2', { limit: 10 })),
    ).toEqual(['NOT_FOUND']);
  });
});

describe('AgencyService', () => {
  function agencySetup() {
    const agencies = new InMemoryAgencyStore([agency('a1', { agencyAdmins: 1 })]);
    const memberships = new InMemoryMembershipStore([
      member('adm-1', 'AGENCY_ADMIN', 'a1'),
      member('m-1', 'AGENCY_MEMBER', 'a1'),
      member('m-2', 'AGENCY_MEMBER', 'a1'),
    ]);
    const counters = new InMemoryMetricCounterStore();
    const audit = new InMemoryAuditService({ now: () => T0 });
    let next = 0;
    const service = new AgencyService({
      agencies,
      memberships,
      counters,
      audit,
      clock: () => T0,
      newId: () => `agy-${++next}`,
    });
    return { service, agencies, counters, audit };
  }

  it('creates an ACTIVE agency and returns its id (Req 1.1, 1.4)', async () => {
    const { service, agencies, audit } = agencySetup();
    const result = await service.create(platform, { displayName: 'Maklerbüro' });
    expect(result).toEqual({
      ok: true,
      value: {
        agencyId: 'agy-1',
        displayName: 'Maklerbüro',
        state: 'ACTIVE',
        createdAt: new Date(T0).toISOString(),
      },
    });
    expect((await agencies.get('agy-1'))?.agencyAdmins).toBe(0);
    expect(audit.entries).toMatchObject([
      { action: 'agency.create', target: 'agency/agy-1', agencyId: 'agy-1', result: 'SUCCESS' },
    ]);
  });

  it('only lets Plattform_Admins create agencies', async () => {
    const { service, agencies } = agencySetup();
    const result = await service.create(agencyUser('AGENCY_ADMIN'), { displayName: 'X' });
    expect(codes(result)).toEqual(['FORBIDDEN']);
    expect(await agencies.get('agy-1')).toBeNull();
  });

  it('dryRun of a suspension counts listings of all statuses and members (Req 10.8)', async () => {
    const { service, agencies, counters, audit } = agencySetup();
    await counters.add({ scope: agencyScope('a1'), code: 'listing.status.ACTIVE', delta: 5 });
    await counters.add({ scope: agencyScope('a1'), code: 'listing.status.INACTIVE', delta: 2 });
    await counters.add({ scope: agencyScope('a2'), code: 'listing.status.ACTIVE', delta: 9 });
    const result = await service.update(platform, 'a1', { state: 'SUSPENDED' }, { dryRun: true });
    expect(result).toEqual({
      ok: true,
      value: { dryRun: true, affectedListings: 7, affectedUsers: 3 },
    });
    expect((await agencies.get('a1'))?.state).toBe('ACTIVE');
    expect(audit.entries).toEqual([]);
  });

  it('suspends and reactivates without touching anything but the state (Req 1.8, 1.9)', async () => {
    const { service, agencies, audit } = agencySetup();
    const suspended = await service.update(platform, 'a1', { state: 'SUSPENDED' });
    expect(suspended.ok && suspended.value).toMatchObject({
      dryRun: false,
      value: { state: 'SUSPENDED' },
    });
    expect((await agencies.get('a1'))?.agencyAdmins).toBe(1);
    const reactivated = await service.update(platform, 'a1', { state: 'ACTIVE' });
    expect(reactivated.ok && reactivated.value).toMatchObject({ value: { state: 'ACTIVE' } });
    expect(audit.entries.map((e) => e.action)).toEqual(['agency.suspend', 'agency.reactivate']);
  });

  it('dryRun of a rename reports nothing affected', async () => {
    const { service } = agencySetup();
    const result = await service.update(platform, 'a1', { displayName: 'Neu' }, { dryRun: true });
    expect(result).toEqual({
      ok: true,
      value: { dryRun: true, affectedListings: 0, affectedUsers: 0 },
    });
  });

  it('denies agency actors: own agency FORBIDDEN, foreign agency NOT_FOUND', async () => {
    const { service, agencies } = agencySetup();
    expect(
      codes(await service.update(agencyUser('AGENCY_ADMIN'), 'a1', { state: 'SUSPENDED' })),
    ).toEqual(['FORBIDDEN']);
    expect(
      codes(await service.update(agencyUser('AGENCY_ADMIN', 'a2'), 'a1', { state: 'SUSPENDED' })),
    ).toEqual(['NOT_FOUND']);
    expect(codes(await service.update(platform, 'nope', { state: 'SUSPENDED' }))).toEqual([
      'NOT_FOUND',
    ]);
    expect((await agencies.get('a1'))?.state).toBe('ACTIVE');
  });

  it('lets actors read their own agency only', async () => {
    const { service } = agencySetup();
    expect((await service.get(agencyUser('AGENCY_MEMBER'), 'a1')).ok).toBe(true);
    expect((await service.get(machine, 'a1')).ok).toBe(true);
    expect(codes(await service.get(agencyUser('AGENCY_MEMBER', 'a2'), 'a1'))).toEqual([
      'NOT_FOUND',
    ]);
    expect((await service.get(platform, 'a1')).ok).toBe(true);
  });
});
