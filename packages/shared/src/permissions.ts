import { PERMISSIONS, type Permission, type Principal, type Role } from './management';

// Berechtigungsmodell (design: "Berechtigungsmodell", Req 2, 3.3, 10.1, 10.2). This table is the
// single source for the backend, the portal (`/me`) and the generated documentation (Req 2.1).

/** Permissions every agency role holds within its own agency. */
const AGENCY_BASE_PERMISSIONS = [
  'listing:read',
  'listing:write',
  'listing:status',
  'version:restore',
  'monitoring:read',
] as const satisfies readonly Permission[];

/** Role → permissions. `PLATFORM_ADMIN` holds every permission for every agency (Req 10.1, 10.2). */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  AGENCY_MEMBER: AGENCY_BASE_PERMISSIONS,
  AGENCY_ADMIN: [
    ...AGENCY_BASE_PERMISSIONS,
    'audit:read',
    'member:manage',
    'machine-access:manage',
  ],
  PLATFORM_ADMIN: PERMISSIONS,
};

/**
 * Permissions grantable to a machine access: those of `AGENCY_ADMIN` without managing users and
 * machine accesses (Req 3.3).
 */
export const GRANTABLE_MACHINE_PERMISSIONS: readonly Permission[] = [
  ...AGENCY_BASE_PERMISSIONS,
  'audit:read',
];

const GRANTABLE_SET: ReadonlySet<string> = new Set(GRANTABLE_MACHINE_PERMISSIONS);

/** Outcome of {@link authorize}; maps to 200 / 403 `FORBIDDEN` / 404 `NOT_FOUND`. */
export type Decision = 'ALLOW' | 'FORBIDDEN' | 'NOT_FOUND';

/** Effective permission set of a principal (roles via the table, machine accesses as granted). */
export function principalPermissions(principal: Principal): readonly Permission[] {
  return principal.kind === 'machine' ? principal.permissions : ROLE_PERMISSIONS[principal.role];
}

/**
 * Requested machine-access permissions outside {@link GRANTABLE_MACHINE_PERMISSIONS}, in request
 * order without duplicates; empty = grantable (Req 3.3, one `INVALID_PERMISSION` per entry).
 */
export function ungrantableMachinePermissions(requested: readonly string[]): string[] {
  return [...new Set(requested.filter((permission) => !GRANTABLE_SET.has(permission)))];
}

/**
 * Decides whether `principal` may use `permission` on a resource.
 *
 * `resourceAgencyId`: owning agency of the target resource; `null` = resource without agency;
 * `undefined` = platform-wide operation.
 *
 * Rules, in this order: (1) `PLATFORM_ADMIN` → `ALLOW`. (2) Resource outside the actor's agency →
 * `NOT_FOUND` for agency-bound resources (other agency or none), `FORBIDDEN` for platform-wide
 * operations — checked before the permission so a 403 never reveals foreign resources (Req 2.6).
 * (3) Permission missing → `FORBIDDEN` (Req 2.5). (4) Otherwise `ALLOW`.
 */
export function authorize(
  principal: Principal,
  permission: Permission,
  resourceAgencyId: string | null | undefined,
): Decision {
  if (principal.kind === 'user' && principal.role === 'PLATFORM_ADMIN') {
    return 'ALLOW';
  }
  if (resourceAgencyId === undefined) {
    return 'FORBIDDEN';
  }
  if (resourceAgencyId !== principal.agencyId) {
    return 'NOT_FOUND';
  }
  return principalPermissions(principal).includes(permission) ? 'ALLOW' : 'FORBIDDEN';
}
