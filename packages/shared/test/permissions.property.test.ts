// Feature: listing-management, Property 1: Berechtigungsentscheidung entspricht dem Referenzmodell
import fc from 'fast-check';
import { authorize, PERMISSIONS, type Decision, type Permission, type Principal } from '../src';
import { arbAgencyId, arbPrincipal } from './arbitraries/management';

/**
 * For any principal (role or machine access with permission set), permission and agency of the
 * target resource, `authorize` returns `ALLOW` iff the actor is Plattform_Admin, or the resource
 * belongs to the actor's agency and the permission is in the actor's set; an agency-bound
 * resource outside the actor's agency yields `NOT_FOUND` regardless of the permission, otherwise
 * a missing permission yields `FORBIDDEN`.
 *
 * **Validates: Requirements 2.2, 2.5, 2.6, 3.4, 10.1, 10.2**
 */

// Test-local reference of the design table "Berechtigungsmodell", independent of ROLE_PERMISSIONS.
const AGENCY_BASE: readonly Permission[] = [
  'listing:read',
  'listing:write',
  'listing:status',
  'version:restore',
  'monitoring:read',
];
const REFERENCE_ROLE_PERMISSIONS: Readonly<
  Record<'AGENCY_MEMBER' | 'AGENCY_ADMIN', readonly Permission[]>
> = {
  AGENCY_MEMBER: AGENCY_BASE,
  AGENCY_ADMIN: [...AGENCY_BASE, 'audit:read', 'member:manage', 'machine-access:manage'],
};

/** `resourceAgencyId`: string = owning agency, null = without agency, undefined = platform-wide. */
function referenceDecision(
  principal: Principal,
  permission: Permission,
  resourceAgencyId: string | null | undefined,
): Decision {
  if (principal.kind === 'user' && principal.role === 'PLATFORM_ADMIN') return 'ALLOW';
  const held =
    principal.kind === 'machine'
      ? principal.permissions
      : REFERENCE_ROLE_PERMISSIONS[principal.role];
  if (resourceAgencyId === undefined) return 'FORBIDDEN';
  if (resourceAgencyId !== principal.agencyId) return 'NOT_FOUND';
  return held.includes(permission) ? 'ALLOW' : 'FORBIDDEN';
}

// Small agency pool so own/foreign resources collide often; plus fresh ids, null and undefined.
const AGENCY_IDS = ['agy-a', 'agy-b', 'agy-c'] as const;
const arbPermission = fc.constantFrom(...PERMISSIONS);
const arbCase = arbPrincipal({ agencyIds: AGENCY_IDS }).chain((principal) => {
  const own = 'agencyId' in principal ? [fc.constant(principal.agencyId)] : [];
  return fc.record({
    principal: fc.constant(principal),
    permission: arbPermission,
    resourceAgencyId: fc.oneof(
      ...own,
      fc.constantFrom<string | null | undefined>(...AGENCY_IDS, null, undefined),
      arbAgencyId,
    ),
  });
});

describe('Property 1: Berechtigungsentscheidung entspricht dem Referenzmodell', () => {
  it('authorize matches the reference model', () => {
    fc.assert(
      fc.property(arbCase, ({ principal, permission, resourceAgencyId }) => {
        expect(authorize(principal, permission, resourceAgencyId)).toBe(
          referenceDecision(principal, permission, resourceAgencyId),
        );
      }),
      { numRuns: 100 },
    );
  });

  it('a foreign agency-bound resource is NOT_FOUND for every permission', () => {
    fc.assert(
      fc.property(
        arbCase.filter(
          ({ principal, resourceAgencyId }) =>
            'agencyId' in principal &&
            resourceAgencyId !== undefined &&
            resourceAgencyId !== principal.agencyId,
        ),
        ({ principal, resourceAgencyId }) => {
          for (const permission of PERMISSIONS) {
            expect(authorize(principal, permission, resourceAgencyId)).toBe('NOT_FOUND');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
