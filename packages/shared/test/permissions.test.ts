import {
  authorize,
  GRANTABLE_MACHINE_PERMISSIONS,
  PERMISSIONS,
  type Permission,
  type Principal,
  principalPermissions,
  ROLE_PERMISSIONS,
  ungrantableMachinePermissions,
} from '../src';

const member: Principal = {
  kind: 'user',
  userId: 'u1',
  displayName: 'Mia',
  role: 'AGENCY_MEMBER',
  agencyId: 'a1',
};
const agencyAdmin: Principal = { ...member, userId: 'u2', role: 'AGENCY_ADMIN' };
const platformAdmin: Principal = {
  kind: 'user',
  userId: 'u3',
  displayName: 'Pia',
  role: 'PLATFORM_ADMIN',
};
const machine: Principal = {
  kind: 'machine',
  keyId: 'k1',
  label: 'CRM',
  agencyId: 'a1',
  permissions: ['listing:read'],
};

const BASE: Permission[] = [
  'listing:read',
  'listing:write',
  'listing:status',
  'version:restore',
  'monitoring:read',
];
const PLATFORM_ONLY: Permission[] = [
  'agency:manage',
  'platform:operate',
  'monitoring:platform',
  'listing:assign',
];

describe('ROLE_PERMISSIONS', () => {
  it('matches the permission matrix of the design', () => {
    expect([...ROLE_PERMISSIONS.AGENCY_MEMBER].sort()).toEqual([...BASE].sort());
    expect([...ROLE_PERMISSIONS.AGENCY_ADMIN].sort()).toEqual(
      [...BASE, 'audit:read', 'member:manage', 'machine-access:manage'].sort(),
    );
    expect([...ROLE_PERMISSIONS.PLATFORM_ADMIN].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('grants machine accesses the agency admin permissions without user/machine management', () => {
    expect([...GRANTABLE_MACHINE_PERMISSIONS].sort()).toEqual([...BASE, 'audit:read'].sort());
    expect(
      GRANTABLE_MACHINE_PERMISSIONS.every((p) => ROLE_PERMISSIONS.AGENCY_ADMIN.includes(p)),
    ).toBe(true);
  });
});

describe('principalPermissions', () => {
  it('uses the role table for users and the granted set for machine accesses', () => {
    expect(principalPermissions(agencyAdmin)).toBe(ROLE_PERMISSIONS.AGENCY_ADMIN);
    expect(principalPermissions(machine)).toEqual(['listing:read']);
  });
});

describe('ungrantableMachinePermissions', () => {
  it('returns each non-grantable permission once in request order', () => {
    expect(
      ungrantableMachinePermissions([
        'listing:read',
        'member:manage',
        'agency:manage',
        'member:manage',
      ]),
    ).toEqual(['member:manage', 'agency:manage']);
    expect(ungrantableMachinePermissions([...GRANTABLE_MACHINE_PERMISSIONS])).toEqual([]);
  });
});

describe('authorize', () => {
  it('allows the platform admin everything, for every agency and platform-wide', () => {
    for (const permission of PERMISSIONS) {
      expect(authorize(platformAdmin, permission, 'a1')).toBe('ALLOW');
      expect(authorize(platformAdmin, permission, null)).toBe('ALLOW');
      expect(authorize(platformAdmin, permission, undefined)).toBe('ALLOW');
    }
  });

  it('allows own-agency operations covered by the role', () => {
    expect(authorize(member, 'listing:write', 'a1')).toBe('ALLOW');
    expect(authorize(agencyAdmin, 'member:manage', 'a1')).toBe('ALLOW');
    expect(authorize(machine, 'listing:read', 'a1')).toBe('ALLOW');
  });

  it('forbids own-agency operations without the permission', () => {
    expect(authorize(member, 'audit:read', 'a1')).toBe('FORBIDDEN');
    expect(authorize(member, 'member:manage', 'a1')).toBe('FORBIDDEN');
    expect(authorize(machine, 'listing:write', 'a1')).toBe('FORBIDDEN');
    for (const permission of PLATFORM_ONLY) {
      expect(authorize(agencyAdmin, permission, 'a1')).toBe('FORBIDDEN');
    }
  });

  it('reports foreign or agency-less resources as NOT_FOUND regardless of the permission', () => {
    for (const principal of [member, agencyAdmin, machine]) {
      expect(authorize(principal, 'listing:read', 'a2')).toBe('NOT_FOUND');
      expect(authorize(principal, 'agency:manage', 'a2')).toBe('NOT_FOUND');
      expect(authorize(principal, 'listing:read', null)).toBe('NOT_FOUND');
    }
  });

  it('forbids platform-wide operations for non-platform admins', () => {
    for (const principal of [member, agencyAdmin, machine]) {
      expect(authorize(principal, 'platform:operate', undefined)).toBe('FORBIDDEN');
      expect(authorize(principal, 'listing:read', undefined)).toBe('FORBIDDEN');
    }
  });
});
