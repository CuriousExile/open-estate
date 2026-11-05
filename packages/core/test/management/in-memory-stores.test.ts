import {
  InMemoryAgencyStore,
  InMemoryMachineAccessStore,
  InMemoryMembershipStore,
  InMemoryPlatformCounterStore,
  InMemoryTransactor,
  InvalidCursorError,
  membershipRecordSchema,
  type AgencyRecord,
  type MachineAccessRecord,
  type MembershipRecord,
} from '@open-estate/core';

const CREATED = '2026-01-01T00:00:00Z';

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
  email: `${userId}@example.test`,
  displayName: userId,
  role,
  ...(agencyId !== undefined && { agencyId }),
  createdAt: CREATED,
});

describe('management fakes with transaction semantics', () => {
  const tx = new InMemoryTransactor();

  it('adds an agency admin and its counter atomically', async () => {
    const agencies = new InMemoryAgencyStore([agency('a1')]);
    const memberships = new InMemoryMembershipStore();
    const result = await tx.transact([
      memberships.createOp(member('u1', 'AGENCY_ADMIN', 'a1')),
      agencies.adjustAdminsOp('a1', 1),
    ]);
    expect(result.ok).toBe(true);
    expect((await agencies.get('a1'))?.agencyAdmins).toBe(1);
    expect((await memberships.get('u1'))?.role).toBe('AGENCY_ADMIN');
  });

  it('rejects a second assignment of a user and keeps the state (Req 1.2)', async () => {
    const agencies = new InMemoryAgencyStore([agency('a1'), agency('a2', { agencyAdmins: 1 })]);
    const memberships = new InMemoryMembershipStore([member('u1', 'AGENCY_ADMIN', 'a2')]);
    const result = await tx.transact([
      memberships.createOp(member('u1', 'AGENCY_ADMIN', 'a1')),
      agencies.adjustAdminsOp('a1', 1),
    ]);
    expect(result).toEqual({ ok: false, error: { failed: ['membership.create'] } });
    expect((await agencies.get('a1'))?.agencyAdmins).toBe(0);
    expect((await memberships.get('u1'))?.agencyId).toBe('a2');
  });

  it('rejects demoting the last agency admin and keeps the state', async () => {
    const agencies = new InMemoryAgencyStore([agency('a1', { agencyAdmins: 1 })]);
    const memberships = new InMemoryMembershipStore([member('u1', 'AGENCY_ADMIN', 'a1')]);
    const result = await tx.transact([
      memberships.changeRoleOp('u1', 'a1', 'AGENCY_ADMIN', 'AGENCY_MEMBER'),
      agencies.adjustAdminsOp('a1', -1),
    ]);
    expect(result).toEqual({ ok: false, error: { failed: ['agency.admins'] } });
    expect((await memberships.get('u1'))?.role).toBe('AGENCY_ADMIN');
    expect((await agencies.get('a1'))?.agencyAdmins).toBe(1);
  });

  it('demotes and removes admins while another admin remains', async () => {
    const agencies = new InMemoryAgencyStore([agency('a1', { agencyAdmins: 2 })]);
    const memberships = new InMemoryMembershipStore([
      member('u1', 'AGENCY_ADMIN', 'a1'),
      member('u2', 'AGENCY_ADMIN', 'a1'),
    ]);
    const demoted = await tx.transact([
      memberships.changeRoleOp('u1', 'a1', 'AGENCY_ADMIN', 'AGENCY_MEMBER'),
      agencies.adjustAdminsOp('a1', -1),
    ]);
    expect(demoted.ok).toBe(true);
    expect((await memberships.get('u1'))?.role).toBe('AGENCY_MEMBER');

    const removed = await tx.transact([
      memberships.deleteOp('u1', { role: 'AGENCY_MEMBER', agencyId: 'a1' }),
    ]);
    expect(removed.ok).toBe(true);
    expect(await memberships.get('u1')).toBeNull();
    expect((await agencies.get('a1'))?.agencyAdmins).toBe(1);
  });

  it('fails role change and delete when the stored assignment differs', async () => {
    const memberships = new InMemoryMembershipStore([member('u1', 'AGENCY_MEMBER', 'a1')]);
    const result = await tx.transact([
      memberships.changeRoleOp('u1', 'a2', 'AGENCY_MEMBER', 'AGENCY_ADMIN'),
    ]);
    expect(result.ok).toBe(false);
    const deleted = await tx.transact([
      memberships.deleteOp('u1', { role: 'AGENCY_ADMIN', agencyId: 'a1' }),
    ]);
    expect(deleted.ok).toBe(false);
    expect(await memberships.get('u1')).not.toBeNull();
  });

  it('keeps at least one platform admin (Req 10.9)', async () => {
    const counters = new InMemoryPlatformCounterStore();
    const memberships = new InMemoryMembershipStore();
    await tx.transact([
      memberships.createOp(member('p1', 'PLATFORM_ADMIN')),
      counters.adjustPlatformAdminsOp(1),
    ]);
    expect(await counters.platformAdmins()).toBe(1);

    const result = await tx.transact([
      memberships.deleteOp('p1', { role: 'PLATFORM_ADMIN' }),
      counters.adjustPlatformAdminsOp(-1),
    ]);
    expect(result).toEqual({ ok: false, error: { failed: ['platform.admins'] } });
    expect(await memberships.get('p1')).not.toBeNull();
  });

  it('requires the agency to exist for increments and existence checks', async () => {
    const agencies = new InMemoryAgencyStore();
    const result = await tx.transact([agencies.adjustAdminsOp('missing', 1)]);
    expect(result).toEqual({ ok: false, error: { failed: ['agency.admins'] } });
    expect((await tx.transact([agencies.existsOp('missing')])).ok).toBe(false);
  });
});

