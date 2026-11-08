import type { Route } from '../router';
import { duplicateRoutes } from './duplicates';
import { identityRoutes } from './identity';
import { listingRoutes } from './listings';
import { monitoringRoutes } from './monitoring';
import { openApiRoutes } from './openapi';
import { platformRoutes } from './platform';
import type { RouteGroup, RouteGroupContext } from './route-group';

// Registration point of all route groups of the Management_API. A group adds its routes in its
// own file; this list only changes when a new group is introduced.

export * from './route-group';
// Route lists over already wired use cases: the seam for callers that inject their own stores
// (tests, the local dev server) instead of wiring them from the Lambda environment.
export { AgencyOverview } from './identity/agency-overview';
export type { AgencyOverviewDeps } from './identity/agency-overview';
export { machineAccessAudit } from './identity/services';
export { createIdentityRouteList, createIdentityRoutes, meResponse } from './identity';
export type { IdentityServiceOptions, IdentityServices } from './identity';
export { createListingRouteGroup, createListingRoutes } from './listings';
export type { ListingCommands, ListingServices } from './listings';
export { createMonitoringRouteGroup, createMonitoringRoutes } from './monitoring';
export type { MonitoringRouteDeps, MonitoringRoutesDeps } from './monitoring';
export { createOpenApiRoute } from './openapi';
export { createPlatformRouteGroup, createPlatformRoutes } from './platform';
export type { PlatformDeps } from './platform';
export {
  createDuplicateRouteGroup,
  createDuplicateRoutes,
  DUPLICATES_ENV,
  StepFunctionsDuplicateSweepStarter,
} from './duplicates';
export type { DuplicateRouteDeps } from './duplicates';

export const ROUTE_GROUPS: readonly RouteGroup[] = [
  identityRoutes,
  listingRoutes,
  monitoringRoutes,
  platformRoutes,
  duplicateRoutes,
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
