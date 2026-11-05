// Framework-free permission checks of the portal (design: Agentur_Portal; Req 5.6). The backend
// stays authoritative — these checks only decide which routes and controls are shown.
import { PERMISSIONS, type MeResponse, type Permission } from '@open-estate/shared';

/** Identity and effective permissions from `GET /me`. */
export type Me = MeResponse;

/**
 * Access requirement of a route (`data.access`) or control: every listed permission, and for
 * `platformAdmin` the role `PLATFORM_ADMIN` (Admin_Modus, Req 10.1).
 */
export interface AccessRequirement {
  readonly permissions?: readonly Permission[];
  readonly platformAdmin?: boolean;
  /** Nobody satisfies it — used for malformed route data (fail closed). */
  readonly deny?: boolean;
}

const DENY: AccessRequirement = { deny: true };

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

/** `can(permission)` for a (possibly not yet loaded) `/me`: false until `/me` is known. */
export function can(me: Me | undefined, permission: Permission): boolean {
  return me !== undefined && me.permissions.includes(permission);
}

export function isPlatformAdmin(me: Me | undefined): boolean {
  return me?.kind === 'user' && me.role === 'PLATFORM_ADMIN';
}

export function satisfies(me: Me | undefined, requirement: AccessRequirement | undefined): boolean {
  if (requirement === undefined) return true;
  if (requirement.deny === true) return false;
  if (requirement.platformAdmin === true && !isPlatformAdmin(me)) return false;
  return (requirement.permissions ?? []).every((permission) => can(me, permission));
}

/**
 * Requirement from route data (`{ access: AccessRequirement }`). Unknown permission names deny
 * access (fail closed) instead of being ignored.
 */
export function routeRequirement(
  data: Readonly<Record<string, unknown>>,
): AccessRequirement | undefined {
  const access = data['access'];
  if (access === undefined) return undefined;
  if (typeof access !== 'object' || access === null) return DENY;
  const { permissions, platformAdmin } = access as Record<string, unknown>;
  if (permissions !== undefined && !Array.isArray(permissions)) return DENY;
  const list: unknown[] = permissions ?? [];
  if (!list.every(isPermission)) return DENY;
  if (platformAdmin !== undefined && typeof platformAdmin !== 'boolean') return DENY;
  return { permissions: list, ...(platformAdmin === true && { platformAdmin: true }) };
}

/** Entry of the portal navigation; shown only if `access` is satisfied (Req 5.6). */
export interface PortalNavItem {
  readonly path: string;
  readonly labelKey: string;
  readonly access: AccessRequirement;
}

/** Portal areas (design: Agentur_Portal und Admin_Modus) with the permission each one needs. */
export const PORTAL_NAV: readonly PortalNavItem[] = [
  { path: 'listings', labelKey: 'portal.nav.listings', access: { permissions: ['listing:read'] } },
  {
    path: 'monitoring',
    labelKey: 'portal.nav.monitoring',
    access: { permissions: ['monitoring:read'] },
  },
  { path: 'team', labelKey: 'portal.nav.team', access: { permissions: ['member:manage'] } },
  {
    path: 'machine-access',
    labelKey: 'portal.nav.machineAccess',
    access: { permissions: ['machine-access:manage'] },
  },
  { path: 'audit', labelKey: 'portal.nav.audit', access: { permissions: ['audit:read'] } },
  { path: 'admin', labelKey: 'portal.nav.admin', access: { platformAdmin: true } },
];

export function visibleNavItems(me: Me | undefined): PortalNavItem[] {
  return PORTAL_NAV.filter((item) => satisfies(me, item.access));
}
