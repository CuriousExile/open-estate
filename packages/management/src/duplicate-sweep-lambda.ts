import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  CONFIG_BUCKET_ENV,
  createMetrics,
  describeInitFailure,
  DUPLICATE_DETECTION_PARAMETER_ENV,
  DuplicateDetector,
  DuplicateSweep,
  DynamoDbAuditService,
  DynamoDbDuplicateIndexStore,
  DynamoDbDuplicateReportStore,
  DynamoDbManagedListingStore,
  DynamoDbMetricCounterStore,
  DynamoDbTransactor,
  emptySweepCounts,
  loadConfig,
  loadDuplicateConfig,
  READ_MODEL_CONFIG_FILES,
  READ_MODEL_ENV,
  setListingFlags,
  SsmDuplicateDetectionSetting,
  sumSweepCounts,
  SWEEP_COUNT_KEYS,
  SWEEP_PHASES,
  systemClock,
  type Clock,
  type ConfigSources,
  type SweepCounts,
  type SweepRun,
  type SweepSummary,
} from '@open-estate/core';
import { assertValidTaxonomy, IsoDateTime, TaxonomyConfig } from '@open-estate/shared';
import { z } from 'zod';
import { loadFrontendOrigin, readEnv } from './env';

// Lambda of the Duplikat_Abgleich (duplicate-detection design: "Duplikat_Abgleich", Req 10): the
// tasks of the `DuplicateSweep` state machine. `prepare` reads the configuration at the start of
// the run (Req 10.6; an invalid file fails the run) and returns the segments of the Map states;
// `step` processes one part of a phase until done or its time budget is used; `finish` and `fail`
// write the run's log line (Req 10.7, 10.8) and its metrics.

/** Environment of the sweep Lambda (wiring: the ManagementStack). */
export const DUPLICATE_SWEEP_ENV = {
  listingsTable: READ_MODEL_ENV.listingsTable,
  duplicateIndexTable: 'DUPLICATE_INDEX_TABLE_NAME',
  duplicateReportsTable: 'DUPLICATE_REPORTS_TABLE_NAME',
  metricCountersTable: 'METRIC_COUNTERS_TABLE_NAME',
  auditLogTable: 'AUDIT_LOG_TABLE_NAME',
  /** Private config bucket: taxonomy and `duplicate-detection.json`. */
  configBucket: CONFIG_BUCKET_ENV,
  /** SSM parameter `/open-estate/<env>/duplicate-detection`, read at the start of each run. */
  duplicateDetectionParameter: DUPLICATE_DETECTION_PARAMETER_ENV,
} as const;

/** Work per invocation ends when less than this remains (Lambda timeout 15 min → ≤ 10 min). */
export const SWEEP_TIME_RESERVE_MS = 5 * 60 * 1000;

/** EMF metric names of a finished run (namespace `POWERTOOLS_METRICS_NAMESPACE`). */
export const SWEEP_METRICS: Readonly<Partial<Record<keyof SweepCounts, string>>> = {
  checked: 'DuplicateSweepChecked',
  flagsSet: 'DuplicateSweepFlagsSet',
  flagsUpdated: 'DuplicateSweepFlagsUpdated',
  flagsRemoved: 'DuplicateSweepFlagsRemoved',
  reportsNew: 'DuplicateSweepReportsNew',
  reportsResolved: 'DuplicateSweepReportsResolved',
  skipped: 'DuplicateSweepSkipped',
};

/** Counts as passed between the states; absent counts are 0. */
const Counts = z.object(
  Object.fromEntries(SWEEP_COUNT_KEYS.map((key) => [key, z.int().min(0).default(0)])) as Record<
    keyof SweepCounts,
    z.ZodDefault<z.ZodInt>
  >,
);

const Run = z.object({
  sweepId: z.string().min(1).max(80),
  startedAt: IsoDateTime,
  /** `[0, …, segments − 1]`, the items of the Map states. */
  segments: z.array(z.int().min(0)).min(1).max(64),
});
export type SweepRunState = z.infer<typeof Run>;

/** Result of a Map or of the RESOLVE loop: the counts of its parts. */
const Part = z.object({ counts: z.union([Counts, z.array(Counts)]) });

export const SweepEvent = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('prepare'),
    sweepId: z.string().min(1).max(80),
    startedAt: IsoDateTime,
  }),
  z.object({
    action: z.literal('step'),
    run: Run,
    phase: z.enum(SWEEP_PHASES),
    segment: z.int().min(0),
    cursor: z.string().min(1).optional(),
    /** Counts of the previous steps of this part. */
    counts: Counts.optional(),
  }),
  z.object({ action: z.literal('finish'), run: Run, results: z.record(z.string(), Part) }),
  z.object({
    action: z.literal('fail'),
    run: Run.optional(),
    sweepId: z.string().optional(),
    startedAt: z.string().optional(),
  }),
]);
export type SweepEvent = z.input<typeof SweepEvent>;

