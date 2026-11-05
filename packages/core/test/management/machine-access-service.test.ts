import {
  hashMachineSecret,
  InMemoryAgencyStore,
  InMemoryMachineAccessStore,
  MachineAccessService,
  type MachineAccessActor,
  type MachineAccessAuditEntry,
} from '@open-estate/core';
import { CreateMachineAccessRequest, MachineAccessView, type Principal } from '@open-estate/shared';

const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const ADMIN: Principal = {
  kind: 'user',
  userId: 'u-admin',
  displayName: 'Ada',
  role: 'AGENCY_ADMIN',
  agencyId: 'agy-1',
};
const MEMBER: Principal = { ...ADMIN, userId: 'u-member', role: 'AGENCY_MEMBER' };
const PLATFORM: Principal = {
  kind: 'user',
  userId: 'u-root',
  displayName: 'Root',
  role: 'PLATFORM_ADMIN',
};
const portal = (principal: Principal): MachineAccessActor => ({ principal, channel: 'PORTAL' });

const request = (overrides: Record<string, unknown> = {}) =>
  CreateMachineAccessRequest.parse({
    label: 'CRM',
    permissions: ['listing:read', 'listing:write'],
    ...overrides,
  });

function setup() {
  let now = T0;
  const store = new InMemoryMachineAccessStore();
  const agencies = new InMemoryAgencyStore(
    ['agy-1', 'agy-2'].map((agencyId) => ({
      agencyId,
      displayName: agencyId,
      state: 'ACTIVE' as const,
      createdAt: new Date(T0).toISOString(),
      agencyAdmins: 1,
    })),
  );
  const entries: MachineAccessAuditEntry[] = [];
  const service = new MachineAccessService({
    store,
    agencies,
    audit: { append: async (entry) => void entries.push(entry) },
    clock: () => now,
  });
  return { service, store, entries, advance: (ms: number) => (now += ms) };
}

