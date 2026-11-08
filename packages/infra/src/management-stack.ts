import * as path from 'node:path';
import { Aws, CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { EndpointType, LambdaIntegration, RestApi } from 'aws-cdk-lib/aws-apigateway';
import type { IDistribution } from 'aws-cdk-lib/aws-cloudfront';
import type { IUserPool, IUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import {
  AttributeType,
  Billing,
  ProjectionType,
  TableV2,
  type GlobalSecondaryIndexPropsV2,
  type ITableV2,
} from 'aws-cdk-lib/aws-dynamodb';
import { ManagedPolicy, Policy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { FilterPattern, SubscriptionFilter, type ILogGroup } from 'aws-cdk-lib/aws-logs';
import { LambdaDestination } from 'aws-cdk-lib/aws-logs-destinations';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  ObjectOwnership,
  type IBucket,
} from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, CacheControl, Source } from 'aws-cdk-lib/aws-s3-deployment';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { ParameterTier, StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { IStateMachine } from 'aws-cdk-lib/aws-stepfunctions';
import { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import { ADMIN_ENV } from '@open-estate/admin';
import {
  DUPLICATE_INDEX_BLOCK_ATTRIBUTE,
  DUPLICATE_INDEX_BLOCK_SK_ATTRIBUTE,
  DUPLICATE_INDEX_BY_BLOCK,
  DUPLICATE_INDEX_PK,
  DUPLICATE_INDEX_SK,
  DUPLICATE_REPORTS_BY_STATE,
  DUPLICATE_REPORTS_PK,
  DUPLICATE_REPORTS_STATE_ATTRIBUTE,
  DUPLICATE_REPORTS_STATE_SK_ATTRIBUTE,
  IDEMPOTENCY_KEYS_BY_LISTING,
  IDEMPOTENCY_KEYS_LISTING_ATTRIBUTE,
  IDEMPOTENCY_KEYS_PK,
  IDEMPOTENCY_KEYS_TTL_ATTRIBUTE,
  AGENCIES_BY_STATE_INDEX,
  AGENCIES_BY_STATE_PK_ATTRIBUTE,
  AGENCIES_BY_STATE_SK_ATTRIBUTE,
  AGENCIES_KEY_ATTRIBUTE,
  AUDIT_LOG_BY_AGENCY_INDEX,
  CONFIG_BUCKET_ENV,
  CONNECTOR_RUNS_AGENCY_ATTRIBUTE,
  CONNECTOR_RUNS_BY_AGENCY_INDEX,
  CONNECTOR_RUNS_PK_ATTRIBUTE,
  CONNECTOR_RUNS_SK_ATTRIBUTE,
  CONNECTOR_RUNS_TTL_ATTRIBUTE,
  DEFAULT_METRICS_NAMESPACE,
  LISTING_KEYS_PK_ATTRIBUTE,
  LISTING_VERSIONS_PK_ATTRIBUTE,
  LISTING_VERSIONS_SK_ATTRIBUTE,
  LISTINGS_BY_AGENCY_INDEX,
  LISTINGS_BY_SOURCE_INDEX,
  MACHINE_ACCESS_BY_AGENCY_INDEX,
  MACHINE_ACCESS_BY_AGENCY_PK_ATTRIBUTE,
  MACHINE_ACCESS_BY_AGENCY_SK_ATTRIBUTE,
  MACHINE_ACCESS_KEY_ATTRIBUTE,
  MEMBERSHIPS_BY_AGENCY_INDEX,
  MEMBERSHIPS_BY_AGENCY_PK_ATTRIBUTE,
  MEMBERSHIPS_BY_AGENCY_SK_ATTRIBUTE,
  MEMBERSHIPS_KEY_ATTRIBUTE,
  METRIC_COUNTERS_PK_ATTRIBUTE,
  METRIC_COUNTERS_SK_ATTRIBUTE,
  METRIC_COUNTERS_TTL_ATTRIBUTE,
  PLATFORM_COUNTERS_KEY_ATTRIBUTE,
  READ_MODEL_CONFIG_FILES,
  READ_MODEL_ENV,
  RUN_REJECTIONS_PK_ATTRIBUTE,
  RUN_REJECTIONS_SK_ATTRIBUTE,
  snapshotKey,
  snapshotPrefix,
  SSM_PARAMETER_SUFFIX,
  USAGE_AGGREGATOR_ENTRY,
  USAGE_AGGREGATOR_ENV,
  USAGE_LOG_FILTER_PATTERN,
  type RateLimit,
} from '@open-estate/core';
import { FRONTEND_ORIGIN_VALUE, MANAGEMENT_ENV } from '@open-estate/management';
import { DUPLICATE_CONFIG_FILE, type ErrorResponse } from '@open-estate/shared';
import type { Construct } from 'constructs';
import type { DeletionHistoryResources } from './admin-stack';
import {
  addGatewayResponses,
  bundledFunction,
  GATEWAY_RESPONSES,
  ssmParameterArn,
} from './api-stack';
import { WAF_RATE_LIMIT_WINDOW_SECONDS, type ObservabilitySettings } from './config';
import type { SsmParameterNames } from './data-stack';
import { FRONTEND_RUNTIME_FILES, NO_CACHE_CONTROL } from './frontend-stack';
import { cognitoPortalOrigins, PlatformAdminBootstrap } from './identity-stack';
import { DuplicateSweepWorkflow, type DuplicateSweepSettings } from './duplicate-sweep';
import type { ConnectorVersioningResources } from './ingestion-stack';
import { MANAGEMENT_CORS_ENV, MANAGEMENT_CORS_EXPOSED_HEADERS } from './lambda/management-cors';

// Management side of the Listing-Verwaltung (design: "Management-Zugang", task 12.2), split into
// two stacks because of the deployment order:
//
//   Data → ManagementData → Api → Ingestion → Admin → Frontend → Identity → Management
//
// - `ManagementDataStack` (tables, snapshot bucket) is read by the Search_API/MCP (`Agencies`,
//   suspensions), the connectors (versioned write path) and the deletion task (history). The
//   Frontend needs the API URL, the Identity the CloudFront origin, and the Management_API the
//   user pool, the deletion workflow and the reloadable functions — so the tables cannot live in
//   the last stack without a cycle.
// - `ManagementStack` (REST API, WAF, management Lambda, UsageAggregator, bootstrap, portal
//   runtime config) comes last and only references earlier stacks.
//
// Portal runtime config: the FrontendStack cannot know the Cognito client id or the
// Management_API URL (both are created after it). Instead of the FrontendStack writing
// `{apiBaseUrl}`, the ManagementStack writes the complete `runtime-config.json`
// (`apiBaseUrl` + `portal`) into the frontend bucket with a BucketDeployment and invalidates it;
// the FrontendStack is told not to write the file (`writeRuntimeConfig: false`), so a later
// deployment of the FrontendStack alone never overwrites the portal block.
//
// CSP: for the same reason the FrontendStack cannot reference the Management_API origin. Its
// `connect-src` gets the region's API Gateway host wildcard (`https://*.execute-api.<region>.<suffix>`)
// and the Cognito origins, which are deterministic (domain prefix + region), see
// {@link portalConnectOrigins}.

const REPO_ROOT = path.resolve(__dirname, '../../..');
const INFRA_PACKAGE = path.join(REPO_ROOT, 'packages/infra');
const CORE_PACKAGE = path.join(REPO_ROOT, 'packages/core');

/** SSM parameter of the actor/IP rate limit of the Management_API (`{"requests":N,"windowSeconds":W}`). */
export function managementRateLimitParameterName(envName: string): string {
  return `/open-estate/${envName}/management-rate-limit`;
}

/**
 * `connect-src` sources of the Agentur_Portal for the FrontendStack's CSP: the API Gateway host
 * wildcard of the deploying region (Management_API, created after the FrontendStack) and the
 * Cognito domain and issuer origins of `cognitoDomainPrefix`.
 */
export function portalConnectOrigins(cognitoDomainPrefix: string): string[] {
  return [
    `https://*.execute-api.${Aws.REGION}.${Aws.URL_SUFFIX}`,
    ...cognitoPortalOrigins(cognitoDomainPrefix),
  ];
}

/** Stage limits of the Management_API: portal users and machine clients, below the Search_API. */
const MANAGEMENT_THROTTLING_RATE_LIMIT = 50;
const MANAGEMENT_THROTTLING_BURST_LIMIT = 100;

/** Above the handler's 4.5 s deadline (→ 503), below API Gateway's 29 s integration timeout. */
const MANAGEMENT_LAMBDA_TIMEOUT = Duration.seconds(10);

/**
 * Variables of the route groups of the management Lambda, besides {@link MANAGEMENT_ENV}. Mirrors
 * `IDENTITY_ENV`, `LISTING_ROUTES_ENV`, `MONITORING_ENV`, `PLATFORM_ENV` and `DUPLICATES_ENV` of
 * `@open-estate/management`, which its package index does not export; `management-stack.test.ts`
 * compares both, so a renamed or added variable fails the infra tests.
 */
export const MANAGEMENT_ROUTE_ENV = {
  identity: {
    userPoolId: MANAGEMENT_ENV.userPoolId,
    membershipsTable: MANAGEMENT_ENV.membershipsTable,
    agenciesTable: MANAGEMENT_ENV.agenciesTable,
    machineAccessTable: MANAGEMENT_ENV.machineAccessTable,
    platformCountersTable: 'PLATFORM_COUNTERS_TABLE_NAME',
    metricCountersTable: 'METRIC_COUNTERS_TABLE_NAME',
  },
  listings: {
    listingsTable: READ_MODEL_ENV.listingsTable,
    listingVersionsTable: 'LISTING_VERSIONS_TABLE_NAME',
    listingKeysTable: 'LISTING_KEYS_TABLE_NAME',
    metricCountersTable: 'METRIC_COUNTERS_TABLE_NAME',
    deletionBlocklistTable: 'DELETION_BLOCKLIST_TABLE_NAME',
    agenciesTable: MANAGEMENT_ENV.agenciesTable,
    snapshotBucket: 'SNAPSHOT_BUCKET_NAME',
    configBucket: CONFIG_BUCKET_ENV,
    duplicateIndexTable: 'DUPLICATE_INDEX_TABLE_NAME',
    idempotencyKeysTable: 'IDEMPOTENCY_KEYS_TABLE_NAME',
  },
  monitoring: {
    listingsTable: 'LISTINGS_TABLE_NAME',
    metricCountersTable: 'METRIC_COUNTERS_TABLE_NAME',
    connectorRunsTable: 'CONNECTOR_RUNS_TABLE_NAME',
    runRejectionsTable: 'RUN_REJECTIONS_TABLE_NAME',
    metricsNamespace: 'METRICS_NAMESPACE',
    alarmNamePrefix: 'ALARM_NAME_PREFIX',
  },
  platform: { ...ADMIN_ENV, reloadFunctions: 'RELOAD_FUNCTION_NAMES' },
  duplicates: {
    duplicateReportsTable: 'DUPLICATE_REPORTS_TABLE_NAME',
    metricCountersTable: 'METRIC_COUNTERS_TABLE_NAME',
    duplicateSweepStateMachineArn: 'DUPLICATE_SWEEP_STATE_MACHINE_ARN',
  },
} as const;

/** Config-bucket files the listing commands validate against (`LISTING_CONFIG_FILES`). */
export const MANAGEMENT_CONFIG_FILES = {
  taxonomy: READ_MODEL_CONFIG_FILES.taxonomy,
  tourProviders: READ_MODEL_CONFIG_FILES.tourProviders,
  piiAllowlist: 'pii-allowlist.json',
  duplicateDetection: DUPLICATE_CONFIG_FILE,
} as const;

// ---------------------------------------------------------------------------------------------
// ManagementDataStack
// ---------------------------------------------------------------------------------------------

export interface ManagementDataStackProps extends StackProps {
  /** `RETAIN` also enables deletion protection of the tables. */
  readonly removalPolicy: RemovalPolicy;
}

/**
 * Persistent stores of the Listing-Verwaltung (design: "DynamoDB-Tabellen", "Versions-Snapshots"):
 * `ListingVersions`, `ListingKeys`, `Agencies`, `Memberships`, `PlatformCounters`,
 * `MachineAccess`, `MetricCounters`, `ConnectorRuns`, `RunRejections` and the `VersionSnapshots`
 * bucket. Key schemas come from the store constants of `@open-estate/core`. TTL (`expiresAt`) on
 * the daily counters and the run log (100 days).
 */
export class ManagementDataStack extends Stack {
  readonly listingVersionsTable: TableV2;
  readonly listingKeysTable: TableV2;
  readonly agenciesTable: TableV2;
  readonly membershipsTable: TableV2;
  readonly platformCountersTable: TableV2;
  readonly machineAccessTable: TableV2;
  readonly metricCountersTable: TableV2;
  readonly connectorRunsTable: TableV2;
  readonly runRejectionsTable: TableV2;
  /**
   * Duplikat_Index (duplicate-detection design: "Duplikat_Index"): profiles, block items and exact
   * keys; GSI `byBlock` finds the candidates of a block key, KEYS_ONLY.
   */
  readonly duplicateIndexTable: TableV2;
  /** Idempotenzschlüssel of `POST /listings`, TTL 24 h; GSI `byListing` for deletions. */
  readonly idempotencyKeysTable: TableV2;
  /**
   * Agenturübergreifende_Treffer of the Duplikat_Abgleich; GSI `byState` lists one state by
   * descending score (projection ALL: the list shows every attribute).
   */
  readonly duplicateReportsTable: TableV2;
  readonly snapshotKey: Key;
  /**
   * Content-addressed snapshots `listings/{id}/{contentHash}.json`: SSE-KMS, Block Public Access
   * and no versioning, so `DeleteObject` removes a snapshot for good (GDPR, Req 9.2).
   */
  readonly snapshotBucket: Bucket;

  constructor(scope: Construct, id: string, props: ManagementDataStackProps) {
    super(scope, id, props);
    const { removalPolicy } = props;
    const retain = removalPolicy === RemovalPolicy.RETAIN;
    const string = (name: string) => ({ name, type: AttributeType.STRING });
    const table = (
      tableId: string,
      options: {
        partitionKey: { name: string; type: AttributeType };
        sortKey?: { name: string; type: AttributeType };
        globalSecondaryIndexes?: GlobalSecondaryIndexPropsV2[];
        timeToLiveAttribute?: string;
      },
    ) =>
      new TableV2(this, tableId, {
        ...options,
        billing: Billing.onDemand(),
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        deletionProtection: retain,
        removalPolicy,
      });

    // Written once per version in the listing's transaction, kept until the listing is deleted.
    this.listingVersionsTable = table('ListingVersions', {
      partitionKey: string(LISTING_VERSIONS_PK_ATTRIBUTE),
      sortKey: { name: LISTING_VERSIONS_SK_ATTRIBUTE, type: AttributeType.NUMBER },
    });
    // Custom_Id uniqueness per agency (`agencyId#customId`).
    this.listingKeysTable = table('ListingKeys', {
      partitionKey: string(LISTING_KEYS_PK_ATTRIBUTE),
    });
    this.agenciesTable = table('Agencies', {
      partitionKey: string(AGENCIES_KEY_ATTRIBUTE),
      globalSecondaryIndexes: [
        {
          indexName: AGENCIES_BY_STATE_INDEX,
          partitionKey: string(AGENCIES_BY_STATE_PK_ATTRIBUTE),
          sortKey: string(AGENCIES_BY_STATE_SK_ATTRIBUTE),
        },
      ],
    });
    this.membershipsTable = table('Memberships', {
      partitionKey: string(MEMBERSHIPS_KEY_ATTRIBUTE),
      globalSecondaryIndexes: [
        {
          indexName: MEMBERSHIPS_BY_AGENCY_INDEX,
          partitionKey: string(MEMBERSHIPS_BY_AGENCY_PK_ATTRIBUTE),
          sortKey: string(MEMBERSHIPS_BY_AGENCY_SK_ATTRIBUTE),
        },
      ],
    });
    this.platformCountersTable = table('PlatformCounters', {
      partitionKey: string(PLATFORM_COUNTERS_KEY_ATTRIBUTE),
    });
    // Only `SHA-256(secret)` is stored (Req 3.2).
    this.machineAccessTable = table('MachineAccess', {
      partitionKey: string(MACHINE_ACCESS_KEY_ATTRIBUTE),
      globalSecondaryIndexes: [
        {
          indexName: MACHINE_ACCESS_BY_AGENCY_INDEX,
          partitionKey: string(MACHINE_ACCESS_BY_AGENCY_PK_ATTRIBUTE),
          sortKey: string(MACHINE_ACCESS_BY_AGENCY_SK_ATTRIBUTE),
        },
      ],
    });
    // Current values without TTL, daily values expire after 100 days.
    this.metricCountersTable = table('MetricCounters', {
      partitionKey: string(METRIC_COUNTERS_PK_ATTRIBUTE),
      sortKey: string(METRIC_COUNTERS_SK_ATTRIBUTE),
      timeToLiveAttribute: METRIC_COUNTERS_TTL_ATTRIBUTE,
    });
    this.connectorRunsTable = table('ConnectorRuns', {
      partitionKey: string(CONNECTOR_RUNS_PK_ATTRIBUTE),
      sortKey: string(CONNECTOR_RUNS_SK_ATTRIBUTE),
      globalSecondaryIndexes: [
        {
          indexName: CONNECTOR_RUNS_BY_AGENCY_INDEX,
          partitionKey: string(CONNECTOR_RUNS_AGENCY_ATTRIBUTE),
          sortKey: string(CONNECTOR_RUNS_SK_ATTRIBUTE),
        },
      ],
      timeToLiveAttribute: CONNECTOR_RUNS_TTL_ATTRIBUTE,
    });
    this.runRejectionsTable = table('RunRejections', {
      partitionKey: string(RUN_REJECTIONS_PK_ATTRIBUTE),
      sortKey: { name: RUN_REJECTIONS_SK_ATTRIBUTE, type: AttributeType.NUMBER },
      timeToLiveAttribute: CONNECTOR_RUNS_TTL_ATTRIBUTE,
    });

    this.duplicateIndexTable = table('DuplicateIndex', {
      partitionKey: string(DUPLICATE_INDEX_PK),
      sortKey: string(DUPLICATE_INDEX_SK),
      globalSecondaryIndexes: [
        {
          indexName: DUPLICATE_INDEX_BY_BLOCK,
          partitionKey: string(DUPLICATE_INDEX_BLOCK_ATTRIBUTE),
          sortKey: string(DUPLICATE_INDEX_BLOCK_SK_ATTRIBUTE),
          projectionType: ProjectionType.KEYS_ONLY,
        },
      ],
    });
    this.idempotencyKeysTable = table('IdempotencyKeys', {
      partitionKey: string(IDEMPOTENCY_KEYS_PK),
      globalSecondaryIndexes: [
        {
          indexName: IDEMPOTENCY_KEYS_BY_LISTING,
          partitionKey: string(IDEMPOTENCY_KEYS_LISTING_ATTRIBUTE),
          projectionType: ProjectionType.KEYS_ONLY,
        },
      ],
      timeToLiveAttribute: IDEMPOTENCY_KEYS_TTL_ATTRIBUTE,
    });
    this.duplicateReportsTable = table('DuplicateReports', {
      partitionKey: string(DUPLICATE_REPORTS_PK),
      globalSecondaryIndexes: [
        {
          indexName: DUPLICATE_REPORTS_BY_STATE,
          partitionKey: string(DUPLICATE_REPORTS_STATE_ATTRIBUTE),
          sortKey: string(DUPLICATE_REPORTS_STATE_SK_ATTRIBUTE),
        },
      ],
    });

    this.snapshotKey = new Key(this, 'SnapshotKey', {
      description: 'Open Estate version snapshot encryption',
      enableKeyRotation: true,
      removalPolicy,
    });
    this.snapshotBucket = new Bucket(this, 'VersionSnapshots', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: BucketEncryption.KMS,
      encryptionKey: this.snapshotKey,
      // S3 Bucket Key: one KMS data key per bucket and period instead of one per object.
      bucketKeyEnabled: true,
      enforceSSL: true,
      versioned: false,
      removalPolicy,
      autoDeleteObjects: !retain,
    });

    // Read by the seed script and the load-test generator, which write through the import
    // pipeline like a connector (versions, keys, counters, snapshots, Duplikat_Index).
    const outputs: [string, string, string][] = [
      ['ListingVersionsTableName', 'ListingVersions table', this.listingVersionsTable.tableName],
      ['ListingKeysTableName', 'ListingKeys table', this.listingKeysTable.tableName],
      ['MetricCountersTableName', 'MetricCounters table', this.metricCountersTable.tableName],
      ['DuplicateIndexTableName', 'DuplicateIndex table', this.duplicateIndexTable.tableName],
      ['SnapshotBucketName', 'VersionSnapshots bucket', this.snapshotBucket.bucketName],
    ];
    for (const [id, what, value] of outputs) {
      new CfnOutput(this, id, { description: `Physical name of the ${what}`, value });
    }
  }

  /** Stores of the connectors' versioned write path (IngestionStack). */
  get versioning(): ConnectorVersioningResources {
    return {
      listingVersions: this.listingVersionsTable,
      listingKeys: this.listingKeysTable,
      metricCounters: this.metricCountersTable,
      snapshotBucket: this.snapshotBucket,
      connectorRuns: this.connectorRunsTable,
      runRejections: this.runRejectionsTable,
      duplicateIndex: this.duplicateIndexTable,
    };
  }

  /** History removed by the deletion task (AdminStack). */
  get history(): DeletionHistoryResources {
    return {
      listingVersions: this.listingVersionsTable,
      listingKeys: this.listingKeysTable,
      metricCounters: this.metricCountersTable,
      snapshotBucket: this.snapshotBucket,
      duplicateIndex: this.duplicateIndexTable,
      idempotencyKeys: this.idempotencyKeysTable,
      duplicateReports: this.duplicateReportsTable,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// ManagementStack
// ---------------------------------------------------------------------------------------------

/** Tables and configuration of the DataStack the Management_API uses. */
export interface ManagementPlatformData {
  readonly listings: ITableV2;
  readonly apiKeys: ITableV2;
  readonly rateLimitCounters: ITableV2;
  readonly deletionBlocklist: ITableV2;
  readonly deletionRequests: ITableV2;
  readonly auditLog: ITableV2;
  readonly configBucket: IBucket;
  /** `access-mode` and `rate-limit`, written by `/platform/*` like by the Admin_API (Req 10.7). */
  readonly parameterNames: Pick<
    SsmParameterNames,
    'accessMode' | 'rateLimit' | 'duplicateDetection'
  >;
}

/** Stores of the {@link ManagementDataStack}. */
export type ManagementStores = Pick<
  ManagementDataStack,
  | 'listingVersionsTable'
  | 'listingKeysTable'
  | 'agenciesTable'
  | 'membershipsTable'
  | 'platformCountersTable'
  | 'machineAccessTable'
  | 'metricCountersTable'
  | 'connectorRunsTable'
  | 'runRejectionsTable'
  | 'duplicateIndexTable'
  | 'idempotencyKeysTable'
  | 'duplicateReportsTable'
  | 'snapshotBucket'
  | 'snapshotKey'
>;

export interface ManagementStackProps extends StackProps {
  readonly envName: string;
  readonly stageName: string;
  readonly removalPolicy: RemovalPolicy;
  readonly observability: ObservabilitySettings;
  readonly data: ManagementPlatformData;
  readonly stores: ManagementStores;
  readonly identity: {
    readonly userPool: IUserPool;
    readonly portalClient: IUserPoolClient;
    /** OIDC issuer of the portal (`portal.issuer`). */
    readonly issuerUrl: string;
    /** Cognito domain (`portal.cognitoDomainUrl`). */
    readonly domainUrl: string;
  };
  /** Hosting of the SPA: `runtime-config.json` is written into its bucket. */
  readonly frontend: {
    readonly bucket: IBucket;
    readonly distribution: IDistribution;
    /** CloudFront origin of the SPA (CORS allowlist). */
    readonly origin: string;
  };
  /** SSM parameter with the SPA origin, written by the FrontendStack (Quell-URL, Req 4.5). */
  readonly frontendOriginParameter: string;
  /** Extra browser origins of the portal (context `corsAllowedOrigins`). */
  readonly corsAllowedOrigins: readonly string[];
  /** Base URL of the Search_API stage (`apiBaseUrl` of the runtime config). */
  readonly searchApiUrl: string;
  /** Log groups of the API and MCP Lambdas carrying the usage lines (Req 13.4). */
  readonly usageLogGroups: readonly ILogGroup[];
  /** Search_API, MCP_Server and connectors: targets of `/platform/reload` besides itself. */
  readonly reloadableFunctions: readonly IFunction[];
  readonly deletionStateMachine: IStateMachine;
  /** Prefix of the platform alarms (`DescribeAlarms`, Req 14.2), e.g. `<prefix>-Monitoring-`. */
  readonly alarmNamePrefix: string;
  /** Operational alarm topic (MonitoringStack); the duplicate check's alarm notifies it. */
  readonly alarmTopic?: ITopic;
  /** Daily time of the Duplikat_Abgleich from `duplicate-detection.json` (Req 10.1). */
  readonly duplicateSweep: DuplicateSweepSettings;
  /** Requests per IP and {@link WAF_RATE_LIMIT_WINDOW_SECONDS} before WAF blocks. */
  readonly wafRateLimit: number;
  /** Initial value of {@link managementRateLimitParameterName}. */
  readonly rateLimit: RateLimit;
  /** Creates the first Plattform_Admin while none exists (Req 10.10). */
  readonly initialPlatformAdminEmail?: string;
}

/** WAF rate-rule answer in the `ErrorResponse` format. */
const WAF_RATE_LIMITED_BODY: ErrorResponse = {
  errors: [{ code: 'RATE_LIMITED', message: 'Too many requests from this IP address.' }],
};

/**
 * Management_API (design: "Management-Zugang"): REST API with WAF and one Lambda for all routes
 * (proxy resource, the router matches), CORS for the portal origins with `Authorization`, the
 * UsageAggregator behind subscription filters on the API and MCP log groups, the SSM parameter
 * of the management rate limit, the bootstrap of the first Plattform_Admin and the portal block
 * of `runtime-config.json`.
 */
export class ManagementStack extends Stack {
  readonly api: RestApi;
  readonly managementFunction: NodejsFunction;
  readonly usageAggregator: NodejsFunction;
  readonly webAcl: CfnWebACL;
  readonly rateLimitParameter: StringParameter;
  readonly bootstrap?: PlatformAdminBootstrap;
  /** Duplikat_Abgleich: Lambda, state machine, schedule and alarm (duplicate-detection Req 10). */
  readonly duplicateSweep: DuplicateSweepWorkflow;

  constructor(scope: Construct, id: string, props: ManagementStackProps) {
    super(scope, id, props);
    if (props.reloadableFunctions.length === 0) {
      throw new Error('ManagementStack needs at least one reloadable function');
    }
    // The Lambda aborts its init without the frontend origin: deploy after the FrontendStack,
    // which writes it (explicit, the parameter is only read by name).
    const frontendStack = Stack.of(props.frontend.bucket);
    if (frontendStack !== this) this.addStackDependency(frontendStack);

    const corsOrigins = [props.frontend.origin, ...props.corsAllowedOrigins];

    this.rateLimitParameter = new StringParameter(this, 'ManagementRateLimitParameter', {
      parameterName: managementRateLimitParameterName(props.envName),
      description: 'Rate limit of the Management_API per IP and per actor',
      stringValue: JSON.stringify(props.rateLimit),
      tier: ParameterTier.STANDARD,
    });

    this.duplicateSweep = new DuplicateSweepWorkflow(this, 'DuplicateSweep', {
      listings: props.data.listings,
      auditLog: props.data.auditLog,
      configBucket: props.data.configBucket,
      duplicateIndex: props.stores.duplicateIndexTable,
      duplicateReports: props.stores.duplicateReportsTable,
      metricCounters: props.stores.metricCountersTable,
      frontendOriginParameter: props.frontendOriginParameter,
      duplicateDetectionParameter: props.data.parameterNames.duplicateDetection,
      settings: props.duplicateSweep,
      alarmName: `${props.alarmNamePrefix}DuplicateSweepFailed`,
      ...(props.alarmTopic !== undefined && { alarmTopic: props.alarmTopic }),
      removalPolicy: props.removalPolicy,
      observability: props.observability,
    });

    this.managementFunction = bundledFunction(this, 'ManagementFunction', {
      description: 'Management_API (Agentur_Portal, machine access, platform operations)',
      packageDir: INFRA_PACKAGE,
      entry: 'src/lambda/management-entry.ts',
      memorySize: 1024,
      timeout: MANAGEMENT_LAMBDA_TIMEOUT,
      removalPolicy: props.removalPolicy,
      observability: props.observability,
    });
    const sweepMachine = this.duplicateSweep.stateMachine;
    const environment = managementEnvironment(props, corsOrigins, sweepMachine.stateMachineArn);
    for (const [name, value] of Object.entries(environment)) {
      this.managementFunction.addEnvironment(name, value);
    }
    grantManagement(this.managementFunction, props);
    // `/platform/reload` also restarts the management function itself (it reads taxonomy,
    // allowlists and `duplicate-detection.json` at cold start). A policy of its own: the
    // function's default policy may not reference the function (CloudFormation cycle).
    const role = this.managementFunction.role;
    if (role === undefined) throw new Error('ManagementFunction has no role');
    const reloadSelf = () =>
      new PolicyStatement({
        actions: ['lambda:GetFunctionConfiguration', 'lambda:UpdateFunctionConfiguration'],
        resources: [this.managementFunction.functionArn],
      });
    new Policy(this, 'ManagementSelfReloadPolicy', { roles: [role], statements: [reloadSelf()] });
    // `open-estate-admin reload` of the Management_API: the AdminStack's AdministratorPolicy is
    // created before this function exists, so administrators attach this policy in addition.
    const reloadPolicy = new ManagedPolicy(this, 'ManagementReloadPolicy', {
      description: 'open-estate-admin reload of the Management_API (next to AdministratorPolicy)',
      statements: [reloadSelf()],
    });
    // `POST /platform/duplicate-sweeps` (Req 10.2): the running execution or a new one.
    allow(this.managementFunction, ['states:ListExecutions'], [sweepMachine.stateMachineArn]);
    sweepMachine.grantStartExecution(this.managementFunction);

    this.usageAggregator = bundledFunction(this, 'UsageAggregator', {
      description: 'Counts detail views and search impressions per listing and agency (Req 13.4)',
      packageDir: CORE_PACKAGE,
      entry: USAGE_AGGREGATOR_ENTRY,
      memorySize: 256,
      timeout: Duration.minutes(1),
      removalPolicy: props.removalPolicy,
      observability: props.observability,
    });
    this.usageAggregator.addEnvironment(
      USAGE_AGGREGATOR_ENV.metricCountersTable,
      props.stores.metricCountersTable.tableName,
    );
    allow(
      this.usageAggregator,
      ['dynamodb:UpdateItem'],
      [props.stores.metricCountersTable.tableArn],
    );
    props.usageLogGroups.forEach((logGroup, index) => {
      new SubscriptionFilter(this, `UsageSubscription${index}`, {
        logGroup,
        destination: new LambdaDestination(this.usageAggregator),
        filterPattern: FilterPattern.literal(USAGE_LOG_FILTER_PATTERN),
      });
    });

    this.api = new RestApi(this, 'ManagementApi', {
      restApiName: `${id}-management`,
      description: 'Open Estate Management_API',
      endpointTypes: [EndpointType.REGIONAL],
      cloudWatchRole: false,
      deployOptions: {
        stageName: props.stageName,
        throttlingRateLimit: MANAGEMENT_THROTTLING_RATE_LIMIT,
        throttlingBurstLimit: MANAGEMENT_THROTTLING_BURST_LIMIT,
      },
    });
    // One proxy resource for every route including OPTIONS (preflight answered by the CORS
    // wrapper). No gateway authorizer: the Lambda authenticates and audits every rejection.
    this.api.root.addProxy({
      defaultIntegration: new LambdaIntegration(this.managementFunction, { proxy: true }),
      anyMethod: true,
    });
    addGatewayResponses(this.api, GATEWAY_RESPONSES, managementGatewayCorsHeaders(corsOrigins));

    this.webAcl = managementWebAcl(this, id, props.wafRateLimit, corsOrigins);
    new CfnWebACLAssociation(this, 'ManagementApiWebAclAssociation', {
      resourceArn: this.api.deploymentStage.stageArn,
      webAclArn: this.webAcl.attrArn,
    });

    if (props.initialPlatformAdminEmail !== undefined) {
      this.bootstrap = new PlatformAdminBootstrap(this, 'PlatformAdminBootstrap', {
        userPool: props.identity.userPool,
        memberships: props.stores.membershipsTable,
        platformCounters: props.stores.platformCountersTable,
        email: props.initialPlatformAdminEmail,
        removalPolicy: props.removalPolicy,
      });
    }

    // Complete runtime config of the SPA (see the file header): public search + portal block.
    new BucketDeployment(this, 'PortalRuntimeConfig', {
      destinationBucket: props.frontend.bucket,
      sources: [
        Source.jsonData(FRONTEND_RUNTIME_FILES.runtimeConfig, {
          apiBaseUrl: props.searchApiUrl,
          portal: {
            issuer: props.identity.issuerUrl,
            cognitoDomainUrl: props.identity.domainUrl,
            clientId: props.identity.portalClient.userPoolClientId,
            managementApiUrl: this.api.url,
          },
        }),
      ],
      cacheControl: [CacheControl.fromString(NO_CACHE_CONTROL)],
      prune: false,
      // The file belongs to the frontend bucket; deleting this stack must not break the search.
      retainOnDelete: true,
      distribution: props.frontend.distribution,
      distributionPaths: [`/${FRONTEND_RUNTIME_FILES.runtimeConfig}`],
    });

    new CfnOutput(this, 'ManagementApiUrl', {
      description: 'Base URL of the Management_API stage',
      value: this.api.url,
    });
    // Every function that reads configuration at cold start, for `open-estate-admin reload`: the
    // AdminStack's list (API, MCP, connectors) plus the Management_API, created only here.
    new CfnOutput(this, 'ReloadFunctionNames', {
      description: 'Functions open-estate-admin reload restarts (OPEN_ESTATE_RELOAD_FUNCTIONS)',
      value: Fn.join(
        ',',
        [...props.reloadableFunctions, this.managementFunction].map((fn) => fn.functionName),
      ),
    });
    new CfnOutput(this, 'ReloadPolicyArn', {
      description:
        'Managed policy for administrators: reload the Management_API (open-estate-admin reload)',
      value: reloadPolicy.managedPolicyArn,
    });
  }
}

/** Sets `values` per variable of `names`; the record type forces every key. */
function envOf<K extends string>(
  names: Readonly<Record<K, string>>,
  values: Record<K, string>,
): [string, string][] {
  return (Object.keys(names) as K[]).map((key) => [names[key], values[key]]);
}

/**
 * Environment of the management Lambda: the access path (`MANAGEMENT_ENV`) and the variables of
 * every route group (identity, listings, monitoring, platform). Groups share variable names
 * (e.g. `LISTINGS_TABLE_NAME`); a name with two different values is a wiring error.
 */
function managementEnvironment(
  props: ManagementStackProps,
  corsOrigins: readonly string[],
  duplicateSweepStateMachineArn: string,
): Record<string, string> {
  const { data, stores, identity } = props;
  const entries: [string, string][] = [
    ...envOf(MANAGEMENT_ENV, {
      userPoolId: identity.userPool.userPoolId,
      userPoolClientId: identity.portalClient.userPoolClientId,
      membershipsTable: stores.membershipsTable.tableName,
      agenciesTable: stores.agenciesTable.tableName,
      machineAccessTable: stores.machineAccessTable.tableName,
      auditLogTable: data.auditLog.tableName,
      rateLimitCountersTable: data.rateLimitCounters.tableName,
      rateLimitParameter: managementRateLimitParameterName(props.envName),
      duplicateDetectionParameter: data.parameterNames.duplicateDetection,
    }),
    [FRONTEND_ORIGIN_VALUE + SSM_PARAMETER_SUFFIX, props.frontendOriginParameter],
    ...envOf(MANAGEMENT_ROUTE_ENV.identity, {
      userPoolId: identity.userPool.userPoolId,
      membershipsTable: stores.membershipsTable.tableName,
      agenciesTable: stores.agenciesTable.tableName,
      machineAccessTable: stores.machineAccessTable.tableName,
      platformCountersTable: stores.platformCountersTable.tableName,
      metricCountersTable: stores.metricCountersTable.tableName,
    }),
    ...envOf(MANAGEMENT_ROUTE_ENV.listings, {
      listingsTable: data.listings.tableName,
      listingVersionsTable: stores.listingVersionsTable.tableName,
      listingKeysTable: stores.listingKeysTable.tableName,
      metricCountersTable: stores.metricCountersTable.tableName,
      deletionBlocklistTable: data.deletionBlocklist.tableName,
      agenciesTable: stores.agenciesTable.tableName,
      snapshotBucket: stores.snapshotBucket.bucketName,
      configBucket: data.configBucket.bucketName,
      duplicateIndexTable: stores.duplicateIndexTable.tableName,
      idempotencyKeysTable: stores.idempotencyKeysTable.tableName,
    }),
    ...envOf(MANAGEMENT_ROUTE_ENV.monitoring, {
      listingsTable: data.listings.tableName,
      metricCountersTable: stores.metricCountersTable.tableName,
      connectorRunsTable: stores.connectorRunsTable.tableName,
      runRejectionsTable: stores.runRejectionsTable.tableName,
      metricsNamespace: DEFAULT_METRICS_NAMESPACE,
      alarmNamePrefix: props.alarmNamePrefix,
    }),
    ...envOf(MANAGEMENT_ROUTE_ENV.platform, {
      apiKeysTable: data.apiKeys.tableName,
      accessModeParameter: data.parameterNames.accessMode,
      rateLimitParameter: data.parameterNames.rateLimit,
      listingsTable: data.listings.tableName,
      deletionRequestsTable: data.deletionRequests.tableName,
      deletionBlocklistTable: data.deletionBlocklist.tableName,
      auditLogTable: data.auditLog.tableName,
      deletionStateMachineArn: props.deletionStateMachine.stateMachineArn,
      reloadFunctions: Fn.join(
        ',',
        props.reloadableFunctions.map((fn) => fn.functionName),
      ),
    }),
    ...envOf(MANAGEMENT_ROUTE_ENV.duplicates, {
      duplicateReportsTable: stores.duplicateReportsTable.tableName,
      metricCountersTable: stores.metricCountersTable.tableName,
      duplicateSweepStateMachineArn,
    }),
    [MANAGEMENT_CORS_ENV, corsOrigins.join(',')],
    // EMF namespace of the handler's metrics, same as API, MCP and connectors (Req 14.1).
    ['POWERTOOLS_METRICS_NAMESPACE', DEFAULT_METRICS_NAMESPACE],
  ];
  const env: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (name in env && env[name] !== value) {
      throw new Error(`Management Lambda: conflicting values for ${name}`);
    }
    env[name] = value;
  }
  return env;
}

const indexArn = (table: ITableV2, name: string) => `${table.tableArn}/index/${name}`;

function allow(fn: NodejsFunction, actions: string[], resources: string[]): void {
  fn.addToRolePolicy(new PolicyStatement({ actions, resources }));
}

/**
 * Least privilege of the management Lambda, per table the operations its stores issue
 * (transactions need the item actions, `TransactWriteItems` has no permission of its own).
 * `AuditLog`: only `PutItem` and `Query` — no `UpdateItem`/`DeleteItem` (append-only, Req 11.3).
 * Reload (`lambda:Get/UpdateFunctionConfiguration`) only on the Search_API, MCP_Server and
 * connector functions (Req 10.7). CloudWatch reads (`GetMetricData`, `ListMetrics`,
 * `DescribeAlarms`) have no resource-level scoping for these list calls, hence `*`.
 */
function grantManagement(fn: NodejsFunction, props: ManagementStackProps): void {
  const { data, stores, identity } = props;
  const stack = Stack.of(fn);

  // Access path: authentication, rate limit, audit.
  allow(fn, ['dynamodb:UpdateItem'], [data.rateLimitCounters.tableArn]);
  allow(
    fn,
    ['dynamodb:PutItem', 'dynamodb:Query'],
    [data.auditLog.tableArn, indexArn(data.auditLog, AUDIT_LOG_BY_AGENCY_INDEX)],
  );
  allow(
    fn,
    ['ssm:GetParameter', 'ssm:GetParameters'],
    [
      ssmParameterArn(stack, props.frontendOriginParameter),
      ssmParameterArn(stack, managementRateLimitParameterName(props.envName)),
      ssmParameterArn(stack, data.parameterNames.duplicateDetection),
    ],
  );

  // Identity: agencies, memberships, Plattform_Admin counter, machine access, Cognito.
  allow(
    fn,
    [
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
      'dynamodb:ConditionCheckItem',
      'dynamodb:Query',
      'dynamodb:Scan',
    ],
    [
      stores.membershipsTable.tableArn,
      indexArn(stores.membershipsTable, MEMBERSHIPS_BY_AGENCY_INDEX),
    ],
  );
  allow(
    fn,
    [
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:ConditionCheckItem',
      'dynamodb:Query',
    ],
    [stores.agenciesTable.tableArn, indexArn(stores.agenciesTable, AGENCIES_BY_STATE_INDEX)],
  );
  allow(
    fn,
    ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:ConditionCheckItem'],
    [stores.platformCountersTable.tableArn],
  );
  allow(
    fn,
    ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
    [
      stores.machineAccessTable.tableArn,
      indexArn(stores.machineAccessTable, MACHINE_ACCESS_BY_AGENCY_INDEX),
    ],
  );
  allow(
    fn,
    ['cognito-idp:ListUsers', 'cognito-idp:AdminCreateUser'],
    [identity.userPool.userPoolArn],
  );

  // Listings and versions (VersionedListingWriter like the connectors, plus the reads).
  allow(
    fn,
    ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Scan'],
    [data.listings.tableArn],
  );
  allow(
    fn,
    ['dynamodb:Query'],
    [
      indexArn(data.listings, LISTINGS_BY_AGENCY_INDEX),
      indexArn(data.listings, LISTINGS_BY_SOURCE_INDEX),
    ],
  );
  allow(
    fn,
    ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
    [stores.listingVersionsTable.tableArn],
  );
  allow(
    fn,
    ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
    [stores.listingKeysTable.tableArn],
  );
  allow(
    fn,
    ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
    [stores.metricCountersTable.tableArn],
  );
  // Writer check (`ConditionCheckItem`/`GetItem`); `/platform/deletion-blocklist` lifts a block
  // (`DeleteItem`), deletion requests block ids (`PutItem`/`UpdateItem` in a transaction).
  allow(
    fn,
    [
      'dynamodb:GetItem',
      'dynamodb:ConditionCheckItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
    ],
    [data.deletionBlocklist.tableArn],
  );
  // Duplikat_Index (duplicate-detection): the writer puts and deletes profiles, blocks and exact
  // keys in its transactions; the detector reads profiles, exact keys and the `byBlock` index.
  allow(
    fn,
    [
      'dynamodb:GetItem',
      'dynamodb:BatchGetItem',
      'dynamodb:PutItem',
      'dynamodb:DeleteItem',
      'dynamodb:ConditionCheckItem',
    ],
    [stores.duplicateIndexTable.tableArn],
  );
  allow(fn, ['dynamodb:Query'], [indexArn(stores.duplicateIndexTable, DUPLICATE_INDEX_BY_BLOCK)]);
  // Idempotenzschlüssel: read before, put in the creating transaction.
  allow(fn, ['dynamodb:GetItem', 'dynamodb:PutItem'], [stores.idempotencyKeysTable.tableArn]);
  // Agenturübergreifende_Treffer: list by state, dismiss (conditional put in a transaction).
  allow(fn, ['dynamodb:GetItem', 'dynamodb:PutItem'], [stores.duplicateReportsTable.tableArn]);
  allow(
    fn,
    ['dynamodb:Query'],
    [indexArn(stores.duplicateReportsTable, DUPLICATE_REPORTS_BY_STATE)],
  );
  const snapshots = stores.snapshotBucket;
  allow(fn, ['s3:GetObject', 's3:PutObject'], [snapshots.arnForObjects(snapshotKey('*', '*'))]);
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [snapshots.bucketArn],
      conditions: { StringLike: { 's3:prefix': [`${snapshotPrefix('*')}*`] } },
    }),
  );
  stores.snapshotKey.grantEncryptDecrypt(fn);
  // Content rules of manual edits: same files as the import (taxonomy, tour and PII lists);
  // `ListBucket` so a missing optional file is NoSuchKey, not AccessDenied.
  allow(
    fn,
    ['s3:GetObject'],
    Object.values(MANAGEMENT_CONFIG_FILES).map((key) => data.configBucket.arnForObjects(key)),
  );
  allow(fn, ['s3:ListBucket'], [data.configBucket.bucketArn]);

  // Monitoring: run log, CloudWatch metrics and alarms.
  allow(
    fn,
    ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan'],
    [
      stores.connectorRunsTable.tableArn,
      indexArn(stores.connectorRunsTable, CONNECTOR_RUNS_BY_AGENCY_INDEX),
    ],
  );
  allow(fn, ['dynamodb:GetItem', 'dynamodb:Query'], [stores.runRejectionsTable.tableArn]);
  allow(
    fn,
    ['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics', 'cloudwatch:DescribeAlarms'],
    ['*'],
  );

  // Platform operations: the grants of the Admin-API (Req 10.7) plus reload.
  allow(fn, ['dynamodb:PutItem', 'dynamodb:UpdateItem'], [data.apiKeys.tableArn]);
  allow(fn, ['dynamodb:PutItem', 'dynamodb:GetItem'], [data.deletionRequests.tableArn]);
  allow(
    fn,
    ['ssm:PutParameter'],
    [
      ssmParameterArn(stack, data.parameterNames.accessMode),
      ssmParameterArn(stack, data.parameterNames.rateLimit),
      // Ein/Aus of the Duplikat-Erkennung (`PUT /platform/duplicate-detection`).
      ssmParameterArn(stack, data.parameterNames.duplicateDetection),
    ],
  );
  props.deletionStateMachine.grantStartExecution(fn);
  allow(
    fn,
    ['lambda:GetFunctionConfiguration', 'lambda:UpdateFunctionConfiguration'],
    props.reloadableFunctions.map((target) => target.functionArn),
  );
}

/**
 * CORS headers of gateway-generated errors (throttling, WAF, integration failure). Static, so
 * only set when the allowlist has exactly one origin (the CloudFront origin without extra
 * `corsAllowedOrigins`); see `staticCorsHeaders` of the Search_API.
 */
export function managementGatewayCorsHeaders(
  corsOrigins: readonly string[],
): Record<string, string> {
  const [origin, ...more] = corsOrigins;
  if (origin === undefined || more.length > 0) return {};
  return {
    'Access-Control-Allow-Origin': `'${origin}'`,
    'Access-Control-Expose-Headers': `'${MANAGEMENT_CORS_EXPOSED_HEADERS.join(', ')}'`,
    Vary: "'Origin'",
  };
}

function wafMetricName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '-');
}

