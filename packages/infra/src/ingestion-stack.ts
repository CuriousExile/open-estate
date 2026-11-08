import * as path from 'node:path';
import { ArnFormat, Duration, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import type { ITableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { CfnSchedule } from 'aws-cdk-lib/aws-scheduler';
import {
  Choice,
  Condition,
  DefinitionBody,
  Fail,
  JsonPath,
  LogLevel,
  StateMachine,
  Succeed,
  TaskInput,
} from 'aws-cdk-lib/aws-stepfunctions';
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import {
  DEFAULT_METRICS_NAMESPACE,
  DUPLICATE_INDEX_BY_BLOCK,
  snapshotKey,
} from '@open-estate/core';
import {
  CONNECTOR_CONFIG_FILES,
  CONNECTOR_LAMBDA_ENV,
  connectorsFileSchema,
  type ConnectorConfig,
  type ConnectorRunEvent,
  type ConnectorsFile,
} from '@open-estate/ingestion';
import { Construct } from 'constructs';
import { observabilityEnvironment, ssmParameterArn } from './api-stack';
import type { ObservabilitySettings } from './config';
import type { ConfigFile } from './config-files';

// Same relative depth from `src/` (ts) and `dist/` (compiled js).
const REPO_ROOT = path.resolve(__dirname, '../../..');
const INGESTION_PACKAGE = path.join(REPO_ROOT, 'packages/ingestion');

/** Tag on every resource of one connector, to map logs and executions back to `connectors.json`. */
export const CONNECTOR_TAG = 'open-estate:connector';

/** Error name of the failed execution when the run summary has status `FAILURE`. */
export const CONNECTOR_RUN_FAILED_ERROR = 'ConnectorRunFailed';

/**
 * `connectors.json` as uploaded to the config bucket (already validated by `loadConfigDirectory`);
 * a config directory without the file has no connectors.
 */
export function connectorsFromConfigFiles(files: readonly ConfigFile[]): ConnectorsFile {
  const file = files.find((f) => f.key === CONNECTOR_CONFIG_FILES.connectors);
  return file === undefined ? [] : connectorsFileSchema.parse(JSON.parse(file.content));
}

/**
 * Stores of the `VersionedListingWriter` the import writes through (design: "Import-Pipeline",
 * Req 12): version metadata, Custom_Id keys, counters and the content-addressed snapshots. Owned
 * by the ManagementStack (task 12.2); the connector Lambda refuses to start without them.
 */
export interface ConnectorVersioningResources {
  readonly listingVersions: ITableV2;
  readonly listingKeys: ITableV2;
  readonly metricCounters: ITableV2;
  readonly snapshotBucket: IBucket;
  /** Run summaries and rejections of the persisting run log (Req 13.2, 13.3). */
  readonly connectorRuns: ITableV2;
  readonly runRejections: ITableV2;
  /** Duplikat_Index of the Duplikat_Prüfung of imports (duplicate-detection Req 5.1, 6.1). */
  readonly duplicateIndex: ITableV2;
}

export interface IngestionStackProps extends StackProps {
  readonly tables: { readonly listings: ITableV2; readonly deletionBlocklist: ITableV2 };
  readonly configBucket: IBucket;
  /**
   * Versioned write path; optional only until the ManagementStack (task 12.2) provides it in
   * `app.ts`. Without it the functions get neither the variables nor the grants.
   */
  readonly versioning?: ConnectorVersioningResources;
  /**
   * SSM parameter with Ein/Aus of the Duplikat-Erkennung (`/open-estate/<env>/duplicate-detection`,
   * duplicate-detection design: "Ein- und Ausschalten"). Without it imports always check.
   */
  readonly duplicateDetectionParameter?: string;
  /** Registrations from `connectors.json`; one schedule, state machine and Lambda each. */
  readonly connectors: ConnectorsFile;
  readonly removalPolicy: RemovalPolicy;
  /** Log level and metrics toggle applied to every connector Lambda. */
  readonly observability: ObservabilitySettings;
}

/** Resources of one connector. */
export interface ConnectorResources {
  readonly config: ConnectorConfig;
  readonly function: NodejsFunction;
  readonly stateMachine: StateMachine;
  readonly schedule: CfnSchedule;
}

/**
 * Connector orchestration (design: "EventBridge Scheduler → Step Functions → Lambda", Req 5.7,
 * 11.1): per registered connector one EventBridge schedule (from `schedule`, `DISABLED` while
 * `enabled = false`), one state machine and one Lambda.
 *
 * Why one state machine and one Lambda per connector: the run time limit must stop the affected
 * connector only (Req 5.7). The execution timeout (`TimeoutSeconds`) ends the execution, but
 * Step Functions cannot stop a running Lambda invocation; only the function's own timeout does.
 * A Lambda timeout is a property of the function, so each connector gets its own function with
 * timeout = execution timeout = `timeoutSeconds` (≤ 900 s, the Lambda maximum; enforced by
 * `connectorsFileSchema`). Executions of different connectors share nothing, so a timeout or
 * failure of one connector does not affect the others. All functions bundle the same entry.
 * A timed-out or failed execution is logged by Step Functions (log level ERROR) and the Lambda.
 */
export class IngestionStack extends Stack {
  readonly connectors: readonly ConnectorResources[];
  /** Role EventBridge Scheduler assumes to start the executions. */
  readonly schedulerRole: Role;

  constructor(scope: Construct, id: string, props: IngestionStackProps) {
    super(scope, id, props);
    // Props may be built by hand (tests, forks): same checks as `connectors.json` at synth.
    const connectors = connectorsFileSchema.parse(props.connectors);

    this.schedulerRole = new Role(this, 'SchedulerRole', {
      description: 'EventBridge Scheduler: start connector executions',
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    });

    this.connectors = connectors.map((config) => this.addConnector(config, props));
  }

  private addConnector(config: ConnectorConfig, props: IngestionStackProps): ConnectorResources {
    // Connector ids are unique slugs: valid, collision-free construct ids.
    const scope = new Construct(this, `Connector-${config.id}`);
    Tags.of(scope).add(CONNECTOR_TAG, config.id);
    const timeout = Duration.seconds(config.timeoutSeconds);

    const fn = new NodejsFunction(scope, 'Function', {
      description: `Connector run: ${config.id}`,
      entry: path.join(INGESTION_PACKAGE, 'src/connector-handler.ts'),
      handler: 'handler',
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout,
      logGroup: new LogGroup(scope, 'FunctionLogs', {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: props.removalPolicy,
      }),
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        [CONNECTOR_LAMBDA_ENV.listingsTable]: props.tables.listings.tableName,
        [CONNECTOR_LAMBDA_ENV.deletionBlocklistTable]: props.tables.deletionBlocklist.tableName,
        [CONNECTOR_LAMBDA_ENV.configBucket]: props.configBucket.bucketName,
        [CONNECTOR_LAMBDA_ENV.connectorId]: config.id,
        // Same EMF namespace as the API and MCP Lambdas (platform monitoring, Req 14.1).
        POWERTOOLS_METRICS_NAMESPACE: DEFAULT_METRICS_NAMESPACE,
        ...observabilityEnvironment(props.observability),
        ...versioningEnvironment(props.versioning),
        ...(props.duplicateDetectionParameter !== undefined && {
          [CONNECTOR_LAMBDA_ENV.duplicateDetectionParameter]: props.duplicateDetectionParameter,
        }),
      },
      bundling: {
        // Local esbuild (pinned devDependency), never Docker.
        forceDockerBundling: false,
        format: OutputFormat.CJS,
        target: 'node22',
        minify: true,
        sourceMap: true,
        tsconfig: path.join(INGESTION_PACKAGE, 'tsconfig.json'),
        // Bundle the pinned AWS SDK. `pg-native` is an optional native binding of `pg` that is
        // only loaded on `pg.native` access, which the relational-db connector never does.
        externalModules: ['pg-native'],
      },
    });
    grantConnectorRun(fn, props, config);

    const runFailed = new Fail(scope, 'RunFailed', {
      error: CONNECTOR_RUN_FAILED_ERROR,
      cause: 'Connector run finished with status FAILURE; see the run log',
    });
    const payload: ConnectorRunEvent = { connectorId: config.id };
    const definition = new LambdaInvoke(scope, 'RunConnector', {
      lambdaFunction: fn,
      payload: TaskInput.fromObject({
        ...payload,
        // The execution name doubles as run id, linking run log and execution history.
        runId: JsonPath.executionName,
      }),
      payloadResponseOnly: true,
    }).next(
      new Choice(scope, 'RunStatus')
        .when(Condition.stringEquals('$.status', 'FAILURE'), runFailed)
        .otherwise(new Succeed(scope, 'RunSucceeded')),
    );

    const stateMachine = new StateMachine(scope, 'StateMachine', {
      comment: `Connector run: ${config.id}`,
      definitionBody: DefinitionBody.fromChainable(definition),
      timeout,
      logs: {
        destination: new LogGroup(scope, 'StateMachineLogs', {
          retention: RetentionDays.ONE_MONTH,
          removalPolicy: props.removalPolicy,
        }),
        level: LogLevel.ERROR,
        // Errors and timeouts only, without payloads.
        includeExecutionData: false,
      },
    });
    stateMachine.grantStartExecution(this.schedulerRole);

    const schedule = new CfnSchedule(scope, 'Schedule', {
      description: `Connector run: ${config.id}`,
      scheduleExpression: config.schedule,
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: { mode: 'OFF' },
      state: config.enabled ? 'ENABLED' : 'DISABLED',
      target: {
        arn: stateMachine.stateMachineArn,
        roleArn: this.schedulerRole.roleArn,
        input: JSON.stringify(payload),
      },
    });
    // The role's policy must exist before the scheduler validates the target.
    schedule.node.addDependency(this.schedulerRole);

    return { config, function: fn, stateMachine, schedule };
  }
}

/** Matches the 6-character suffix Secrets Manager appends to secret ARNs. */
const SECRET_ARN_SUFFIX = /-[A-Za-z0-9]{6}$/;

/**
 * IAM resource of a `secretRef`. A name or a partial ARN (without the random suffix) matches the
 * secret via `-??????`, as recommended by Secrets Manager; a complete ARN is used as is.
 */
export function secretResourceArn(stack: Stack, secretRef: string): string {
  if (secretRef.startsWith('arn:')) {
    return SECRET_ARN_SUFFIX.test(secretRef) ? secretRef : `${secretRef}-??????`;
  }
  return stack.formatArn({
    service: 'secretsmanager',
    resource: 'secret',
    resourceName: `${secretRef}-??????`,
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
  });
}

/**
 * Least privilege of one connector run: the atomic upsert (`TransactWriteItems` needs `PutItem`
 * on `Listings` and `ConditionCheckItem` on `DeletionBlocklist`), the blocklist pre-check
 * (`GetItem`), the connector's config files plus `ListBucket` (so a missing optional file is
 * `NoSuchKey`, not AccessDenied) and only this connector's `secretRef`.
 */
function grantConnectorRun(
  fn: NodejsFunction,
  props: IngestionStackProps,
  config: ConnectorConfig,
): void {
  const { listings, deletionBlocklist } = props.tables;
  fn.addToRolePolicy(
    new PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [listings.tableArn] }),
  );
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ['dynamodb:ConditionCheckItem', 'dynamodb:GetItem'],
      resources: [deletionBlocklist.tableArn],
    }),
  );
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ['s3:GetObject'],
      resources: Object.values(CONNECTOR_CONFIG_FILES).map((key) =>
        props.configBucket.arnForObjects(key),
      ),
    }),
  );
  fn.addToRolePolicy(
    new PolicyStatement({ actions: ['s3:ListBucket'], resources: [props.configBucket.bucketArn] }),
  );
  if (config.secretRef !== undefined) {
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [secretResourceArn(Stack.of(fn), config.secretRef)],
      }),
    );
  }
  if (props.versioning !== undefined) grantVersionedWrite(fn, props.tables, props.versioning);
  if (props.duplicateDetectionParameter !== undefined) {
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [ssmParameterArn(Stack.of(fn), props.duplicateDetectionParameter)],
      }),
    );
  }
}

