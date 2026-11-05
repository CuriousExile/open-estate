import { GRANTABLE_MACHINE_PERMISSIONS } from '@open-estate/shared';
import de from '../public/i18n/de.json';
import en from '../public/i18n/en.json';
import {
  accessState,
  createErrorsFromApi,
  createMachineAccess,
  EMPTY_CREATE,
  fetchMachineAccesses,
  localToIso,
  permissionKey,
  previewRevocation,
  revocationImpact,
  revokeMachineAccess,
  splitSecret,
  upsertAccess,
  validateCreate,
  type MachineAccess,
} from '../src/app/portal/machine-access/machine-access-model';
import { fakeCaller } from './portal-fake-caller';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const T = '2026-11-05T13:00:00.000Z';
const access = (keyId: string, extra: Partial<MachineAccess> = {}): MachineAccess => ({
  keyId,
  agencyId: 'ag-1',
  label: `CRM ${keyId}`,
  permissions: ['listing:read'],
  createdBy: 'u1',
  createdAt: '2026-11-01T08:00:00.000Z',
  ...extra,
});

describe('machine-access creation form (Req 3.1, 3.3)', () => {
  it('sends label, grantable permissions in platform order and the expiry as ISO time', () => {
    const local = '2027-01-31T18:30';
    expect(
      validateCreate(
        { label: ' CRM ', permissions: ['listing:write', 'listing:read'], expiresAt: local },
        NOW,
      ),
    ).toEqual({
      ok: true,
      request: {
        label: 'CRM',
        permissions: ['listing:read', 'listing:write'],
        expiresAt: new Date(local).toISOString(),
      },
    });
    expect(
      validateCreate({ ...EMPTY_CREATE, label: 'x', permissions: ['audit:read'] }, NOW),
    ).toEqual({ ok: true, request: { label: 'x', permissions: ['audit:read'] } });
  });

  it('rejects a missing label, no or ungrantable permissions and a past expiry', () => {
    expect(validateCreate(EMPTY_CREATE, NOW)).toEqual({
      ok: false,
      errors: [
        {
          field: 'label',
          messageKey: 'portal.machineAccess.error.label',
          params: { min: 1, max: 100 },
        },
        { field: 'permissions', messageKey: 'portal.machineAccess.error.permissions' },
      ],
    });
    expect(
      validateCreate(
        {
          label: 'x',
          permissions: ['listing:read', 'member:manage'],
          expiresAt: '2020-01-01T00:00',
        },
        NOW,
      ),
    ).toMatchObject({ ok: false, errors: [{ field: 'permissions' }, { field: 'expiresAt' }] });
    expect(
      validateCreate({ label: 'x'.repeat(101), permissions: ['listing:read'], expiresAt: '' }, NOW),
    ).toMatchObject({ ok: false, errors: [{ field: 'label' }] });
  });

  it('accepts only complete datetime-local values', () => {
    expect(localToIso('2027-01-31')).toBeUndefined();
    expect(localToIso('garbage')).toBeUndefined();
    expect(localToIso('2027-01-31T08:00')).toBe(new Date('2027-01-31T08:00').toISOString());
  });

  it('maps INVALID_PERMISSION fields of a 400 answer to the permission list', () => {
    expect(createErrorsFromApi(['permissions.1', 'label'])).toEqual([
      {
        field: 'label',
        messageKey: 'portal.machineAccess.error.label',
        params: { min: 1, max: 100 },
      },
      { field: 'permissions', messageKey: 'portal.machineAccess.error.permissions' },
    ]);
  });
});

describe('machine-access Management_API calls (Req 3.1, 3.5, 3.7)', () => {
  it('creates, lists, previews and revokes under the agency path', async () => {
    const created = { ...access('k1'), secret: 'oem_k1_s3cr3t' };
    const { api, calls } = fakeCaller((call) =>
      call.method === 'POST'
        ? created
        : call.method === 'GET'
          ? { items: [access('k1')] }
          : call.query?.['dryRun'] === true
            ? { dryRun: true, affectedListings: 0, affectedUsers: 0 }
            : access('k1', { revokedAt: NOW.toISOString() }),
    );

    const result = await createMachineAccess(api, 'ag-1', {
      label: 'CRM k1',
      permissions: ['listing:read'],
    });
    await fetchMachineAccesses(api, 'ag-1');
    const preview = await previewRevocation(api, 'ag-1', 'k1');
    const revoked = await revokeMachineAccess(api, 'ag-1', 'k1');

    expect(calls.map(({ method, path, query }) => ({ method, path, query }))).toEqual([
      { method: 'POST', path: '/agencies/ag-1/machine-access', query: undefined },
      { method: 'GET', path: '/agencies/ag-1/machine-access', query: { pageToken: undefined } },
      { method: 'DELETE', path: '/agencies/ag-1/machine-access/k1', query: { dryRun: true } },
      { method: 'DELETE', path: '/agencies/ag-1/machine-access/k1', query: undefined },
    ]);
    expect(result.ok && splitSecret(result.value)).toEqual({
      access: access('k1'),
      secret: 'oem_k1_s3cr3t',
    });
    expect(preview.ok && revocationImpact(preview.value)).toEqual([
      { key: 'portal.machineAccess.revoke.affectedUsers', params: { count: 0 } },
      { key: 'portal.machineAccess.revoke.affectedListings', params: { count: 0 } },
    ]);
    expect(revoked.ok && revoked.value.revokedAt).toBe(NOW.toISOString());
  });

  it('keeps the secret out of the listed view', () => {
    const { access: view } = splitSecret({ ...access('k2'), secret: 'oem_k2_x' });
    expect(Object.keys(view)).not.toContain('secret');
    expect(JSON.stringify(upsertAccess([access('k1')], view))).not.toContain('oem_k2_x');
  });
});

describe('machine-access state (Req 3.5–3.7)', () => {
  it('distinguishes active, expired and revoked; revoked wins', () => {
    expect(accessState(access('a'), NOW)).toBe('active');
    expect(accessState(access('a', { expiresAt: '2027-01-01T00:00:00Z' }), NOW)).toBe('active');
    expect(accessState(access('a', { expiresAt: '2026-11-05T11:59:59Z' }), NOW)).toBe('expired');
    expect(
      accessState(
        access('a', { expiresAt: '2026-01-01T00:00:00Z', revokedAt: '2026-02-01T00:00:00Z' }),
        NOW,
      ),
    ).toBe('revoked');
  });

  it('puts a new access first and replaces a revoked one in place', () => {
    const list = [access('k1'), access('k2')];
    expect(upsertAccess(list, access('k3')).map((a) => a.keyId)).toEqual(['k3', 'k1', 'k2']);
    expect(upsertAccess(list, access('k2', { revokedAt: T })).map((a) => a.revokedAt)).toEqual([
      undefined,
      T,
    ]);
  });
});

describe('machine-access translations (Req 5.7)', () => {
  it('labels every grantable permission in both languages', () => {
    for (const permission of GRANTABLE_MACHINE_PERMISSIONS) {
      expect((en as Record<string, string>)[permissionKey(permission)]).toBeTruthy();
      expect((de as Record<string, string>)[permissionKey(permission)]).toBeTruthy();
    }
    const keys = (catalog: object) =>
      Object.keys(catalog)
        .filter((k) => k.startsWith('portal.machineAccess.'))
        .sort();
    expect(keys(en)).toEqual(keys(de));
  });
});
