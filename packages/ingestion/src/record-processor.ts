import type { ImportMode } from '@open-estate/shared';
import type { RawRecord } from './connector';
import type { RunLogger } from './run-logger';

/**
 * What happened to one raw record; feeds the run counters (Req 5.8, 13.2): `imported` = listing
 * created, `updated` = version created, `unchanged` = same Inhalts_Hash, no version (Req 7.3).
 */
export type RecordOutcome = 'imported' | 'updated' | 'unchanged' | 'rejected';

export interface RecordProcessingContext {
  readonly runId: string;
  /** Source identifier (= connector id). */
  readonly source: string;
  /** Run logger of the current run; rejections are logged by the processor itself. */
  readonly logger: RunLogger;
  /** Agency of the connector (Req 12.1); absent = listings managed by Plattform_Admins only. */
  readonly agencyId?: string;
  /** `resolveImportMode(config, module)` (Req 12.16); absent ⇒ `MERGE`. */
  readonly importMode?: ImportMode;
}

/**
 * Receives every record a connector emits. Implemented by the import pipeline
 * (task 10.4); the framework only counts outcomes. A thrown error counts as a
 * rejection of that one record and does not abort the run.
 */
export interface RecordProcessor {
  process(raw: RawRecord, ctx: RecordProcessingContext): Promise<RecordOutcome>;
}
