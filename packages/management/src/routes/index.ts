import type { Route } from '../router';
import { identityRoutes } from './identity';
import { listingRoutes } from './listings';
import { monitoringRoutes } from './monitoring';
import { openApiRoutes } from './openapi';
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
  // Last: documents the routes of all groups above.
  openApiRoutes,
];

/** Routes of all `groups`, in registration order; each group sees the routes before it. */
export function createRoutes(
  context: RouteGroupContext,
  groups: readonly RouteGroup[] = ROUTE_GROUPS,
): Route[] {
  const routes: Route[] = [];
  for (const group of groups) routes.push(...group.create(context, [...routes]));
  return routes;
}