/** State of one part after a step; `done` ends its loop in the state machine. */
export interface SweepStepState {
  action: 'step';
  run: SweepRunState;
  phase: (typeof SWEEP_PHASES)[number];
  segment: number;
  cursor?: string;
  counts: SweepCounts;
  done: boolean;
}

export interface SweepContext {
  getRemainingTimeInMillis(): number;
}

export type SweepLogger = (summary: SweepSummary) => void;

/** Configuration and stores of one run. */
export interface SweepSetup {
  sweep: DuplicateSweep<unknown>;
  segments: number;
  /** The Duplikat-Erkennung is switched on (read at the start of the run). */
  enabled: boolean;
}

/** Result of `prepare`: the run, and whether it goes on (`false`: switched off, ends here). */
export type SweepPrepared = SweepRunState & { enabled: boolean };

export interface DuplicateSweepHandlerDeps {
  /** Configuration and stores of one run; called once per `sweepId` (Req 10.6). */
  sweepFor(sweepId: string): Promise<SweepSetup>;
  clock: Clock;
  log: SweepLogger;
  /** Emits the run's metrics; default none. */
  metrics?: (summary: SweepSummary) => void;
}

const runOf = (run: SweepRunState): SweepRun => ({
  sweepId: run.sweepId,
  startedAt: run.startedAt,
});

/** Counts of every part of every phase, summed (Finish). */
function collectCounts(results: Record<string, z.infer<typeof Part>>): SweepCounts {
  const parts: Partial<SweepCounts>[] = [];
  for (const part of Object.values(results)) {
    parts.push(...(Array.isArray(part.counts) ? part.counts : [part.counts]));
  }
  return sumSweepCounts(parts);
}

/**
 * The task handler. Errors propagate (Step Functions retries the task, then fails the run and
 * raises the alarm, Req 10.8); every step is idempotent.
 */
export function createDuplicateSweepHandler(deps: DuplicateSweepHandlerDeps) {
  let current: { sweepId: string; run: Promise<SweepSetup> } | undefined;
  const sweepOf = (sweepId: string) => {
    if (current?.sweepId !== sweepId) {
      const run = deps.sweepFor(sweepId);
      current = { sweepId, run };
      // A failed load is not cached: the retry of the task loads again.
      run.catch(() => {
        if (current?.run === run) current = undefined;
      });
    }
    return current.run;
  };

  return async (
    raw: unknown,
    context: SweepContext,
  ): Promise<SweepPrepared | SweepStepState | SweepSummary> => {
    const event = SweepEvent.parse(raw);
    switch (event.action) {
      case 'prepare': {
        const { segments, enabled } = await sweepOf(event.sweepId);
        if (!enabled) {
          // Switched off (design: "Ein- und Ausschalten"): the state machine ends here.
          deps.log({
            event: 'duplicate.sweep',
            sweepId: event.sweepId,
            status: 'SKIPPED',
            startedAt: event.startedAt,
            endedAt: new Date(deps.clock()).toISOString(),
            ...emptySweepCounts(),
          });
        }
        return {
          sweepId: event.sweepId,
          startedAt: event.startedAt,
          segments: Array.from({ length: segments }, (_, i) => i),
          enabled,
        };
      }
      case 'step': {
        const { sweep } = await sweepOf(event.run.sweepId);
        const resolve = event.phase === 'RESOLVE';
        const result = await sweep.step(
          runOf(event.run),
          {
            phase: event.phase,
            segment: resolve ? 0 : event.segment,
            segments: resolve ? 1 : event.run.segments.length,
            ...(event.cursor !== undefined && { cursor: event.cursor }),
          },
          () => context.getRemainingTimeInMillis() < SWEEP_TIME_RESERVE_MS,
        );
        return {
          action: 'step',
          run: event.run,
          phase: event.phase,
          segment: event.segment,
          ...(result.cursor !== undefined && { cursor: result.cursor }),
          counts: sumSweepCounts([event.counts ?? {}, result.counts]),
          done: result.cursor === undefined,
        };
      }
      case 'finish': {
        const { sweep } = await sweepOf(event.run.sweepId);
        const summary = sweep.summary(runOf(event.run), collectCounts(event.results), 'SUCCEEDED');
        deps.log(summary);
        deps.metrics?.(summary);
        return summary;
      }
      case 'fail': {
        const sweepId = event.run?.sweepId ?? event.sweepId ?? 'unknown';
        const startedAt = event.run?.startedAt ?? event.startedAt ?? '';
        const summary: SweepSummary = {
          event: 'duplicate.sweep',
          sweepId,
          status: 'FAILED',
          startedAt,
          endedAt: new Date(deps.clock()).toISOString(),
          ...emptySweepCounts(),
        };
        deps.log(summary);
        deps.metrics?.(summary);
        return summary;
      }
    }
  };
}

