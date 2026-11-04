import type { RunLogger } from './run-logger';

/** Supported data source types (Req 5.2). */
export const CONNECTOR_TYPES = ['relational-db', 'external-api', 'web-crawler'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

/** Lifecycle state a connector reports about its current run. */
export type ConnectorState = 'idle' | 'initialized' | 'running' | 'succeeded' | 'failed';

export interface ConnectorStatus {
  readonly state: ConnectorState;
  readonly imported: number;
  readonly updated: number;
  readonly rejected: number;
}

/**
 * One source record exactly as delivered by the data source, before mapping into
 * the listing schema (pipeline step 1). Never logged.
 */
export type RawRecord = Readonly<Record<string, unknown>>;

/**
 * Everything a connector gets from the framework for one run.
 * `config` is the connector's `settings`, already validated against the
 * connector's own schema before `initialize` (Req 5.4, task 10.2).
 */
export interface ConnectorContext<TSettings = unknown> {
  readonly config: TSettings;
  /** `connectors.json` → `secretRef`: name/ARN only; the connector resolves the value itself. */
  readonly secretRef?: string;
  readonly runId: string;
  readonly logger: RunLogger;
  /** Hands one raw record to the import pipeline; resolves once it is processed. */
  emit(raw: RawRecord): Promise<void>;
}

/**
 * The only contract the core knows (Req 5.1): initialise, run, report status.
 * Method syntax on purpose, so `Connector<S>` stays assignable to `Connector`.
 */
export interface Connector<TSettings = unknown> {
  readonly type: ConnectorType;
  initialize(ctx: ConnectorContext<TSettings>): Promise<void>;
  /** Calls `ctx.emit(raw)` once per raw record. */
  run(ctx: ConnectorContext<TSettings>): Promise<void>;
  reportStatus(): ConnectorStatus;
}
