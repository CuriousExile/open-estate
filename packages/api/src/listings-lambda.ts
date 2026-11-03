import { SSMClient } from '@aws-sdk/client-ssm';
import {
  describeInitFailure,
  initReadModel,
  isConfigFailure,
  READ_MODEL_CONFIG_FILES,
  READ_MODEL_CONFIG_VALUES,
  READ_MODEL_ENV,
  withRequestLatency,
  type Metrics,
  type ReadModelSources,
} from '@open-estate/core';
import { loadCorsPolicy, NO_CORS, withCors } from './cors';
import { createDiscoveryHandlers } from './discovery';
import { createListingDetailHandler } from './listing-detail-handler';
import {
  createListingsHandler,
  serviceUnavailableResponse,
  type ListingsHandler,
  type ListingsRequest,
} from './listings-handler';
import { logger, metrics as defaultMetrics } from './observability';
import { createRouter } from './router';

// Lambda init of the Search_API routes (design: "ConfigProvider", "Taxonomy",
// "Konfigurationsmodelle"). Config, taxonomy, locales and tour allow-list are loaded and validated
// once by the read model shared with the MCP Lambda; the handler awaits that promise and
// dispatches by API Gateway resource.

/** API Gateway resource templates served by this Lambda (route wiring: Task 8.7). */
export const LISTINGS_ROUTES = {
  search: '/listings',
  detail: '/listings/{id}',
  openapi: '/openapi.json',
  meta: '/meta',
} as const;

/** `endpoint` dimension of every request outside {@link LISTINGS_ROUTES}. */
export const LISTINGS_UNKNOWN_ENDPOINT = 'unknown';

export type ListingsEndpoint = keyof typeof LISTINGS_ROUTES | typeof LISTINGS_UNKNOWN_ENDPOINT;

/** Every value {@link listingsEndpoint} can return (alarms and dashboard, Task 19.2). */
export const LISTINGS_ENDPOINTS: readonly ListingsEndpoint[] = [
  ...(Object.keys(LISTINGS_ROUTES) as (keyof typeof LISTINGS_ROUTES)[]),
  LISTINGS_UNKNOWN_ENDPOINT,
];

const ENDPOINT_BY_RESOURCE: ReadonlyMap<string, ListingsEndpoint> = new Map(
  Object.entries(LISTINGS_ROUTES).map(([endpoint, resource]) => [
    resource,
    endpoint as ListingsEndpoint,
  ]),
);

/**
 * `endpoint` dimension of `RequestLatency` (design: "Observability"): the route key (`search`,
 * `detail`, `openapi`, `meta`); any other resource is `unknown`, so the dimension stays bounded.
 */
export function listingsEndpoint(event: Pick<ListingsRequest, 'resource'>): ListingsEndpoint {
  return (
    (event.resource !== undefined && ENDPOINT_BY_RESOURCE.get(event.resource)) ||
    LISTINGS_UNKNOWN_ENDPOINT
  );
}

/** Records `RequestLatency` (`interface=api`) for every response of `handler` (Req 11.4). */
export function instrumentListingsHandler(
  handler: ListingsHandler,
  metrics: Metrics = defaultMetrics,
): ListingsHandler {
  return withRequestLatency(handler, {
    metrics,
    interface: 'api',
    endpoint: listingsEndpoint,
    logger,
  });
}

/** Environment variables (set by the CDK stack); same contract as the MCP Lambda. */
export const LISTINGS_ENV = READ_MODEL_ENV;
/** Values resolved by the ConfigProvider (env or `<NAME>_SSM_PARAMETER`). */
export const LISTINGS_CONFIG_VALUES = READ_MODEL_CONFIG_VALUES;
/** Files in the private config bucket. */
export const LISTINGS_CONFIG_FILES = READ_MODEL_CONFIG_FILES;

export type ListingsInitSources = ReadModelSources;

/**
 * Builds the read model (throws `ConfigError` or `TaxonomyValidationError` with all affected
 * names/codes on invalid configuration; AWS errors propagate), computes the discovery documents
 * and returns the router over all routes.
 */
export async function initListingsHandler(
  env: Readonly<Record<string, string | undefined>>,
  sources: ListingsInitSources = {},
): Promise<ListingsHandler> {
  const model = await initReadModel(env, sources);
  const { guard, schemas } = model;
  const discovery = createDiscoveryHandlers(guard, model);
  return createRouter({
    [LISTINGS_ROUTES.search]: createListingsHandler({ guard, schemas, search: model.search }),
    [LISTINGS_ROUTES.detail]: createListingDetailHandler({
      guard,
      schemas,
      listings: model.listings,
    }),
    [LISTINGS_ROUTES.openapi]: discovery.openapi,
    [LISTINGS_ROUTES.meta]: discovery.meta,
  });
}

/**
 * Production handler, instrumented with `RequestLatency`. The init starts immediately (during
 * the Lambda init phase) and is awaited by every request. While it failed, every request gets 503 `SERVICE_UNAVAILABLE` and nothing is
 * processed (Req 9.4, 15.4) — instead of throwing from the init, which API Gateway would turn
 * into a 502 outside the error catalog (design: Fehlerkatalog, `SERVICE_UNAVAILABLE` covers
 * init errors). Configuration errors are final for this instance; other failures (e.g. SSM
 * throttling) are retried by the next request.
 *
 * The CORS allowlist ({@link loadCorsPolicy}) is loaded independently, so the 503 of a failed
 * read-model init stays readable by the SPA. If the allowlist cannot be loaded, responses carry
 * no `Access-Control-Allow-Origin` (fail closed) while non-browser clients are unaffected.
 */
export function createListingsHandlerFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  sources: ListingsInitSources = {},
  metrics: Metrics = defaultMetrics,
): ListingsHandler {
  // One SSM client for the read model and the CORS allowlist.
  const shared: ListingsInitSources = { ...sources, ssm: sources.ssm ?? new SSMClient({}) };
  const handler = retryingInit('Search API: init failed', () => initListingsHandler(env, shared));
  const cors = retryingInit('Search API: CORS init failed', async () => {
    const policy = await loadCorsPolicy(env, shared);
    if (policy.allowedOrigins.size === 0) {
      logger.warn('Search API: no CORS origin configured, browser clients cannot read responses');
    }
    return policy;
  });

  // Instrumented outermost, so 503s while the init failed are measured as well.
  return instrumentListingsHandler(
    withCors(
      () => cors().catch(() => NO_CORS),
      async (event) => {
        let route: ListingsHandler;
        try {
          route = await handler();
        } catch {
          return serviceUnavailableResponse();
        }
        return route(event);
      },
    ),
    metrics,
  );
}

/**
 * Starts `load` now and returns an accessor for its result. A failure is logged once per attempt;
 * configuration errors are final, any other failure restarts `load` on the next access.
 */
function retryingInit<T>(message: string, load: () => Promise<T>): () => Promise<T> {
  const start = (): Promise<T> => {
    const attempt = load();
    // Also marks the rejection as handled before the first request.
    attempt.catch((error: unknown) => logger.error(message, describeInitFailure(error)));
    return attempt;
  };
  let current = start();
  return async () => {
    try {
      return await current;
    } catch (error) {
      if (!isConfigFailure(error)) current = start();
      throw error;
    }
  };
}
