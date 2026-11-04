import type { RawRecord } from './connector';
import type { RunLogger } from './run-logger';

/** What happened to one raw record; feeds the run counters (Req 5.8). */
export type RecordOutcome = 'imported' | 'updated' | 'rejected';

export interface RecordProcessingContext {
  readonly runId: string;
  /** Source identifier (= connector id). */
  readonly source: string;
  /** Run logger of the current run; rejections are logged by the processor itself. */
  readonly logger: RunLogger;
}

/**
 * Receives every record a connector emits. Implemented by the import pipeline
 * (task 10.4); the framework only counts outcomes. A thrown error counts as a
 * rejection of that one record and does not abort the run.
 */
export interface RecordProcessor {
  process(raw: RawRecord, ctx: RecordProcessingContext): Promise<RecordOutcome>;
}
