import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  CONFIG_BUCKET_ENV,
  ConfigError,
  describeInitFailure,
  DUPLICATE_DETECTION_PARAMETER_ENV,
  DynamoDbConnectorRunStore,
  isConfigFailure,
  loadConfig,
  loadOptionalConfigFile,
  READ_MODEL_ENV,
  systemClock,
  type ConfigSources,
} from '@open-estate/core';
import { z } from 'zod';
import { CRAWLER_ALLOWLIST_CONFIG_KEY } from './compliance/crawler-allowlist';
import { CONNECTORS_CONFIG_KEY, connectorsFileSchema } from './connector-config';
import type { SecretResolver } from './connectors/secrets';
import { createDefaultRegistry } from './default-registry';
import { ConnectorFramework, type ConnectorRunSummary } from './framework';
import {
  createImportPipeline,
  IMPORT_CONFIG_FILES,
  loadImportConfig,
  PII_ALLOWLIST_FILE,
} from './pipeline/import-pipeline-factory';
import type { LogSink } from './run-logger';

// Lambda of one connector run (design: "Connector-Orchestrierung": Scheduler → Step Functions →
// Lambda). Configuration is loaded once per Lambda instance (restart semantics, Req 15.3, 16.8);
// the run time limit is enforced by the Lambda timeout and the Step Functions execution timeout,
// both set to the connector's `timeoutSeconds` (Req 5.7).

/** Object key of the PII allowlist in the private config bucket. */
export const PII_ALLOWLIST_CONFIG_KEY = PII_ALLOWLIST_FILE;

/** Environment variables of the connector Lambda (set by the IngestionStack). */
export const CONNECTOR_LAMBDA_ENV = {
  listingsTable: READ_MODEL_ENV.listingsTable,
  deletionBlocklistTable: 'DELETION_BLOCKLIST_TABLE_NAME',
  listingVersionsTable: 'LISTING_VERSIONS_TABLE_NAME',
  listingKeysTable: 'LISTING_KEYS_TABLE_NAME',
  metricCountersTable: 'METRIC_COUNTERS_TABLE_NAME',
  /** `ConnectorRuns` and `RunRejections` of the persisting run log (Req 13.2, 13.3). */
  connectorRunsTable: 'CONNECTOR_RUNS_TABLE_NAME',
  runRejectionsTable: 'RUN_REJECTIONS_TABLE_NAME',
  /** `VersionSnapshots` bucket of the `VersionedListingWriter`. */
  snapshotBucket: 'SNAPSHOT_BUCKET_NAME',
  /** Duplikat_Index of the Duplikat_Prüfung of imports (duplicate-detection Req 5.1, 6.1). */
  duplicateIndexTable: 'DUPLICATE_INDEX_TABLE_NAME',
  /**
   * SSM parameter with Ein/Aus of the Duplikat-Erkennung (`enabled` | `disabled`), read at most
   * once a minute. Optional: without it the check always runs.
   */
  duplicateDetectionParameter: DUPLICATE_DETECTION_PARAMETER_ENV,
  configBucket: CONFIG_BUCKET_ENV,
  /** Connector this function is provisioned for; other ids are refused. */
  connectorId: 'CONNECTOR_ID',
} as const;

/** Files the connector Lambda reads from the private config bucket. */
export const CONNECTOR_CONFIG_FILES = {
  taxonomy: IMPORT_CONFIG_FILES.taxonomy,
  i18n: IMPORT_CONFIG_FILES.i18n,
  connectors: CONNECTORS_CONFIG_KEY,
  tourProviders: IMPORT_CONFIG_FILES.tourProviders,
  piiAllowlist: IMPORT_CONFIG_FILES.piiAllowlist,
  /** Optional, read per crawler run: missing ⇒ no crawl target allowed (Req 6.1). */
  crawlerAllowlist: CRAWLER_ALLOWLIST_CONFIG_KEY,
  duplicateDetection: IMPORT_CONFIG_FILES.duplicateDetection,
} as const;

/** Input of one invocation, e.g. `{ "connectorId": "partner-db", "runId": "<execution name>" }`. */
export const connectorRunEventSchema = z.object({
  connectorId: z.string().min(1),
  runId: z.string().min(1).max(128).optional(),
});
export type ConnectorRunEvent = z.infer<typeof connectorRunEventSchema>;

/** JSON-safe run summary returned to Step Functions. */
export type ConnectorRunResult = Omit<ConnectorRunSummary, 'startedAt' | 'endedAt'> & {
  readonly startedAt: string;
  readonly endedAt: string;
};

export type ConnectorHandler = (event: unknown) => Promise<ConnectorRunResult>;

export interface ConnectorInitSources extends ConfigSources {
  readonly dynamo?: DynamoDBDocumentClient;
  readonly secrets?: SecretResolver;
  /** Run log destination; defaults to stdout. */
  readonly sink?: LogSink;
  readonly now?: () => Date;
}

const EMPTY_CRAWLER_ALLOWLIST = { targets: [] };