/** Variables of the versioned write path (empty without it). */
function versioningEnvironment(
  versioning: ConnectorVersioningResources | undefined,
): Record<string, string> {
  if (versioning === undefined) return {};
  return {
    [CONNECTOR_LAMBDA_ENV.listingVersionsTable]: versioning.listingVersions.tableName,
    [CONNECTOR_LAMBDA_ENV.listingKeysTable]: versioning.listingKeys.tableName,
    [CONNECTOR_LAMBDA_ENV.metricCountersTable]: versioning.metricCounters.tableName,
    [CONNECTOR_LAMBDA_ENV.snapshotBucket]: versioning.snapshotBucket.bucketName,
    [CONNECTOR_LAMBDA_ENV.connectorRunsTable]: versioning.connectorRuns.tableName,
    [CONNECTOR_LAMBDA_ENV.runRejectionsTable]: versioning.runRejections.tableName,
    [CONNECTOR_LAMBDA_ENV.duplicateIndexTable]: versioning.duplicateIndex.tableName,
  };
}

/**
 * Least privilege of the `VersionedListingWriter` in one transaction (Req 7.1, 12): `UpdateItem`
 * on `Listings` (provenance touch of an unchanged import), `PutItem` and the conflict read
 * (`GetItem`, `Query`) on `ListingVersions`, Custom_Id lookup, assignment and release on
 * `ListingKeys`, the `ADD` on `MetricCounters` and `PutObject` of the snapshots (with
 * `kms:GenerateDataKey` if the bucket uses a key). The Custom_Id blocklist check (`custom#…`) uses
 * the `DeletionBlocklist` grant of {@link grantConnectorRun}. No `DeleteObject`, no `Scan`.
 * The run log writes `ConnectorRuns` and `RunRejections` with `BatchWriteItem` (puts only): no
 * read, update or delete, so a connector cannot alter recorded runs.
 */