export interface DuplicateSweepEnvOptions {
  dynamo?: DynamoDBDocumentClient;
  s3?: S3Client;
  ssm?: SSMClient;
  clock?: Clock;
  log?: SweepLogger;
}

/**
 * Production handler from {@link DUPLICATE_SWEEP_ENV}: the stores are built once, the
 * configuration (taxonomy, `duplicate-detection.json`) and the frontend origin per run.
 * Throws `ConfigError` naming every missing variable.
 */
export function createDuplicateSweepHandlerFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: DuplicateSweepEnvOptions = {},
) {
  const names = readEnv(env, DUPLICATE_SWEEP_ENV);
  const dynamo = options.dynamo ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const s3 = options.s3 ?? new S3Client({});
  const ssm = options.ssm ?? new SSMClient({});
  const clock = options.clock ?? systemClock;
  const table = (tableName: string) => ({ client: dynamo, tableName });
  const listings = new DynamoDbManagedListingStore(table(names.listingsTable));
  const index = new DynamoDbDuplicateIndexStore(table(names.duplicateIndexTable));
  const reports = new DynamoDbDuplicateReportStore(table(names.duplicateReportsTable));
  const counters = new DynamoDbMetricCounterStore(table(names.metricCountersTable));
  const transactor = new DynamoDbTransactor({ client: dynamo });
  const audit = new DynamoDbAuditService({
    client: dynamo,
    tableName: names.auditLogTable,
    now: clock,
  });
  const sources: ConfigSources = { env, s3, ssm };
  const detection = new SsmDuplicateDetectionSetting({
    client: ssm,
    parameterName: names.duplicateDetectionParameter,
    clock,
  });
  const metrics = createMetrics('duplicate-sweep', env);

  return createDuplicateSweepHandler({
    clock,
    log: options.log ?? ((summary) => console.log(JSON.stringify(summary))),
    metrics(summary) {
      for (const [key, name] of Object.entries(SWEEP_METRICS)) {
        metrics.addMetric(name, 'Count', summary[key as keyof SweepCounts]);
      }
      metrics.addMetric(
        summary.status === 'SUCCEEDED' ? 'DuplicateSweepSucceeded' : 'DuplicateSweepFailed',
        'Count',
        1,
      );
      metrics.publishStoredMetrics();
    },
    async sweepFor() {
      const [config, duplicateConfig, frontendOrigin, enabled] = await Promise.all([
        loadConfig({ files: [READ_MODEL_CONFIG_FILES.taxonomy] }, sources),
        loadDuplicateConfig(sources),
        loadFrontendOrigin(env, { ssm }),
        detection.load(),
      ]);
      const taxonomy = assertValidTaxonomy(
        config.loadJson(READ_MODEL_CONFIG_FILES.taxonomy, TaxonomyConfig),
      );
      const sweep = new DuplicateSweep({
        listings,
        index,
        reports,
        counters,
        transactor,
        writer: {
          setFlags: (change) => setListingFlags({ listings, counters, transactor, index }, change),
        },
        detector: new DuplicateDetector({ index, taxonomy, config: duplicateConfig }),
        audit,
        clock,
        frontendOrigin,
      });
      return { sweep, segments: duplicateConfig.sweep.segments, enabled };
    },
  });
}

/**
 * Lambda entry helper: the stores are built at init; a failed init is logged once (names only)
 * and fails every invocation.
 */
export function createDuplicateSweepLambda(env: Readonly<Record<string, string | undefined>>) {
  let handler: ReturnType<typeof createDuplicateSweepHandlerFromEnv> | undefined;
  let failure: unknown;
  try {
    handler = createDuplicateSweepHandlerFromEnv(env);
  } catch (error) {
    failure = error;
    console.error(
      JSON.stringify({ message: 'Duplicate sweep: init failed', ...describeInitFailure(error) }),
    );
  }
  return (event: unknown, context: SweepContext) => {
    if (handler === undefined) throw failure;
    return handler(event, context);
  };
}
