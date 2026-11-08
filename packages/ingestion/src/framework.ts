import type { ConnectorRunWriter } from '@open-estate/core';
import { CustomId, resolveImportMode } from '@open-estate/shared';
import type { z } from 'zod';
import type { ConnectorContext, RawRecord } from './connector';
import type { ConnectorConfig } from './connector-config';
import { withRunPersistence, type PersistentRunLogger } from './persistent-run-logger';
import type { RecordOutcome, RecordProcessingContext, RecordProcessor } from './record-processor';
import type { ConnectorRegistry } from './registry';
import {
  createRunLogger,
  type FieldIssue,
  type LogSink,
  type RunLogger,
  type RunStatus,
  type RunSummary,
} from './run-logger';

/**
 * - `COMPLETED`: `initialize` and `run` were invoked (status tells whether they succeeded).
 * - `CONFIG_REJECTED`: refused before `initialize` (Req 5.4); status is `FAILURE`.
 * - `DISABLED`: `enabled = false`; nothing executed, status is `SUCCESS`.
 */
export type RunOutcome = 'COMPLETED' | 'CONFIG_REJECTED' | 'DISABLED';

export interface ConnectorRunSummary extends RunSummary {
  readonly runId: string;
  /** Source identifier (= connector id). */
  readonly source: string;
  readonly outcome: RunOutcome;
}

export interface ConnectorFrameworkOptions {
  readonly registry: ConnectorRegistry;
  /** Import pipeline (task 10.4). */
  readonly processor: RecordProcessor;
  /** Log destination; defaults to stdout. */
  readonly sink?: LogSink;
  /** Persists run summaries and rejections (`ConnectorRuns`/`RunRejections`, Req 13.2, 13.3). */
  readonly runs?: ConnectorRunWriter;
  readonly now?: () => Date;
}

export interface RunOptions {
  readonly runId: string;
}

/**
 * Executes one connector run: resolve module, validate settings, initialize, run,
 * count record outcomes, write the run log (Req 5.3, 5.4, 5.8, 11.5).
 *
 * The run time limit (Req 5.7) is enforced outside, by the Step Functions
 * execution per connector (`TimeoutSeconds`), so no deadline is handled here.
 */
export class ConnectorFramework {
  private readonly registry: ConnectorRegistry;
  private readonly processor: RecordProcessor;
  private readonly sink: LogSink | undefined;
  private readonly runs: ConnectorRunWriter | undefined;
  private readonly now: () => Date;

  constructor({
    registry,
    processor,
    sink,
    runs,
    now = () => new Date(),
  }: ConnectorFrameworkOptions) {
    this.registry = registry;
    this.processor = processor;
    this.sink = sink;
    this.runs = runs;
    this.now = now;
  }

  async runConnector(config: ConnectorConfig, { runId }: RunOptions): Promise<ConnectorRunSummary> {
    const source = config.id;
    const baseLogger = createRunLogger({
      runId,
      source,
      now: this.now,
      ...(this.sink ? { sink: this.sink } : {}),
    });
    // Persisting decorator: summary and rejections to `ConnectorRuns`/`RunRejections`.
    const persistent: PersistentRunLogger | undefined =
      this.runs === undefined
        ? undefined
        : withRunPersistence(baseLogger, {
            writer: this.runs,
            ...(config.agencyId !== undefined && { agencyId: config.agencyId }),
          });
    const logger: RunLogger = persistent ?? baseLogger;
    const startedAt = this.now();
    const counters = { imported: 0, updated: 0, unchanged: 0, rejected: 0, flagged: 0 };
    const finish = async (outcome: RunOutcome, status: RunStatus): Promise<ConnectorRunSummary> => {
      const summary = { status, startedAt, endedAt: this.now(), ...counters };
      if (outcome !== 'DISABLED') logger.runFinished(summary);
      await persistent?.flush();
      return { ...summary, runId, source, outcome };
    };

    if (!config.enabled) {
      logger.runSkipped('connector is disabled');
      return finish('DISABLED', 'SUCCESS');
    }

    const resolved = this.registry.resolve(config);
    if (!resolved.ok) {
      const field = resolved.error.code === 'TYPE_MISMATCH' ? 'type' : 'module';
      logger.configRejected([{ field, reason: resolved.error.reason }]);
      return finish('CONFIG_REJECTED', 'FAILURE');
    }
    const module = resolved.value;

    const settings = module.settingsSchema.safeParse(config.settings);
    if (!settings.success) {
      logger.configRejected(settingsIssues(settings.error));
      return finish('CONFIG_REJECTED', 'FAILURE');
    }

    const processingContext: RecordProcessingContext = {
      runId,
      source,
      logger,
      importMode: resolveImportMode(config, module),
      ...(config.agencyId !== undefined && { agencyId: config.agencyId }),
    };
    const ctx: ConnectorContext = {
      config: settings.data,
      ...(config.secretRef !== undefined ? { secretRef: config.secretRef } : {}),
      runId,
      logger,
      emit: async (raw) => {
        const outcome = await this.processSafely(raw, processingContext);
        // A listing created as a duplicate is imported like any other (Req 5.5).
        if (outcome === 'flagged') counters.imported += 1;
        counters[outcome] += 1;
      },
    };

    logger.runStarted(module.type);
    let phase = 'create';
    try {
      const connector = module.create();
      phase = 'initialize';
      await connector.initialize(ctx);
      phase = 'run';
      await connector.run(ctx);
    } catch (error) {
      logger.connectorError(`${phase} failed: ${describe(error)}`);
      return finish('COMPLETED', 'FAILURE');
    }
    return finish('COMPLETED', 'SUCCESS');
  }

  private async processSafely(
    raw: RawRecord,
    ctx: RecordProcessingContext,
  ): Promise<RecordOutcome> {
    try {
      return await this.processor.process(raw, ctx);
    } catch (error) {
      const id = raw['id'];
      const customId = CustomId.safeParse(raw['customId']);
      const issues = [{ field: 'record', reason: `processing failed: ${describe(error)}` }];
      const listingId = typeof id === 'string' ? id : undefined;
      if (customId.success) ctx.logger.recordRejected(listingId, issues, customId.data);
      else ctx.logger.recordRejected(listingId, issues);
      return 'rejected';
    }
  }
}

/** Field paths and Zod messages only; Zod messages name types and bounds, never input values. */
function settingsIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    field: ['settings', ...issue.path.map(String)].join('.'),
    reason: issue.message,
  }));
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'non-error thrown';
}
