import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  CachingAuthenticator,
  cognitoAccessTokenVerifier,
  describeInitFailure,
  DynamoDbAgencyStore,
  DynamoDbAuditService,
  DynamoDbMachineAccessStore,
  DynamoDbMembershipStore,
  DynamoDbRateLimitCounterStore,
  SsmDuplicateDetectionSetting,
  systemClock,
  type AccessTokenVerifier,
  type Clock,
} from '@open-estate/core';
import { createManagementAccessGuard, SsmRateLimitSource } from './access-guard';
import { loadFrontendOrigin, readManagementEnv } from './env';
import { createManagementHandler, type ManagementLogger } from './handler';
import type { ManagementHandler } from './http';
import { logger as defaultLogger } from './observability';
import { createRouter } from './router';
import {
  createRoutes,
  ROUTE_GROUPS,
  type ManagementClients,
  type RouteGroup,
  type SharedRouteDeps,
} from './routes';

// Lambda init of the Management_API: configuration and frontend origin are read once; a missing
// or invalid value aborts the init (design: "Error Handling", Req 4.5) instead of serving
// requests that would store listings without Quell-URL.

export interface ManagementInitOptions {
  clients?: Partial<ManagementClients>;
  /** Default: all groups of `routes/index.ts`. */
  groups?: readonly RouteGroup[];
  /** Default: Cognito verifier for `USER_POOL_ID` / `USER_POOL_CLIENT_ID`. */
  tokenVerifier?: AccessTokenVerifier;
  clock?: Clock;
  logger?: ManagementLogger;
  deadlineMs?: number;
}

/**
 * Builds the production handler. Throws `ConfigError` naming every missing variable or the
 * frontend origin; AWS errors propagate.
 */
export async function initManagementHandler(
  env: Readonly<Record<string, string | undefined>>,
  options: ManagementInitOptions = {},
): Promise<ManagementHandler> {
  const config = readManagementEnv(env);
  const clients: ManagementClients = {
    dynamo: options.clients?.dynamo ?? DynamoDBDocumentClient.from(new DynamoDBClient({})),
    ssm: options.clients?.ssm ?? new SSMClient({}),
  };
  const frontendOrigin = await loadFrontendOrigin(env, { ssm: clients.ssm });
  const clock = options.clock ?? systemClock;
  const audit = new DynamoDbAuditService({
    client: clients.dynamo,
    tableName: config.auditLogTable,
    now: clock,
  });
  const authenticator = new CachingAuthenticator({
    tokenVerifier:
      options.tokenVerifier ??
      cognitoAccessTokenVerifier({
        userPoolId: config.userPoolId,
        clientId: config.userPoolClientId,
      }),
    memberships: new DynamoDbMembershipStore({
      client: clients.dynamo,
      tableName: config.membershipsTable,
    }),
    agencies: new DynamoDbAgencyStore({ client: clients.dynamo, tableName: config.agenciesTable }),
    machineAccesses: new DynamoDbMachineAccessStore({
      client: clients.dynamo,
      tableName: config.machineAccessTable,
    }),
    clock,
  });
  const guard = createManagementAccessGuard({
    authenticator,
    rateLimit: new SsmRateLimitSource({
      client: clients.ssm,
      parameterName: config.rateLimitParameter,
    }),
    counters: new DynamoDbRateLimitCounterStore({
      client: clients.dynamo,
      tableName: config.rateLimitCountersTable,
    }),
    clock,
  });
  const duplicateDetection = new SsmDuplicateDetectionSetting({
    client: clients.ssm,
    parameterName: config.duplicateDetectionParameter,
    clock,
  });
  const shared: SharedRouteDeps = { frontendOrigin, audit, clock, duplicateDetection };
  const routes = createRoutes({ env, clients, shared }, options.groups ?? ROUTE_GROUPS);
  return createManagementHandler({
    router: createRouter(routes),
    guard,
    audit,
    logger: options.logger ?? defaultLogger,
    ...(options.deadlineMs !== undefined && { deadlineMs: options.deadlineMs }),
  });
}

/**
 * Lambda handler: the init starts immediately (Lambda init phase) and every request awaits it.
 * If the init failed, the failure is logged once (names only, no values) and every invocation
 * fails with it, so no request is processed with incomplete configuration.
 */
export function createManagementHandlerFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: ManagementInitOptions = {},
): ManagementHandler {
  const log = options.logger ?? defaultLogger;
  const init = initManagementHandler(env, options);
  // Also marks the rejection as handled before the first request.
  init.catch((error: unknown) =>
    log.error('Management API: init failed', describeInitFailure(error)),
  );
  return async (event) => (await init)(event);
}
