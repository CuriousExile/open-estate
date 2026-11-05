import * as path from 'node:path';
import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  AuthorizationType,
  EndpointType,
  LambdaIntegration,
  ResponseType,
  RestApi,
} from 'aws-cdk-lib/aws-apigateway';
import type { ITableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Alias } from 'aws-cdk-lib/aws-kms';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { CfnSchedule } from 'aws-cdk-lib/aws-scheduler';
import { Topic } from 'aws-cdk-lib/aws-sns';
import {
  Choice,
  Condition,
  DefinitionBody,
  DistributedMap,
  JitterType,
  JsonPath,
  LogLevel,
  StateMachine,
  StateMachineType,
  TaskInput,
} from 'aws-cdk-lib/aws-stepfunctions';
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import {
  ADMIN_ENV,
  DELETION_ENV,
  DELETION_HISTORY_ENV,
  OVERDUE_CHECK_ENV,
  type DeletionTaskEvent,
} from '@open-estate/admin';
import {
  DELETION_REQUESTS_BY_STATUS_INDEX,
  LISTINGS_BY_SOURCE_INDEX,
  snapshotPrefix,
} from '@open-estate/core';
import type { ErrorCode } from '@open-estate/shared';
import type { Construct } from 'constructs';
import {
  addGatewayResponses,
  bundledFunction,
  GATEWAY_RESPONSES,
  ssmParameterArn,
  type GatewayResponseMapping,
} from './api-stack';
import type { SsmParameterNames } from './data-stack';

// Same relative depth from `src/` (ts) and `dist/` (compiled js).
const REPO_ROOT = path.resolve(__dirname, '../../..');
const ADMIN_PACKAGE = path.join(REPO_ROOT, 'packages/admin');

/** Path prefix of every admin route (design: "Admin-API und Löschprozess"). */
export const ADMIN_ROUTE_PREFIX = 'admin';

/** Rate of the overdue check (Req 18.10: notify once a request is OPEN for more than 24 h). */
export const OVERDUE_CHECK_SCHEDULE = 'rate(1 hour)';

/** Listings deleted in parallel per `resolveTargets` page (DynamoDB stays far below limits). */
export const DELETION_MAX_CONCURRENCY = 10;

/** Stage limits of the Admin-API: a handful of operators, no public traffic. */
const ADMIN_THROTTLING_RATE_LIMIT = 10;
const ADMIN_THROTTLING_BURST_LIMIT = 20;

/**
 * Errors of the deletion task that a retry cannot fix: invalid task input (`ZodError`) and an
 * unknown request id. Everything else (throttling, transaction conflicts, Lambda service errors,
 * timeouts) is treated as transient — every workflow step is idempotent.
 */
export const DELETION_PERMANENT_ERRORS = ['ZodError', 'DeletionRequestNotFoundError'] as const;

const FORBIDDEN: Pick<GatewayResponseMapping, 'code' | 'message'> = {
  code: 'FORBIDDEN' satisfies ErrorCode,
  message: 'Administrator permission required.',
};

/**
 * Gateway responses of the Admin-API: those of the Search_API, except that a request without
 * (valid) SigV4 signature — API Gateway's MISSING_AUTHENTICATION_TOKEN — is a missing permission
 * here, so it answers 403 FORBIDDEN instead of 404 NOT_FOUND (Req 18.11). This also covers paths
 * outside `/admin/*`, which then do not reveal whether a route exists. ACCESS_DENIED (signed, but
 * no `execute-api:Invoke`), INVALID_SIGNATURE and EXPIRED_TOKEN answer FORBIDDEN as well.
 */
export const ADMIN_GATEWAY_RESPONSES: readonly GatewayResponseMapping[] = GATEWAY_RESPONSES.filter(
  // No WAF on the Admin-API (IAM rejects unsigned requests before any Lambda runs).
  ({ type }) => type !== ResponseType.WAF_FILTERED,
).map((mapping) =>
  [
    ResponseType.MISSING_AUTHENTICATION_TOKEN,
    ResponseType.ACCESS_DENIED,
    ResponseType.INVALID_SIGNATURE,
    ResponseType.EXPIRED_TOKEN,
  ].includes(mapping.type)
    ? { type: mapping.type, statusCode: 403, ...FORBIDDEN }
    : mapping,
);

