import type { Route } from '../router';
import { identityRoutes } from './identity';
import { listingRoutes } from './listings';
import { monitoringRoutes } from './monitoring';
import { platformRoutes } from './platform';
import type { RouteGroup, RouteGroupContext } from './route-group';

// Registration point of all route groups of the Management_API. A group adds its routes in its
// own file; this list only changes when a new group is introduced.

export * from './route-group';

export const ROUTE_GROUPS: readonly RouteGroup[] = [
  identityRoutes,
  listingRoutes,
  monitoringRoutes,
  platformRoutes,
];

/** Routes of all `groups`, in registration order. */
export function createRoutes(
  context: RouteGroupContext,
  groups: readonly RouteGroup[] = ROUTE_GROUPS,
): Route[] {
  return groups.flatMap((group) => group.create(context));
}
