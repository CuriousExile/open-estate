import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { routeRequirement, satisfies } from './portal-access';
import { PORTAL_UNAVAILABLE_PATH } from './portal-auth.service';
import { PortalSession } from './portal-session.service';

/** Notice shown for a portal route without the required permission. */
export const PORTAL_FORBIDDEN_PATH = '/portal/forbidden';

/**
 * Checks `data.access` ({@link routeRequirement}) of a portal route against `GET /me` (Req 5.6).
 * Use as `canActivateChild` of the portal shell; routes without `access` pass.
 */
export const permissionGuard: CanActivateFn = async (route) => {
  const requirement = routeRequirement(route.data);
  if (requirement === undefined) return true;
  const session = inject(PortalSession);
  const router = inject(Router);
  const me = await session.load();
  if (!me.ok) {
    return router.createUrlTree([PORTAL_UNAVAILABLE_PATH], { queryParams: { reason: 'session' } });
  }
  return satisfies(me.value, requirement) ? true : router.parseUrl(PORTAL_FORBIDDEN_PATH);
};