/** Tables of the admin side, provided by the DataStack. */
export interface AdminTables {
  readonly listings: ITableV2;
  readonly apiKeys: ITableV2;
  readonly deletionRequests: ITableV2;
  readonly deletionBlocklist: ITableV2;
  readonly auditLog: ITableV2;
}

/**
 * Stores of the version history a deletion request removes besides the listing (design:
 * "Löschprozess-Erweiterung", Req 9.2, 9.3): versions, Custom_Id keys, counters and snapshots.
 * Owned by the ManagementStack (task 12.2); `ConnectorVersioningResources` satisfies it.
 */
export interface DeletionHistoryResources {
  readonly listingVersions: ITableV2;
  readonly listingKeys: ITableV2;
  readonly metricCounters: ITableV2;
  readonly snapshotBucket: IBucket;
}

export interface AdminStackProps extends StackProps {
  readonly tables: AdminTables;
  /**
   * Version history removed by the deletion task; optional only until the ManagementStack (task
   * 12.2) provides it in `app.ts`. Without it the task gets neither the variables nor the grants
   * and refuses to start (`CONFIG_MISSING`) rather than leave versions behind.
   */
  readonly history?: DeletionHistoryResources;
  /** SSM names of `access-mode` and `rate-limit`, written by the admin API (Req 17.8). */
  readonly parameterNames: Pick<SsmParameterNames, 'accessMode' | 'rateLimit'>;
  /**
   * Functions that load configuration at init only (Search_API, MCP_Server, connectors):
   * `open-estate-admin reload` raises their `CONFIG_VERSION` (design: „Neustart“, Req 15.3, 16.8).
   */
  readonly reloadableFunctions: readonly IFunction[];
  readonly stageName: string;
  readonly removalPolicy: RemovalPolicy;
}

/**
 * Admin side (Req 17.8, 18.4–18.11): the IAM-authorized Admin-API, the GDPR deletion workflow,
 * the hourly overdue check with its SNS topic, and the managed policy that defines the
 * Administrator role.
 *
 * Why a separate RestApi instead of `/admin/*` on the Search_API: on one REST API, a request
 * without SigV4 signature yields MISSING_AUTHENTICATION_TOKEN, which the Search_API must map to
 * 404 NOT_FOUND (it is also the "unknown route" response there). Req 18.11 requires 403 for a
 * missing administrator permission, so the Admin-API gets its own gateway responses
 * ({@link ADMIN_GATEWAY_RESPONSES}). It also keeps admin traffic out of the public WAF, throttling
 * and metrics, and needs no WAF itself: unsigned requests are rejected before any Lambda runs.
 *
 * Overdue notifications (Req 18.10) go to one topic with the message attribute `adminArn` (the
 * requester's IAM `userArn`). Subscriptions are not managed here — administrators come and go
 * without a deployment; each subscribes with a filter policy on their own ARN, e.g.:
 *
 *   aws sns subscribe --topic-arn <OverdueTopicArn> --protocol email \
 *     --notification-endpoint admin@example.org \
 *     --attributes '{"FilterPolicy":"{\"adminArn\":[\"<userArn>\"]}"}'
 *
 * The `userArn` is the one the Admin-API records as `requestedBy`; for assumed roles that is
 * `arn:aws:sts::<account>:assumed-role/<role>/<session>`, so the session name must be stable.
 * Every notification also carries `requesterId` (= `requestedBy`, for requests of a
 * Plattform_Admin via the Management_API the user id); filter on it to cover both kinds.
 */
export class AdminStack extends Stack {
  readonly api: RestApi;
  readonly adminFunction: NodejsFunction;
  readonly deletionTaskFunction: NodejsFunction;
  readonly overdueCheckFunction: NodejsFunction;
  readonly deletionStateMachine: StateMachine;
  readonly overdueTopic: Topic;
  readonly overdueSchedule: CfnSchedule;
  /** Attach to the IAM principals of administrators (design: "Admin-Authentifizierung"). */
  readonly administratorPolicy: ManagedPolicy;

