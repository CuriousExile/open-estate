import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import {
  createMetricDefinitions,
  DynamoDbAgencyStore,
  DynamoDbAuditService,
  DynamoDbConnectorRunStore,
  DynamoDbManagedListingStore,
  DynamoDbMetricCounterStore,
  MetricCatalog,
  MonitoringQueries,
  MonitoringService,
  type AuditLogReader,
} from '@open-estate/core';
import { MANAGEMENT_ENV, readEnv } from '../../env';
import type { RouteGroupContext } from '../route-group';

// Lambda-init wiring of the monitoring route group: stores, Kennzahlenkatalog, MonitoringService
// and MonitoringQueries from the environment (set by the ManagementStack, task 12.2).

/** Environment variables of the monitoring group, in addition to `MANAGEMENT_ENV`. */
export const MONITORING_ENV = {
  listingsTable: 'LISTINGS_TABLE_NAME',
  metricCountersTable: 'METRIC_COUNTERS_TABLE_NAME',
  connectorRunsTable: 'CONNECTOR_RUNS_TABLE_NAME',
  runRejectionsTable: 'RUN_REJECTIONS_TABLE_NAME',
  /** EMF namespace of `RequestLatency` / `RequestCount` (`OpenEstate`). */
  metricsNamespace: 'METRICS_NAMESPACE',
  /** Name prefix of the platform alarms read via `DescribeAlarms` (Req 14.2). */
  alarmNamePrefix: 'ALARM_NAME_PREFIX',
} as const;

/** Shared variables of the access path the group reads as well. */
const SHARED_ENV = {
  agenciesTable: MANAGEMENT_ENV.agenciesTable,
  auditLogTable: MANAGEMENT_ENV.auditLogTable,
} as const;

/**
 * Deadline per monitoring source. Req 14.7 allows 10 s, but the whole request must finish within
 * the 4.5-s Management_API deadline; `/monitoring/usage` resolves in two rounds (totals, then the
 * listing page), so each source gets 2 s and a slow source becomes `available: false` instead of
 * turning the response into 503.
 */
export const MANAGEMENT_MONITORING_SOURCE_DEADLINE_MS = 2_000;

export interface MonitoringRouteDeps {
  auditLog: AuditLogReader;
  monitoring: MonitoringService;
  queries: MonitoringQueries;
}

export interface MonitoringWiringOptions {
  /** Default: a new client (region from the Lambda environment). */
  cloudWatch?: CloudWatchClient;
  deadlineMs?: number;
}

/** Builds the use cases of the group; throws `ConfigError` naming every missing variable. */
export function wireMonitoring(
  { env, clients, shared }: RouteGroupContext,
  options: MonitoringWiringOptions = {},
): MonitoringRouteDeps {
  const config = readEnv(env, { ...SHARED_ENV, ...MONITORING_ENV });
  const client = clients.dynamo;
  const cloudWatch = options.cloudWatch ?? new CloudWatchClient({});
  const deadlineMs = options.deadlineMs ?? MANAGEMENT_MONITORING_SOURCE_DEADLINE_MS;

  const agencies = new DynamoDbAgencyStore({ client, tableName: config.agenciesTable });
  const listings = new DynamoDbManagedListingStore({ client, tableName: config.listingsTable });
  const connectorRuns = new DynamoDbConnectorRunStore({
    client,
    runsTableName: config.connectorRunsTable,
    rejectionsTableName: config.runRejectionsTable,
  });
  const counters = new DynamoDbMetricCounterStore({
    client,
    tableName: config.metricCountersTable,
  });
  const catalog = new MetricCatalog(
    createMetricDefinitions({
      counters,
      agencies,
      listings,
      connectorRuns,
      cloudWatch,
      metricsNamespace: config.metricsNamespace,
    }),
  );
  const monitoring = new MonitoringService({ catalog, audit: shared.audit, deadlineMs });
  const queries = new MonitoringQueries({
    monitoring,
    connectorRuns,
    agencies,
    listings,
    cloudWatch,
    alarmNamePrefix: config.alarmNamePrefix,
    audit: shared.audit,
    clock: () => new Date(shared.clock()),
    deadlineMs,
  });
  const auditLog = new DynamoDbAuditService({
    client,
    tableName: config.auditLogTable,
    now: shared.clock,
  });
  return { auditLog, monitoring, queries };
}
