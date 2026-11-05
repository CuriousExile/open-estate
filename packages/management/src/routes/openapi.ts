import { success } from '../http';
import { buildManagementOpenApiDocument } from '../openapi';
import { definePublicRoute, type Route } from '../router';
import type { RouteGroup } from './route-group';

// `GET /openapi.json` (design: "Management_API", Req 16.2): public, only the per-IP limit
// applies. The document describes every route registered before this group plus itself and is
// built once at Lambda init; an undocumented route aborts the init.

/** The `/openapi.json` route documenting `registered` and itself. */
export function createOpenApiRoute(registered: readonly Route[]): Route {
  const served: { document?: unknown } = {};
  const route = definePublicRoute({
    method: 'GET',
    path: '/openapi.json',
    handle: async () => success(200, served.document),
  });
  served.document = buildManagementOpenApiDocument([...registered, route]);
  return route;
}

/** Registered last in `routes/index.ts`, so it sees all other routes. */
export const openApiRoutes: RouteGroup = {
  name: 'openapi',
  create: (_context, registered = []) => [createOpenApiRoute(registered)],
};
