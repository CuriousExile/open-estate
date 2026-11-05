import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import {
  AgencyService,
  CognitoIdentityDirectory,
  DynamoDbAgencyStore,
  DynamoDbMachineAccessStore,
  DynamoDbMembershipStore,
  DynamoDbMetricCounterStore,
  DynamoDbPlatformCounterStore,
  DynamoDbTransactor,
  MachineAccessService,
  MembershipService,
  type AuditService,
  type IdentityDirectory,
  type MachineAccessAudit,
  type MachineAccessStore,
} from '@open-estate/core';
import { MANAGEMENT_ENV, readEnv } from '../../env';
import type { RouteGroupContext } from '../route-group';
import { AgencyOverview } from './agency-overview';

// Wiring of the identity routes: AgencyService, MembershipService, MachineAccessService and the
// agency overview on the DynamoDB stores and the Cognito User Pool.

/** Environment variables of the identity routes (in addition to the access path's). */
export const IDENTITY_ENV = {
  userPoolId: MANAGEMENT_ENV.userPoolId,
  membershipsTable: MANAGEMENT_ENV.membershipsTable,
  agenciesTable: MANAGEMENT_ENV.agenciesTable,
  machineAccessTable: MANAGEMENT_ENV.machineAccessTable,
  /** `PlatformCounters` (Plattform_Admin counter, Req 10.9). */
  platformCountersTable: 'PLATFORM_COUNTERS_TABLE_NAME',
  /** `MetricCounters` (listings per status for dry runs and the agency overview). */
  metricCountersTable: 'METRIC_COUNTERS_TABLE_NAME',
} as const;

export interface IdentityServices {
  agencies: AgencyService;
  memberships: MembershipService<unknown>;
  machineAccess: MachineAccessService;
  overview: AgencyOverview;
  /** Read side for the revocation preview (`?dryRun=true`). */
  machineAccessStore: Pick<MachineAccessStore, 'get'>;
}

export interface IdentityServiceOptions {
  /** Default: `CognitoIdentityDirectory` on `USER_POOL_ID`. */
  identity?: IdentityDirectory;
}

/** Adapts the Audit_Log to the machine-access sink (403 → `access-denied`, Req 2.8). */
export function machineAccessAudit(audit: Pick<AuditService, 'append'>): MachineAccessAudit {
  return {
    async append(entry) {
      await audit.append({
        category: entry.result === 'FORBIDDEN' ? 'access-denied' : 'management',
        ...entry,
      });
    },
  };
}

/** Production wiring; throws `ConfigError` naming every missing variable. */
export function createIdentityServices(
  { env, clients, shared }: RouteGroupContext,
  options: IdentityServiceOptions = {},
): IdentityServices {
  const config = readEnv(env, IDENTITY_ENV);
  const client = clients.dynamo;
  const agencyStore = new DynamoDbAgencyStore({ client, tableName: config.agenciesTable });
  const membershipStore = new DynamoDbMembershipStore({
    client,
    tableName: config.membershipsTable,
  });
  const machineAccessStore = new DynamoDbMachineAccessStore({
    client,
    tableName: config.machineAccessTable,
  });
  const counters = new DynamoDbMetricCounterStore({
    client,
    tableName: config.metricCountersTable,
  });
  const identity =
    options.identity ??
    new CognitoIdentityDirectory({
      client: new CognitoIdentityProviderClient({}),
      userPoolId: config.userPoolId,
    });
  const { audit, clock } = shared;
  return {
    agencies: new AgencyService({
      agencies: agencyStore,
      memberships: membershipStore,
      counters,
      audit,
      clock,
    }),
    memberships: new MembershipService({
      memberships: membershipStore,
      agencies: agencyStore,
      platformCounters: new DynamoDbPlatformCounterStore({
        client,
        tableName: config.platformCountersTable,
      }),
      identity,
      transactor: new DynamoDbTransactor({ client }),
      audit,
      clock,
    }),
    machineAccess: new MachineAccessService({
      store: machineAccessStore,
      agencies: agencyStore,
      audit: machineAccessAudit(audit),
      clock,
    }),
    overview: new AgencyOverview({
      agencies: agencyStore,
      memberships: membershipStore,
      counters,
    }),
    machineAccessStore,
  };
}