function grantVersionedWrite(
  fn: NodejsFunction,
  tables: IngestionStackProps['tables'],
  versioning: ConnectorVersioningResources,
): void {
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [tables.listings.tableArn],
    }),
  );
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:Query'],
      resources: [versioning.listingVersions.tableArn],
    }),
  );
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
      resources: [versioning.listingKeys.tableArn],
    }),
  );
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [versioning.metricCounters.tableArn],
    }),
  );
  versioning.snapshotBucket.grantPut(fn, snapshotKey('*', '*'));
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ['dynamodb:PutItem', 'dynamodb:BatchWriteItem'],
      resources: [versioning.connectorRuns.tableArn, versioning.runRejections.tableArn],
    }),
  );
  // Duplikat_Prüfung (duplicate-detection Req 5.1, 6.1): the detector reads profiles, exact keys
  // and the `byBlock` index; the writer puts and deletes index items in its transaction.
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: [
        'dynamodb:GetItem',
        'dynamodb:BatchGetItem',
        'dynamodb:PutItem',
        'dynamodb:DeleteItem',
        'dynamodb:ConditionCheckItem',
      ],
      resources: [versioning.duplicateIndex.tableArn],
    }),
  );
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [`${versioning.duplicateIndex.tableArn}/index/${DUPLICATE_INDEX_BY_BLOCK}`],
    }),
  );
}