describe('InMemoryAgencyStore', () => {
  it('creates, updates and lists agencies by state in key order', async () => {
    const store = new InMemoryAgencyStore([agency('c'), agency('a')]);
    await store.create(agency('b', { state: 'SUSPENDED' }));
    await expect(store.create(agency('b'))).rejects.toThrow('already exists');

    expect(await store.update('a', { state: 'SUSPENDED', displayName: 'Renamed' })).toMatchObject({
      state: 'SUSPENDED',
      displayName: 'Renamed',
    });
    expect(await store.update('missing', { state: 'ACTIVE' })).toBeNull();

    const first = await store.listByState('SUSPENDED', { limit: 1 });
    expect(first.items.map((record) => record.agencyId)).toEqual(['a']);
    expect(first.nextCursor).toBeDefined();
    const second = await store.listByState('SUSPENDED', {
      limit: 1,
      cursor: first.nextCursor ?? '',
    });
    expect(second).toEqual({ items: [expect.objectContaining({ agencyId: 'b' })] });
  });

  it('rejects invalid records and cursors', async () => {
    const store = new InMemoryAgencyStore();
    await expect(store.create(agency('a', { displayName: '' }))).rejects.toThrow();
    await expect(store.listByState('ACTIVE', { limit: 1, cursor: 'not-json' })).rejects.toThrow(
      InvalidCursorError,
    );
  });

  it('returns copies', async () => {
    const store = new InMemoryAgencyStore([agency('a')]);
    const read = await store.get('a');
    if (read !== null) read.displayName = 'mutated';
    expect((await store.get('a'))?.displayName).toBe('Agency a');
  });
});

describe('InMemoryMembershipStore', () => {
  it('lists members of an agency and platform admins separately', async () => {
    const store = new InMemoryMembershipStore([
      member('u2', 'AGENCY_MEMBER', 'a1'),
      member('u1', 'AGENCY_ADMIN', 'a1'),
      member('u3', 'AGENCY_MEMBER', 'a2'),
      member('p1', 'PLATFORM_ADMIN'),
    ]);
    const page = await store.listByAgency('a1', { limit: 10 });
    expect(page.items.map((record) => record.userId)).toEqual(['u1', 'u2']);
    expect(page.nextCursor).toBeUndefined();
    const admins = await store.listPlatformAdmins({ limit: 10 });
    expect(admins.items.map((record) => record.userId)).toEqual(['p1']);
  });

  it('enforces exactly one assignment shape (Req 1.2)', () => {
    expect(membershipRecordSchema.safeParse(member('p', 'PLATFORM_ADMIN', 'a1')).success).toBe(
      false,
    );
    expect(membershipRecordSchema.safeParse(member('u', 'AGENCY_MEMBER')).success).toBe(false);
  });
});

describe('InMemoryMachineAccessStore', () => {
  const access = (keyId: string, agencyId = 'a1'): MachineAccessRecord => ({
    keyId,
    agencyId,
    label: `CRM ${keyId}`,
    keyHash: 'hash',
    permissions: ['listing:read', 'listing:write'],
    createdBy: 'u1',
    createdAt: CREATED,
  });
  const now = Date.parse('2026-02-01T10:00:00Z');

  it('creates, lists by agency and rejects duplicates', async () => {
    const store = new InMemoryMachineAccessStore([access('k2'), access('k3', 'a2')]);
    await store.create(access('k1'));
    await expect(store.create(access('k1'))).rejects.toThrow('already exists');
    const page = await store.listByAgency('a1', { limit: 10 });
    expect(page.items.map((record) => record.keyId)).toEqual(['k1', 'k2']);
  });

  it('revokes once and keeps the first revocation time', async () => {
    const store = new InMemoryMachineAccessStore([access('k1')]);
    expect((await store.revoke('k1', '2026-02-01T00:00:00Z'))?.revokedAt).toBe(
      '2026-02-01T00:00:00Z',
    );
    expect((await store.revoke('k1', '2026-03-01T00:00:00Z'))?.revokedAt).toBe(
      '2026-02-01T00:00:00Z',
    );
    expect(await store.revoke('missing', '2026-02-01T00:00:00Z')).toBeNull();
  });

  it('writes lastUsedAt at most once per interval', async () => {
    const store = new InMemoryMachineAccessStore([access('k1')]);
    expect(await store.touchLastUsed('k1', now)).toBe(true);
    expect(await store.touchLastUsed('k1', now + 59_999)).toBe(false);
    expect((await store.get('k1'))?.lastUsedAt).toBe('2026-02-01T10:00:00.000Z');
    expect(await store.touchLastUsed('k1', now + 60_000)).toBe(true);
    expect((await store.get('k1'))?.lastUsedAt).toBe('2026-02-01T10:01:00.000Z');
    expect(await store.touchLastUsed('missing', now)).toBe(false);
  });
});