  constructor(scope: Construct, id: string, props: AdminStackProps) {
    super(scope, id, props);
    const { tables, removalPolicy } = props;

    this.deletionTaskFunction = bundledFunction(this, 'DeletionTaskFunction', {
      description: 'Deletion workflow task: resolveTargets / deleteListing / finalize',
      packageDir: ADMIN_PACKAGE,
      entry: 'src/deletion-task.ts',
      memorySize: 256,
      timeout: Duration.seconds(30),
      removalPolicy,
    });
    grantDeletionTask(this.deletionTaskFunction, tables, props.history);

    this.deletionStateMachine = this.deletionWorkflow(removalPolicy);

    this.adminFunction = bundledFunction(this, 'AdminFunction', {
      description: 'Admin-API /admin/* (IAM)',
      packageDir: ADMIN_PACKAGE,
      entry: 'src/admin.ts',
      memorySize: 256,
      timeout: Duration.seconds(10),
      removalPolicy,
    });
    grantAdminApi(this.adminFunction, props, this.deletionStateMachine);

    this.overdueTopic = new Topic(this, 'OverdueDeletionTopic', {
      displayName: 'Open Estate: overdue deletion requests',
      // AWS managed key: SNS-internal encryption at rest; the publishing Lambda and email/SQS
      // subscribers need no key grants.
      masterKey: Alias.fromAliasName(this, 'SnsManagedKey', 'alias/aws/sns'),
      enforceSSL: true,
    });

    // The Scheduler invokes asynchronously; no Lambda retries, the next hourly run catches up
    // (notifications are deduplicated by `notifiedAt`).
    this.overdueCheckFunction = bundledFunction(this, 'OverdueCheckFunction', {
      description: 'Hourly check of deletion requests open for more than 24 h (Req 18.10)',
      packageDir: ADMIN_PACKAGE,
      entry: 'src/overdue-check.ts',
      memorySize: 256,
      timeout: Duration.minutes(5),
      removalPolicy,
      retryAttempts: 0,
    });
    grantOverdueCheck(this.overdueCheckFunction, tables, this.overdueTopic);

    const schedulerRole = new Role(this, 'OverdueSchedulerRole', {
      description: 'EventBridge Scheduler: invoke the overdue deletion check',
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    });
    this.overdueCheckFunction.grantInvoke(schedulerRole);
    this.overdueSchedule = new CfnSchedule(this, 'OverdueCheckSchedule', {
      description: 'Hourly overdue check of deletion requests (Req 18.10)',
      scheduleExpression: OVERDUE_CHECK_SCHEDULE,
      flexibleTimeWindow: { mode: 'OFF' },
      state: 'ENABLED',
      target: {
        arn: this.overdueCheckFunction.functionArn,
        roleArn: schedulerRole.roleArn,
        retryPolicy: { maximumRetryAttempts: 0 },
      },
    });
    // The role's policy must exist before the scheduler validates the target.
    this.overdueSchedule.node.addDependency(schedulerRole);

    this.api = new RestApi(this, 'AdminApi', {
      restApiName: `${id}-admin`,
      description: 'Open Estate Admin-API (IAM)',
      endpointTypes: [EndpointType.REGIONAL],
      cloudWatchRole: false,
      deployOptions: {
        stageName: props.stageName,
        throttlingRateLimit: ADMIN_THROTTLING_RATE_LIMIT,
        throttlingBurstLimit: ADMIN_THROTTLING_BURST_LIMIT,
      },
    });
    // One proxy resource for all admin routes; the handler matches method and path and answers
    // unknown routes itself. IAM authorization applies to every method; the handler reads the
    // caller from `requestContext.identity.userArn` (audit, `requestedBy`).
    this.api.root
      .addResource(ADMIN_ROUTE_PREFIX)
      .addResource('{proxy+}')
      .addMethod('ANY', new LambdaIntegration(this.adminFunction, { proxy: true }), {
        authorizationType: AuthorizationType.IAM,
      });
    addGatewayResponses(this.api, ADMIN_GATEWAY_RESPONSES);

    this.administratorPolicy = new ManagedPolicy(this, 'AdministratorPolicy', {
      description: 'Open Estate Administrator: Admin-API, reload, overdue notifications',
      statements: [
        new PolicyStatement({
          actions: ['execute-api:Invoke'],
          resources: [this.api.arnForExecuteApi('*', `/${ADMIN_ROUTE_PREFIX}/*`, props.stageName)],
        }),
        // `open-estate-admin reload`: read and write back the environment with a new
        // CONFIG_VERSION (UpdateFunctionConfiguration replaces the whole environment).
        ...(props.reloadableFunctions.length > 0
          ? [
              new PolicyStatement({
                actions: ['lambda:GetFunctionConfiguration', 'lambda:UpdateFunctionConfiguration'],
                resources: props.reloadableFunctions.map((fn) => fn.functionArn),
              }),
            ]
          : []),
        // Self-service subscription to the overdue notifications, see `OverdueTopicArn`.
        new PolicyStatement({
          actions: ['sns:Subscribe'],
          resources: [this.overdueTopic.topicArn],
        }),
      ],
    });

    new CfnOutput(this, 'AdminApiUrl', {
      description: 'Base URL of the Admin-API stage (OPEN_ESTATE_ADMIN_URL of open-estate-admin)',
      value: this.api.url,
    });
    if (props.reloadableFunctions.length > 0) {
      new CfnOutput(this, 'ReloadFunctionNames', {
        description: 'Functions for open-estate-admin reload (OPEN_ESTATE_RELOAD_FUNCTIONS)',
        value: Fn.join(
          ',',
          props.reloadableFunctions.map((fn) => fn.functionName),
        ),
      });
    }
    new CfnOutput(this, 'OverdueTopicArn', {
      description:
        'SNS topic for overdue deletion requests; subscribe per administrator with the filter ' +
        'policy {"adminArn":["<IAM userArn>"]}',
      value: this.overdueTopic.topicArn,
    });
    new CfnOutput(this, 'AdministratorPolicyArn', {
      description: 'Managed policy defining the Administrator role; attach to admin principals',
      value: this.administratorPolicy.managedPolicyArn,
    });
  }

