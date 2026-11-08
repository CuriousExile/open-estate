import * as path from 'node:path';
import { Duration, Stack, type RemovalPolicy } from 'aws-cdk-lib';
import {
  Alarm,
  ComparisonOperator,
  MathExpression,
  TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { ITableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { CfnSchedule } from 'aws-cdk-lib/aws-scheduler';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import {
  Choice,
  Condition,
  DefinitionBody,
  Fail,
  JitterType,
  JsonPath,
  LogLevel,
  Map as MapState,
  Parallel,
  Pass,
  StateMachine,
  StateMachineType,
  Succeed,
  TaskInput,
} from 'aws-cdk-lib/aws-stepfunctions';
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import {
  DEFAULT_METRICS_NAMESPACE,
  DUPLICATE_INDEX_BY_BLOCK,
  DUPLICATE_REPORTS_BY_STATE,
  READ_MODEL_CONFIG_FILES,
  SSM_PARAMETER_SUFFIX,
} from '@open-estate/core';
import { DUPLICATE_SWEEP_ENV, FRONTEND_ORIGIN_VALUE } from '@open-estate/management';
import { DUPLICATE_CONFIG_FILE, DuplicateConfig } from '@open-estate/shared';
import { Construct } from 'constructs';
import { bundledFunction, ssmParameterArn } from './api-stack';
import type { ObservabilitySettings } from './config';
import type { ConfigFile } from './config-files';

// Duplikat_Abgleich (duplicate-detection design: "Duplikat_Abgleich", Req 10): the Lambda of the
// sweep tasks, the `DuplicateSweep` state machine (Prepare → [switched off: end] → INDEX, ORPHAN,
// MATCH as Maps over the segments, each part a loop with cursor → RESOLVE loop → Finish), the
// daily EventBridge schedule and the alarm on failed or timed-out runs.

const REPO_ROOT = path.resolve(__dirname, '../../..');
const INFRA_PACKAGE = path.join(REPO_ROOT, 'packages/infra');

/** A run must end within 4 hours (Req 10.8, 10.9). */
export const DUPLICATE_SWEEP_TIMEOUT = Duration.hours(4);
/** Lambda maximum; each invocation stops its work 5 minutes before (≤ 10 min per step). */
export const DUPLICATE_SWEEP_LAMBDA_TIMEOUT = Duration.minutes(15);
/** Retries of a failed task (Req 10.8): 3 attempts with exponential backoff. */
export const DUPLICATE_SWEEP_RETRIES = 3;

/** Schedule settings of the Abgleich from `duplicate-detection.json` (defaults without it). */
export interface DuplicateSweepSettings {
  /** `HH:MM` UTC (Req 10.1). */
  readonly timeUtc: string;
}

/**
 * `sweep` of `duplicate-detection.json` as uploaded to the config bucket (already validated by
 * `loadConfigDirectory`); the documented defaults without the file. A changed time takes effect
 * with the next deployment.
 */
export function duplicateSweepSettings(files: readonly ConfigFile[]): DuplicateSweepSettings {
  const file = files.find((f) => f.key === DUPLICATE_CONFIG_FILE);
  const config = DuplicateConfig.parse(file === undefined ? undefined : JSON.parse(file.content));
  return { timeUtc: config.sweep.timeUtc };
}

/** EventBridge Scheduler expression of a daily run at `HH:MM` UTC. */
export function sweepScheduleExpression(timeUtc: string): string {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeUtc);
  if (match === null) throw new Error(`Invalid sweep time ${timeUtc}, expected HH:MM`);
  return `cron(${Number(match[2])} ${Number(match[1])} * * ? *)`;
}

export interface DuplicateSweepProps {
  readonly listings: ITableV2;
  readonly auditLog: ITableV2;
  readonly configBucket: IBucket;
  readonly duplicateIndex: ITableV2;
  readonly duplicateReports: ITableV2;
  readonly metricCounters: ITableV2;
  /** SSM parameter with the SPA origin (derived source URLs are not compared, Req 3.1). */
  readonly frontendOriginParameter: string;
  /** SSM parameter with Ein/Aus of the Duplikat-Erkennung; switched off, a run ends at once. */
  readonly duplicateDetectionParameter: string;
  readonly settings: DuplicateSweepSettings;
  /** Full alarm name; starts with the platform's alarm prefix so `/monitoring` lists it. */
  readonly alarmName: string;
  /** Operational alarm topic of the platform, if any. */
  readonly alarmTopic?: ITopic;
  readonly removalPolicy: RemovalPolicy;
  readonly observability: ObservabilitySettings;
}

const indexArn = (table: ITableV2, name: string) => `${table.tableArn}/index/${name}`;

export class DuplicateSweepWorkflow extends Construct {
  readonly function: NodejsFunction;
  readonly stateMachine: StateMachine;
  readonly schedule: CfnSchedule;
  readonly alarm: Alarm;

  constructor(scope: Construct, id: string, props: DuplicateSweepProps) {
    super(scope, id);
    this.function = bundledFunction(this, 'Function', {
      description: 'Duplikat_Abgleich: tasks of the DuplicateSweep state machine',
      packageDir: INFRA_PACKAGE,
      entry: 'src/lambda/duplicate-sweep-entry.ts',
      memorySize: 1024,
      timeout: DUPLICATE_SWEEP_LAMBDA_TIMEOUT,
      removalPolicy: props.removalPolicy,
      observability: props.observability,
      // Invoked synchronously by Step Functions, which retries.
      retryAttempts: 0,
    });
    const environment: Record<keyof typeof DUPLICATE_SWEEP_ENV, string> = {
      listingsTable: props.listings.tableName,
      duplicateIndexTable: props.duplicateIndex.tableName,
      duplicateReportsTable: props.duplicateReports.tableName,
      metricCountersTable: props.metricCounters.tableName,
      auditLogTable: props.auditLog.tableName,
      configBucket: props.configBucket.bucketName,
      duplicateDetectionParameter: props.duplicateDetectionParameter,
    };
    for (const [key, name] of Object.entries(DUPLICATE_SWEEP_ENV)) {
      this.function.addEnvironment(name, environment[key as keyof typeof DUPLICATE_SWEEP_ENV]);
    }
    this.function.addEnvironment(
      FRONTEND_ORIGIN_VALUE + SSM_PARAMETER_SUFFIX,
      props.frontendOriginParameter,
    );
    this.function.addEnvironment('POWERTOOLS_METRICS_NAMESPACE', DEFAULT_METRICS_NAMESPACE);
    grantSweep(this.function, props);

    this.stateMachine = this.workflow(props.removalPolicy);

    const schedulerRole = new Role(this, 'SchedulerRole', {
      description: 'EventBridge Scheduler: start the daily duplicate check',
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
    });
    this.stateMachine.grantStartExecution(schedulerRole);
    this.schedule = new CfnSchedule(this, 'Schedule', {
      description: 'Daily duplicate check of all listings (Req 10.1)',
      scheduleExpression: sweepScheduleExpression(props.settings.timeUtc),
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: { mode: 'OFF' },
      state: 'ENABLED',
      target: {
        arn: this.stateMachine.stateMachineArn,
        roleArn: schedulerRole.roleArn,
        input: '{}',
      },
    });
    this.schedule.node.addDependency(schedulerRole);

    this.alarm = new Alarm(this, 'RunFailed', {
      alarmName: props.alarmName,
      alarmDescription:
        'Duplikat_Abgleich failed or did not end within 4 hours (duplicate-detection Req 10.8)',
      metric: new MathExpression({
        expression: 'failed + timedOut',
        usingMetrics: {
          failed: this.stateMachine.metricFailed({ statistic: 'Sum' }),
          timedOut: this.stateMachine.metricTimedOut({ statistic: 'Sum' }),
        },
        period: Duration.minutes(5),
        label: 'Failed or timed-out duplicate checks',
      }),
      threshold: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    if (props.alarmTopic !== undefined) {
      const action = new SnsAction(props.alarmTopic);
      this.alarm.addAlarmAction(action);
      this.alarm.addOkAction(action);
    }
  }

  private workflow(removalPolicy: RemovalPolicy): StateMachine {
    // Without `payload` the task passes its (selected) input unchanged: with
    // `payloadResponseOnly` a JSONPath payload would not be valid ASL.
    const invoke = (
      id: string,
      options: { payload?: TaskInput; resultPath?: string; inputPath?: string } = {},
    ) =>
      withRetries(
        new LambdaInvoke(this, id, {
          lambdaFunction: this.function,
          ...(options.payload !== undefined && { payload: options.payload }),
          payloadResponseOnly: true,
          retryOnServiceExceptions: false,
          ...(options.resultPath !== undefined && { resultPath: options.resultPath }),
          ...(options.inputPath !== undefined && { inputPath: options.inputPath }),
        }),
      );
    const execution = {
      sweepId: JsonPath.executionName,
      startedAt: JsonPath.stringAt('$$.Execution.StartTime'),
    };

    // Configuration of the run (Req 10.6) and the segments of the Maps: `$.run`.
    const prepare = invoke('Prepare', {
      payload: TaskInput.fromObject({ action: 'prepare', ...execution }),
      resultPath: '$.run',
    });

    // One Map per segmented phase; each part loops with its cursor until `done`.
    const phase = (name: 'INDEX' | 'ORPHAN' | 'MATCH', key: string) => {
      const map = new MapState(this, `${name}Phase`, {
        itemsPath: '$.run.segments',
        itemSelector: {
          action: 'step',
          run: JsonPath.objectAt('$.run'),
          phase: name,
          segment: JsonPath.numberAt('$$.Map.Item.Value'),
        },
        resultSelector: { counts: JsonPath.listAt('$[*].counts') },
        resultPath: `$.results.${key}`,
      });
      // The state of the part is the whole input; the answer replaces it.
      const step = invoke(`${name}Step`);
      map.itemProcessor(
        step.next(
          new Choice(this, `${name}PartDone`)
            .when(Condition.booleanEquals('$.done', true), new Succeed(this, `${name}PartFinished`))
            .otherwise(step),
        ),
      );
      return map;
    };

    // RESOLVE after a complete MATCH phase only (Req 11.6): a single part.
    const resolveStart = new Pass(this, 'ResolveStart', {
      parameters: { action: 'step', run: JsonPath.objectAt('$.run'), phase: 'RESOLVE', segment: 0 },
      resultPath: '$.resolve',
    });
    const resolveStep = invoke('RESOLVEStep', { inputPath: '$.resolve', resultPath: '$.resolve' });
    const finish = invoke('Finish', {
      payload: TaskInput.fromObject({
        action: 'finish',
        run: JsonPath.objectAt('$.run'),
        results: {
          index: JsonPath.objectAt('$.results.index'),
          orphan: JsonPath.objectAt('$.results.orphan'),
          match: JsonPath.objectAt('$.results.match'),
          resolve: { counts: JsonPath.objectAt('$.resolve.counts') },
        },
      }),
      resultPath: JsonPath.DISCARD,
    });

    const phases = phase('INDEX', 'index');
    phases
      .next(phase('ORPHAN', 'orphan'))
      .next(phase('MATCH', 'match'))
      .next(resolveStart)
      .next(resolveStep)
      .next(
        new Choice(this, 'ResolveDone')
          .when(Condition.booleanEquals('$.resolve.done', true), finish)
          .otherwise(resolveStep),
      );
    // Switched off (design: "Ein- und Ausschalten"): Prepare logged the run as SKIPPED.
    const run = new Parallel(this, 'Run', { resultPath: JsonPath.DISCARD }).branch(
      prepare.next(
        new Choice(this, 'DetectionEnabled')
          .when(
            Condition.booleanEquals('$.run.enabled', false),
            new Succeed(this, 'DetectionDisabled', {
              comment: 'Duplicate detection is switched off; nothing was checked',
            }),
          )
          .otherwise(phases),
      ),
    );
    // After all retries: log the failed run (Req 10.8), then fail the execution (→ alarm).
    run.addCatch(
      invoke('ReportFailure', {
        payload: TaskInput.fromObject({ action: 'fail', ...execution }),
        resultPath: JsonPath.DISCARD,
      }).next(
        new Fail(this, 'RunFailedState', {
          error: 'DuplicateSweepFailed',
          cause: 'A task of the duplicate check failed after its retries; see the function log',
        }),
      ),
      { resultPath: '$.error' },
    );

    return new StateMachine(this, 'StateMachine', {
      comment: 'Daily duplicate check of all listings (duplicate-detection Req 10)',
      definitionBody: DefinitionBody.fromChainable(run),
      stateMachineType: StateMachineType.STANDARD,
      timeout: DUPLICATE_SWEEP_TIMEOUT,
      logs: {
        destination: new LogGroup(this, 'StateMachineLogs', {
          retention: RetentionDays.ONE_MONTH,
          removalPolicy,
        }),
        level: LogLevel.ERROR,
        // Errors only, without payloads.
        includeExecutionData: false,
      },
    });
  }
}

/** Every error is retried with exponential backoff; the steps are idempotent. */
function withRetries<T extends LambdaInvoke>(task: T): T {
  task.addRetry({
    errors: ['States.ALL'],
    interval: Duration.seconds(10),
    backoffRate: 2,
    maxAttempts: DUPLICATE_SWEEP_RETRIES,
    jitterStrategy: JitterType.FULL,
  });
  return task;
}

function allow(fn: NodejsFunction, actions: string[], resources: string[]): void {
  fn.addToRolePolicy(new PolicyStatement({ actions, resources }));
}

/**
 * Least privilege of the sweep Lambda: scan and read `Listings`, change only the Markierungen
 * (`UpdateItem` with a condition) and check versions; read and write the Duplikat_Index and the
 * Treffer; the counters; `AuditLog` only `PutItem` (append-only); the two config files and the
 * frontend origin.
 */
function grantSweep(fn: NodejsFunction, props: DuplicateSweepProps): void {
  const stack = Stack.of(fn);
  allow(
    fn,
    [
      'dynamodb:Scan',
      'dynamodb:GetItem',
      'dynamodb:BatchGetItem',
      'dynamodb:UpdateItem',
      'dynamodb:ConditionCheckItem',
    ],
    [props.listings.tableArn],
  );
  allow(
    fn,
    [
      'dynamodb:Scan',
      'dynamodb:Query',
      'dynamodb:GetItem',
      'dynamodb:BatchGetItem',
      'dynamodb:PutItem',
      'dynamodb:DeleteItem',
      'dynamodb:BatchWriteItem',
    ],
    [props.duplicateIndex.tableArn],
  );
  allow(fn, ['dynamodb:Query'], [indexArn(props.duplicateIndex, DUPLICATE_INDEX_BY_BLOCK)]);
  allow(
    fn,
    ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
    [props.duplicateReports.tableArn],
  );
  allow(fn, ['dynamodb:Query'], [indexArn(props.duplicateReports, DUPLICATE_REPORTS_BY_STATE)]);
  allow(fn, ['dynamodb:UpdateItem'], [props.metricCounters.tableArn]);
  allow(fn, ['dynamodb:PutItem'], [props.auditLog.tableArn]);
  allow(
    fn,
    ['s3:GetObject'],
    [READ_MODEL_CONFIG_FILES.taxonomy, DUPLICATE_CONFIG_FILE].map((key) =>
      props.configBucket.arnForObjects(key),
    ),
  );
  // So a missing optional file is NoSuchKey, not AccessDenied.
  allow(fn, ['s3:ListBucket'], [props.configBucket.bucketArn]);
  allow(
    fn,
    ['ssm:GetParameter', 'ssm:GetParameters'],
    [
      ssmParameterArn(stack, props.frontendOriginParameter),
      ssmParameterArn(stack, props.duplicateDetectionParameter),
    ],
  );
}
