import type { ConnectorRunWriter } from '@open-estate/core';
import type { RunRejectionView } from '@open-estate/shared';
import type { FieldIssue, RunLogger, RunSummary } from './run-logger';

/**
 * `RunLogger` decorator that persists the run for the monitoring (design: "Import-Pipeline", Req
 * 13.2, 13.3): the summary (with `unchanged` and the connector's `agencyId`) goes to
 * `ConnectorRuns`, every rejection to `RunRejections` with listing id or Custom_Id, field names
 * and reason, never values. Every call is forwarded to the wrapped logger unchanged.
 *
 * Rejections are buffered and written with the summary at `runFinished`; `flush` waits for that
 * write. A failed write does not fail the run: it is logged as `connector.error` (the import has
 * already happened, retrying the run would not undo it).
 */
export interface PersistentRunLogger extends RunLogger {
  /** Resolves once the summary of a finished run is stored (or its failure logged). */
  flush(): Promise<void>;
}

export interface PersistentRunLoggerOptions {
  readonly writer: ConnectorRunWriter;
  /** Owning agency of the connector (`connectors.json`); absent = no agency. */
  readonly agencyId?: string;
}

/** Caps of the persisted texts (field names and reasons come from schemas or fixed texts). */
const MAX_FIELD_LENGTH = 200;
const MAX_REASON_LENGTH = 1000;
const MAX_FIELDS = 100;
const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** One rejection: distinct field names and the distinct reasons joined with `; `. */
export function toRunRejection(
  listingId: string | undefined,
  issues: readonly FieldIssue[],
  customId?: string,
): RunRejectionView {
  const fields = [...new Set(issues.map(({ field }) => clip(field, MAX_FIELD_LENGTH)))];
  const reasons = [...new Set(issues.map(({ reason }) => reason))];
  return {
    ...(listingId !== undefined && { listingId: clip(listingId, MAX_FIELD_LENGTH) }),
    ...(customId !== undefined && { customId }),
    fields: fields.slice(0, MAX_FIELDS),
    reason: clip(reasons.join('; '), MAX_REASON_LENGTH),
  };
}

export function withRunPersistence(
  inner: RunLogger,
  { writer, agencyId }: PersistentRunLoggerOptions,
): PersistentRunLogger {
  const rejections: RunRejectionView[] = [];
  let pending: Promise<void> = Promise.resolve();

  const persist = (summary: RunSummary): Promise<void> =>
    writer
      .record(
        {
          runId: inner.runId,
          connectorId: inner.source,
          ...(agencyId !== undefined && { agencyId }),
          startedAt: summary.startedAt.toISOString(),
          endedAt: summary.endedAt.toISOString(),
          status: summary.status,
          imported: summary.imported,
          updated: summary.updated,
          unchanged: summary.unchanged,
          rejected: summary.rejected,
          flagged: summary.flagged,
        },
        [...rejections],
      )
      .catch((error: unknown) => {
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown';
        inner.connectorError(`run log persistence failed: ${reason}`);
      });

  return {
    runId: inner.runId,
    source: inner.source,
    runStarted: (connectorType) => inner.runStarted(connectorType),
    runSkipped: (reason) => inner.runSkipped(reason),
    configRejected: (issues) => inner.configRejected(issues),
    piiFieldDropped: (listingId, field) => inner.piiFieldDropped(listingId, field),
    attributeDropped: (listingId, field) => inner.attributeDropped(listingId, field),
    recordFlagged: (listingId, originalId, reasons) =>
      inner.recordFlagged(listingId, originalId, reasons),
    mediaDropped: (...args) => inner.mediaDropped(...args),
    mediaTruncated: (listingId, kind, count) => inner.mediaTruncated(listingId, kind, count),
    crawlChecked: (check) => inner.crawlChecked(check),
    crawlPageFailed: (url, reason) => inner.crawlPageFailed(url, reason),
    connectorError: (reason) => inner.connectorError(reason),
    recordRejected: (listingId, issues, customId) => {
      if (customId === undefined) inner.recordRejected(listingId, issues);
      else inner.recordRejected(listingId, issues, customId);
      rejections.push(toRunRejection(listingId, issues, customId));
    },
    runFinished: (summary) => {
      inner.runFinished(summary);
      pending = pending.then(() => persist(summary));
    },
    flush: () => pending,
  };
}