describe('MachineAccessService.create', () => {
  it('returns the credential once and stores only its SHA-256 hash', async () => {
    const { service, store, entries } = setup();
    const result = await service.create(portal(ADMIN), 'agy-1', request());
    if (!result.ok) throw new Error(JSON.stringify(result.error));

    const { secret, ...view } = result.value;
    const match = /^oem_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/.exec(secret);
    expect(match).not.toBeNull();
    const [, keyId, rawSecret] = match as unknown as [string, string, string];
    expect(Buffer.from(rawSecret, 'base64url')).toHaveLength(32);

    expect(view).toEqual({
      keyId,
      agencyId: 'agy-1',
      label: 'CRM',
      permissions: ['listing:read', 'listing:write'],
      createdBy: 'u-admin',
      createdAt: '2026-03-01T10:00:00.000Z',
    });
    const stored = await store.get(keyId);
    expect(stored?.keyHash).toBe(hashMachineSecret(rawSecret));
    expect(JSON.stringify(stored)).not.toContain(rawSecret);
    expect(entries).toEqual([
      {
        actor: { kind: 'user', userId: 'u-admin', displayName: 'Ada' },
        channel: 'PORTAL',
        action: 'machine-access.create',
        target: `machine-access/${keyId}`,
        agencyId: 'agy-1',
        result: 'SUCCESS',
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain(rawSecret);
  });

  it('issues a distinct key id and secret per access and keeps expiresAt', async () => {
    const { service } = setup();
    const expiresAt = '2027-01-01T00:00:00.000Z';
    const a = await service.create(portal(ADMIN), 'agy-1', request({ expiresAt }));
    const b = await service.create(portal(ADMIN), 'agy-1', request());
    if (!a.ok || !b.ok) throw new Error('creation failed');
    expect(a.value.keyId).not.toBe(b.value.keyId);
    expect(a.value.secret).not.toBe(b.value.secret);
    expect(a.value.expiresAt).toBe(expiresAt);
  });

  it('names every ungrantable permission and stores nothing', async () => {
    const { service, store, entries } = setup();
    const result = await service.create(
      portal(ADMIN),
      'agy-1',
      request({ permissions: ['listing:read', 'member:manage', 'agency:manage', 'member:manage'] }),
    );
    expect(result).toEqual({
      ok: false,
      error: ['member:manage', 'agency:manage'].map((permission) => ({
        code: 'INVALID_PERMISSION',
        message: expect.any(String),
        field: 'permissions',
        details: { permission },
      })),
    });
    expect((await store.listByAgency('agy-1', { limit: 10 })).items).toEqual([]);
    expect(entries.map((e) => e.result)).toEqual(['INVALID_PERMISSION']);
  });

  it.each([
    ['agency member', MEMBER, 'agy-1', 'FORBIDDEN'],
    ['admin of another agency', ADMIN, 'agy-2', 'NOT_FOUND'],
    ['platform admin, unknown agency', PLATFORM, 'agy-x', 'NOT_FOUND'],
  ] as const)('rejects %s', async (_, principal, agencyId, code) => {
    const { service, store, entries } = setup();
    const result = await service.create(portal(principal), agencyId, request());
    expect(result.ok ? null : result.error.map((e) => e.code)).toEqual([code]);
    expect((await store.listByAgency(agencyId, { limit: 10 })).items).toEqual([]);
    expect(entries).toEqual([
      expect.objectContaining({ action: 'machine-access.create', agencyId, result: code }),
    ]);
  });

  it('lets a platform admin create for any existing agency', async () => {
    const { service } = setup();
    const result = await service.create(portal(PLATFORM), 'agy-2', request());
    expect(result.ok && result.value).toMatchObject({ agencyId: 'agy-2', createdBy: 'u-root' });
  });
});

describe('MachineAccessService.revoke', () => {
  it('sets revokedAt once and returns the view without secret', async () => {
    const { service, entries, advance } = setup();
    const created = await service.create(portal(ADMIN), 'agy-1', request());
    if (!created.ok) throw new Error('creation failed');
    const { keyId } = created.value;

    advance(1000);
    const first = await service.revoke(portal(ADMIN), 'agy-1', keyId);
    advance(1000);
    const second = await service.revoke(portal(PLATFORM), 'agy-1', keyId);

    expect(first.ok && first.value.revokedAt).toBe('2026-03-01T10:00:01.000Z');
    expect(second.ok && second.value.revokedAt).toBe('2026-03-01T10:00:01.000Z');
    expect(first.ok && 'secret' in first.value).toBe(false);
    expect(entries.map((e) => [e.action, e.target, e.result])).toEqual([
      ['machine-access.create', `machine-access/${keyId}`, 'SUCCESS'],
      ['machine-access.revoke', `machine-access/${keyId}`, 'SUCCESS'],
      ['machine-access.revoke', `machine-access/${keyId}`, 'SUCCESS'],
    ]);
  });

  it('answers NOT_FOUND for unknown or foreign accesses and FORBIDDEN without permission', async () => {
    const { service, store } = setup();
    const created = await service.create(portal(ADMIN), 'agy-1', request());
    if (!created.ok) throw new Error('creation failed');
    const { keyId } = created.value;
    const other: Principal = { ...ADMIN, userId: 'u-2', agencyId: 'agy-2' };

    const codes = async (principal: Principal, agencyId: string, id: string) => {
      const result = await service.revoke(portal(principal), agencyId, id);
      return result.ok ? null : result.error.map((e) => e.code);
    };
    expect(await codes(ADMIN, 'agy-1', 'unknown')).toEqual(['NOT_FOUND']);
    expect(await codes(other, 'agy-2', keyId)).toEqual(['NOT_FOUND']);
    expect(await codes(other, 'agy-1', keyId)).toEqual(['NOT_FOUND']);
    expect(await codes(MEMBER, 'agy-1', keyId)).toEqual(['FORBIDDEN']);
    expect(await codes(MEMBER, 'agy-1', 'unknown')).toEqual(['FORBIDDEN']);
    expect((await store.get(keyId))?.revokedAt).toBeUndefined();
  });
});

describe('MachineAccessService.list', () => {
  it('lists the agency accesses with all Req 3.7 fields and without secret or hash', async () => {
    const { service, store } = setup();
    const a = await service.create(portal(ADMIN), 'agy-1', request({ label: 'A' }));
    await service.create(portal(PLATFORM), 'agy-2', request({ label: 'B' }));
    if (!a.ok) throw new Error('creation failed');
    await service.revoke(portal(ADMIN), 'agy-1', a.value.keyId);
    await store.touchLastUsed(a.value.keyId, T0);

    const result = await service.list(portal(ADMIN), 'agy-1', { limit: 10 });
    if (!result.ok) throw new Error('list failed');
    expect(result.value.items).toHaveLength(1);
    const [item] = result.value.items;
    expect(MachineAccessView.strict().parse(item)).toEqual(item);
    expect(item).toMatchObject({
      label: 'A',
      revokedAt: expect.any(String),
      lastUsedAt: expect.any(String),
    });
    expect(JSON.stringify(item)).not.toContain(a.value.secret.split('_').slice(2).join('_'));
  });

  it('rejects members and foreign agencies', async () => {
    const { service } = setup();
    const member = await service.list(portal(MEMBER), 'agy-1', { limit: 10 });
    const foreign = await service.list(portal(ADMIN), 'agy-2', { limit: 10 });
    expect(member.ok ? null : member.error[0]?.code).toBe('FORBIDDEN');
    expect(foreign.ok ? null : foreign.error[0]?.code).toBe('NOT_FOUND');
  });
});