  /**
   * Standard workflow, execution name = request id (`StepFunctionsDeletionWorkflowStarter`):
   * `ResolveFirstPage` → `DeleteTargets` (Distributed Map over the page, one child execution per
   * listing, so large sources do not exhaust the 25,000-event history of the parent) → while a
   * `nextCursor` exists `ResolveNextPage` → `DeleteTargets` … → `Finalize`. A failure after all
   * retries fails the execution; the request stays OPEN and the overdue check reports it.
   */
  private deletionWorkflow(removalPolicy: RemovalPolicy): StateMachine {
    const fn = this.deletionTaskFunction;
    const task = (id: string, payload: TaskPayload, resultPath: string) =>
      withRetries(
        new LambdaInvoke(this, id, {
          lambdaFunction: fn,
          payload: TaskInput.fromObject(payload),
          payloadResponseOnly: true,
          // Covered by the retriers below, with the same backoff.
          retryOnServiceExceptions: false,
          resultPath,
        }),
      );

    // State: the execution input `{requestId}` plus the current target page under `$.page`.
    const requestId = JsonPath.stringAt('$.requestId');
    const firstPage = task('ResolveFirstPage', { step: 'resolveTargets', requestId }, '$.page');
    const nextPage = task(
      'ResolveNextPage',
      { step: 'resolveTargets', requestId, cursor: JsonPath.stringAt('$.page.nextCursor') },
      '$.page',
    );

    const itemSelector: TaskPayload = {
      step: 'deleteListing',
      requestId,
      listingId: JsonPath.stringAt('$$.Map.Item.Value.listingId'),
      source: JsonPath.stringAt('$$.Map.Item.Value.source'),
    };
    const deleteTargets = new DistributedMap(this, 'DeleteTargets', {
      itemsPath: '$.page.targets',
      itemSelector,
      maxConcurrency: DELETION_MAX_CONCURRENCY,
      // Steps are idempotent, so the at-least-once semantics of express children are fine.
      mapExecutionType: StateMachineType.EXPRESS,
      resultPath: JsonPath.DISCARD,
    });
    deleteTargets.itemProcessor(
      withRetries(
        new LambdaInvoke(this, 'DeleteListing', {
          lambdaFunction: fn,
          // Payload: the selected item.
          payloadResponseOnly: true,
          retryOnServiceExceptions: false,
        }),
      ),
    );

    const finalize = task('Finalize', { step: 'finalize', requestId }, JsonPath.DISCARD);

    const definition = firstPage.next(
      deleteTargets.next(
        new Choice(this, 'MoreTargets')
          .when(Condition.isPresent('$.page.nextCursor'), nextPage.next(deleteTargets))
          .otherwise(finalize),
      ),
    );

    return new StateMachine(this, 'DeletionStateMachine', {
      comment: 'GDPR deletion request: block, then remove every affected listing (Req 18.4)',
      definitionBody: DefinitionBody.fromChainable(definition),
      stateMachineType: StateMachineType.STANDARD,
      // Req 18.4 asks for completion within 24 h; a stuck execution ends there and the request
      // stays OPEN for the overdue notification.
      timeout: Duration.hours(24),
      logs: {
        destination: new LogGroup(this, 'DeletionStateMachineLogs', {
          retention: RetentionDays.ONE_MONTH,
          removalPolicy,
        }),
        level: LogLevel.ERROR,
        // Errors only, without payloads (listing ids, requester).
        includeExecutionData: false,
      },
    });
  }
}