/** Thrown for an invocation that names a connector this function cannot run. */
export class UnknownConnectorError extends Error {
  constructor(readonly connectorId: string) {
    super(`connector "${connectorId}" is not configured for this function`);
    this.name = 'UnknownConnectorError';
  }
}

function requireEnv(env: Readonly<Record<string, string | undefined>>, names: string[]): void {
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new ConfigError('CONFIG_MISSING', missing);
}

/**
 * Loads and validates taxonomy, locales, `connectors.json`, tour and PII allowlists, builds the
 * import pipeline and the framework and returns the handler. Throws `ConfigError` or
 * `TaxonomyValidationError` naming every affected value; AWS errors propagate.
 */
export async function initConnectorHandler(
  env: Readonly<Record<string, string | undefined>>,
  sources: ConnectorInitSources = {},
): Promise<ConnectorHandler> {
  const names = CONNECTOR_LAMBDA_ENV;
  requireEnv(env, [
    names.listingsTable,
    names.deletionBlocklistTable,
    names.listingVersionsTable,
    names.listingKeysTable,
    names.metricCountersTable,
    names.connectorRunsTable,
    names.runRejectionsTable,
    names.snapshotBucket,
  ]);
  const files = CONNECTOR_CONFIG_FILES;
  const s3 = sources.s3 ?? new S3Client({});
  const configSources: ConfigSources = { ...sources, env, s3 };

  const [config, importConfig] = await Promise.all([
    loadConfig({ files: [files.connectors] }, configSources),
    loadImportConfig(configSources),
  ]);
  const connectors = config.loadJson(files.connectors, connectorsFileSchema);

  const dynamo = sources.dynamo ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const now = sources.now;
  const clock = now === undefined ? systemClock : () => now().getTime();
  const name = (variable: string) => env[variable] ?? '';
  const detectionParameter = env[names.duplicateDetectionParameter]?.trim() || undefined;
  const pipeline = createImportPipeline({
    names: {
      listingsTable: name(names.listingsTable),
      deletionBlocklistTable: name(names.deletionBlocklistTable),
      listingVersionsTable: name(names.listingVersionsTable),
      listingKeysTable: name(names.listingKeysTable),
      metricCountersTable: name(names.metricCountersTable),
      snapshotBucket: name(names.snapshotBucket),
      duplicateIndexTable: name(names.duplicateIndexTable),
    },
    config: importConfig,
    dynamo,
    s3,
    clock,
    ...(detectionParameter !== undefined && { duplicateDetectionParameter: detectionParameter }),
    ...(sources.ssm !== undefined && { ssm: sources.ssm }),
  });
  const registry = createDefaultRegistry({
    // Read per run, so allowlist changes apply without a restart; validated by the crawler.
    webCrawler: {
      loadAllowlist: () =>
        loadOptionalConfigFile(
          files.crawlerAllowlist,
          z.unknown(),
          EMPTY_CRAWLER_ALLOWLIST,
          configSources,
        ),
    },
    ...(sources.secrets && { secrets: sources.secrets }),
  });
  const framework = new ConnectorFramework({
    registry,
    processor: pipeline,
    runs: new DynamoDbConnectorRunStore({
      client: dynamo,
      runsTableName: env[names.connectorRunsTable] ?? '',
      rejectionsTableName: env[names.runRejectionsTable] ?? '',
    }),
    ...(sources.sink && { sink: sources.sink }),
    ...(sources.now && { now: sources.now }),
  });
  const pinnedId = env[CONNECTOR_LAMBDA_ENV.connectorId]?.trim() || undefined;

  return async (event) => {
    const { connectorId, runId = randomUUID() } = connectorRunEventSchema.parse(event);
    const connector = connectors.find((c) => c.id === connectorId);
    if (connector === undefined || (pinnedId !== undefined && pinnedId !== connectorId)) {
      throw new UnknownConnectorError(connectorId);
    }
    const summary = await framework.runConnector(connector, { runId });
    return {
      ...summary,
      startedAt: summary.startedAt.toISOString(),
      endedAt: summary.endedAt.toISOString(),
    };
  };
}

/**
 * Production handler. The init starts during the Lambda init phase and is awaited per invocation.
 * While it failed, every invocation throws (the Step Functions execution fails) and nothing is
 * imported. Configuration errors are final for this instance; other failures are retried by the
 * next invocation.
 */
export function createConnectorHandlerFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  sources: ConnectorInitSources = {},
): ConnectorHandler {
  const sink: LogSink = sources.sink ?? ((line) => process.stdout.write(`${line}\n`));
  const start = (): Promise<ConnectorHandler> => {
    const init = initConnectorHandler(env, sources);
    init.catch((error: unknown) =>
      sink(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          event: 'init.failed',
          ...describeInitFailure(error),
        }),
      ),
    );
    return init;
  };
  let ready = start();

  return async (event) => {
    let handler: ConnectorHandler;
    try {
      handler = await ready;
    } catch (error) {
      if (!isConfigFailure(error)) ready = start();
      throw error;
    }
    return handler(event);
  };
}
