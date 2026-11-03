import { errorResponse, type ListingsHandler } from './listings-handler';

// One Lambda serves all Search_API routes (design: "Search_API"). API Gateway only forwards
// configured routes, so the route is chosen by the resource template, not by parsing the path.

/** Handlers keyed by API Gateway resource template, e.g. `/listings/{id}`. */
export type Routes = Readonly<Record<string, ListingsHandler>>;

export function createRouter(routes: Routes): ListingsHandler {
  const table = new Map(Object.entries(routes));
  return async (event) => {
    const handler = event.resource === undefined ? undefined : table.get(event.resource);
    if (handler !== undefined) return handler(event);
    // Only reachable with a gateway route that has no handler here (infrastructure drift).
    return errorResponse([
      {
        code: 'NOT_FOUND',
        message: 'No such resource.',
        details: { resource: event.resource ?? null },
      },
    ]);
  };
}