/** Per-IP flood protection of the Management_API; the Req 2.9 limits are enforced in Lambda. */
function managementWebAcl(
  scope: Construct,
  id: string,
  limit: number,
  corsOrigins: readonly string[],
): CfnWebACL {
  const [origin, ...more] = corsOrigins;
  const corsHeaders =
    origin !== undefined && more.length === 0
      ? [
          { name: 'Access-Control-Allow-Origin', value: origin },
          { name: 'Vary', value: 'Origin' },
        ]
      : [];
  const visibility = (metricName: string): CfnWebACL.VisibilityConfigProperty => ({
    cloudWatchMetricsEnabled: true,
    sampledRequestsEnabled: true,
    metricName: wafMetricName(metricName),
  });
  return new CfnWebACL(scope, 'ManagementApiWebAcl', {
    name: `${id}-management`,
    description: 'Per-IP flood protection of the Management API',
    scope: 'REGIONAL',
    defaultAction: { allow: {} },
    visibilityConfig: visibility(`${id}-management`),
    customResponseBodies: {
      rateLimited: {
        contentType: 'APPLICATION_JSON',
        content: JSON.stringify(WAF_RATE_LIMITED_BODY),
      },
    },
    rules: [
      {
        name: 'ip-rate-limit',
        priority: 0,
        statement: {
          rateBasedStatement: {
            aggregateKeyType: 'IP',
            limit,
            evaluationWindowSec: WAF_RATE_LIMIT_WINDOW_SECONDS,
          },
        },
        action: {
          block: {
            customResponse: {
              responseCode: 429,
              customResponseBodyKey: 'rateLimited',
              ...(corsHeaders.length > 0 && { responseHeaders: corsHeaders }),
            },
          },
        },
        visibilityConfig: visibility(`${id}-management-ip-rate-limit`),
      },
    ],
  });
}