/** Payload of a deletion task state; values may be JSONPath expressions (`JsonPath.stringAt`). */
type TaskPayload = { step: DeletionTaskEvent['step'] } & Record<string, unknown>;

/** No retry for {@link DELETION_PERMANENT_ERRORS}; everything else with exponential backoff. */
function withRetries<T extends LambdaInvoke>(task: T): T {
  task.addRetry({ errors: [...DELETION_PERMANENT_ERRORS], maxAttempts: 0 });
  task.addRetry({
    errors: ['States.ALL'],
    interval: Duration.seconds(2),
    backoffRate: 2,
    maxAttempts: 6,
    maxDelay: Duration.seconds(60),
    jitterStrategy: JitterType.FULL,
  });
  return task;
}

/** Sets every variable of an env-name map (`ADMIN_ENV` etc.); the record type forces all keys. */
function setEnvironment<K extends string>(
  fn: NodejsFunction,
  names: Readonly<Record<K, string>>,
  values: Record<K, string>,
): void {
  for (const key of Object.keys(names) as K[]) fn.addEnvironment(names[key], values[key]);
}

const indexArn = (table: ITableV2, name: string) => `${table.tableArn}/index/${name}`;

function allow(fn: NodejsFunction, actions: string[], resources: string[]): void {
  fn.addToRolePolicy(new PolicyStatement({ actions, resources }));
}

/**
 * Admin-API: `ApiKeys` Put (create) and Update (revoke, rate limit); SSM `PutParameter` on
 * access mode and global rate limit; `AuditLog` Put; `DeletionRequests` Put (create) and Get
 * (status); `Listings` Get and `bySource` Query (existence check, Req 18.9); `DeletionBlocklist`
 * Delete (lift a block, Req 18.6); `StartExecution` of the deletion workflow.
 */
function grantAdminApi(fn: NodejsFunction, props: AdminStackProps, workflow: StateMachine): void {
  const { listings, apiKeys, deletionRequests, deletionBlocklist, auditLog } = props.tables;
  setEnvironment(fn, ADMIN_ENV, {
    apiKeysTable: apiKeys.tableName,
    accessModeParameter: props.parameterNames.accessMode,
    rateLimitParameter: props.parameterNames.rateLimit,
    listingsTable: listings.tableName,
    deletionRequestsTable: deletionRequests.tableName,
    deletionBlocklistTable: deletionBlocklist.tableName,
    auditLogTable: auditLog.tableName,
    deletionStateMachineArn: workflow.stateMachineArn,
  });

  const stack = Stack.of(fn);
  allow(fn, ['dynamodb:PutItem', 'dynamodb:UpdateItem'], [apiKeys.tableArn]);
  allow(
    fn,
    ['ssm:PutParameter'],
    [
      ssmParameterArn(stack, props.parameterNames.accessMode),
      ssmParameterArn(stack, props.parameterNames.rateLimit),
    ],
  );
  allow(fn, ['dynamodb:PutItem'], [auditLog.tableArn]);
  allow(fn, ['dynamodb:PutItem', 'dynamodb:GetItem'], [deletionRequests.tableArn]);
  allow(fn, ['dynamodb:GetItem'], [listings.tableArn]);
  allow(fn, ['dynamodb:Query'], [indexArn(listings, LISTINGS_BY_SOURCE_INDEX)]);
  allow(fn, ['dynamodb:DeleteItem'], [deletionBlocklist.tableArn]);
  workflow.grantStartExecution(fn);
}

