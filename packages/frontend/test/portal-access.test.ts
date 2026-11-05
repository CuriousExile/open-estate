import { ROLE_PERMISSIONS } from '@open-estate/shared';
import {
  can,
  isPlatformAdmin,
  PORTAL_NAV,
  routeRequirement,
  satisfies,
  visibleNavItems,
  type Me,
} from '../src/app/auth/portal-access';

const member: Me = {
  kind: 'user',
  id: 'u-1',
  displayName: 'Mia Member',
  role: 'AGENCY_MEMBER',
  agencyId: 'a-1',
  permissions: [...ROLE_PERMISSIONS.AGENCY_MEMBER],
};
const agencyAdmin: Me = {
  ...member,
  role: 'AGENCY_ADMIN',
  permissions: [...ROLE_PERMISSIONS.AGENCY_ADMIN],
};
const platformAdmin: Me = {
  kind: 'user',
  id: 'u-9',
  displayName: 'Pat Platform',
  role: 'PLATFORM_ADMIN',
  permissions: [...ROLE_PERMISSIONS.PLATFORM_ADMIN],
};

describe('can (Req 5.6)', () => {
  it('is true exactly for the permissions from /me', () => {
    expect(can(member, 'listing:write')).toBe(true);
    expect(can(member, 'member:manage')).toBe(false);
    expect(can(agencyAdmin, 'member:manage')).toBe(true);
  });

  it('is false while /me is not loaded', () => {
    expect(can(undefined, 'listing:read')).toBe(false);
  });
});

describe('isPlatformAdmin', () => {
  it('requires the user role PLATFORM_ADMIN', () => {
    expect(isPlatformAdmin(platformAdmin)).toBe(true);
    expect(isPlatformAdmin(agencyAdmin)).toBe(false);
    expect(isPlatformAdmin({ ...platformAdmin, kind: 'machine' })).toBe(false);
    expect(isPlatformAdmin(undefined)).toBe(false);
  });
});

describe('satisfies', () => {
  it('requires every listed permission and the admin role when asked', () => {
    expect(satisfies(member, undefined)).toBe(true);
    expect(satisfies(member, { permissions: ['listing:read', 'listing:write'] })).toBe(true);
    expect(satisfies(member, { permissions: ['listing:read', 'audit:read'] })).toBe(false);
    expect(satisfies(agencyAdmin, { platformAdmin: true })).toBe(false);
    expect(satisfies(platformAdmin, { platformAdmin: true })).toBe(true);
    expect(satisfies(platformAdmin, { deny: true })).toBe(false);
  });
});

describe('routeRequirement', () => {
  it('reads data.access', () => {
    expect(routeRequirement({})).toBeUndefined();
    expect(routeRequirement({ access: { permissions: ['audit:read'] } })).toEqual({
      permissions: ['audit:read'],
    });
    expect(routeRequirement({ access: { platformAdmin: true } })).toEqual({
      permissions: [],
      platformAdmin: true,
    });
  });

  it.each([
    [{ access: { permissions: ['listing:fly'] } }],
    [{ access: { permissions: 'listing:read' } }],
    [{ access: { platformAdmin: 'yes' } }],
    [{ access: 'admin' }],
    [{ access: null }],
  ])('fails closed for malformed data %j', (data) => {
    const requirement = routeRequirement(data);
    expect(satisfies(platformAdmin, requirement)).toBe(false);
  });
});

describe('visibleNavItems (Req 5.6)', () => {
  const paths = (me: Me | undefined) => visibleNavItems(me).map((item) => item.path);

  it('shows an agency member only listings and monitoring', () => {
    expect(paths(member)).toEqual(['listings', 'monitoring']);
  });

  it('shows an agency admin the agency areas but not the Admin_Modus', () => {
    expect(paths(agencyAdmin)).toEqual([
      'listings',
      'monitoring',
      'team',
      'machine-access',
      'audit',
    ]);
  });

  it('shows a platform admin every area', () => {
    expect(paths(platformAdmin)).toEqual(PORTAL_NAV.map((item) => item.path));
  });

  it('shows nothing before /me is loaded', () => {
    expect(paths(undefined)).toEqual([]);
  });
});