/**
 * Deletion task: `DeletionRequests` Get and Update (`markExecuted`, `removedCount` in the
 * transaction, incomplete listings); `Listings` Get, `bySource` Query and Delete (transaction);
 * `DeletionBlocklist` Put (conditional); `AuditLog` Put. With `history` additionally
 * {@link grantHistoryRemoval}.
 */
function grantDeletionTask(
  fn: NodejsFunction,
  tables: AdminTables,
  history: DeletionHistoryResources | undefined,
): void {
  const { listings, deletionRequests, deletionBlocklist, auditLog } = tables;
  setEnvironment(fn, DELETION_ENV, {
    listingsTable: listings.tableName,
    deletionRequestsTable: deletionRequests.tableName,
    deletionBlocklistTable: deletionBlocklist.tableName,
    auditLogTable: auditLog.tableName,
  });

  allow(fn, ['dynamodb:GetItem', 'dynamodb:UpdateItem'], [deletionRequests.tableArn]);
  allow(fn, ['dynamodb:GetItem', 'dynamodb:DeleteItem'], [listings.tableArn]);
  allow(fn, ['dynamodb:Query'], [indexArn(listings, LISTINGS_BY_SOURCE_INDEX)]);
  allow(fn, ['dynamodb:PutItem'], [deletionBlocklist.tableArn]);
  allow(fn, ['dynamodb:PutItem'], [auditLog.tableArn]);
  if (history !== undefined) grantHistoryRemoval(fn, tables, history);
}

/**
 * Removal of the version history (Req 9.2, 9.3): `ListingVersions` Query and `BatchWriteItem`
 * (deletes only — the purge sends no puts); `ListingKeys` Delete and `MetricCounters` Update in
 * the removal transaction; `DeletionBlocklist` Update (id and Custom_Id key blocked in one
 * transaction with `if_not_exists`); `ListBucket` restricted to the snapshot prefix and
 * `DeleteObject` on it. No `GetObject`/`PutObject`: the task never reads or writes content.
 */
function grantHistoryRemoval(
  fn: NodejsFunction,
  tables: AdminTables,
  history: DeletionHistoryResources,
): void {
  setEnvironment(fn, DELETION_HISTORY_ENV, {
    listingVersionsTable: history.listingVersions.tableName,
    listingKeysTable: history.listingKeys.tableName,
    metricCountersTable: history.metricCounters.tableName,
    snapshotBucket: history.snapshotBucket.bucketName,
  });

  allow(fn, ['dynamodb:Query', 'dynamodb:BatchWriteItem'], [history.listingVersions.tableArn]);
  allow(fn, ['dynamodb:DeleteItem'], [history.listingKeys.tableArn]);
  allow(fn, ['dynamodb:UpdateItem'], [history.metricCounters.tableArn]);
  allow(fn, ['dynamodb:UpdateItem'], [tables.deletionBlocklist.tableArn]);
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [history.snapshotBucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': [SNAPSHOT_PREFIX_PATTERN] } },
    }),
  );
  allow(fn, ['s3:DeleteObject'], [history.snapshotBucket.arnForObjects(SNAPSHOT_PREFIX_PATTERN)]);
}

/** All snapshot prefixes `listings/{id}/` (`snapshotPrefix` of core). */
const SNAPSHOT_PREFIX_PATTERN = `${snapshotPrefix('*')}*`;

/**
 * Overdue check: `byStatus` Query, `DeletionRequests` Get and Update (`markNotified`);
 * `Listings` Get and `bySource` Query (remaining count); `sns:Publish` on the topic.
 */
function grantOverdueCheck(fn: NodejsFunction, tables: AdminTables, topic: Topic): void {
  const { listings, deletionRequests } = tables;
  setEnvironment(fn, OVERDUE_CHECK_ENV, {
    listingsTable: listings.tableName,
    deletionRequestsTable: deletionRequests.tableName,
    overdueTopicArn: topic.topicArn,
  });

  allow(fn, ['dynamodb:Query'], [indexArn(deletionRequests, DELETION_REQUESTS_BY_STATUS_INDEX)]);
  allow(fn, ['dynamodb:GetItem', 'dynamodb:UpdateItem'], [deletionRequests.tableArn]);
  allow(fn, ['dynamodb:GetItem'], [listings.tableArn]);
  allow(fn, ['dynamodb:Query'], [indexArn(listings, LISTINGS_BY_SOURCE_INDEX)]);
  allow(fn, ['sns:Publish'], [topic.topicArn]);
}
