import type { ConnectorType } from './connector';

/**
 * Structured, value-free run log (Req 11.5, 18.2).
 *
 * Every method builds its log line from an explicit set of keys: listing ids,
 * field names, reasons, counters, timestamps. There is intentionally no method
 * that accepts a record, a listing or arbitrary context, so field values cannot
 * reach the log through this API. Callers must pass reasons that do not quote
 * values (e.g. Zod issue messages, fixed texts).
 */
export type LogLevel = 'info' | 'warn' | 'error';
export type RunStatus = 'SUCCESS' | 'FAILURE';
export type DroppedMediaKind = 'media' | 'tour';

export interface FieldIssue {
  /** Dot-separated field path, e.g. `offers.0.price`. */
  readonly field: string;
  readonly reason: string;
}

/** One compliance check of a crawl target (Req 6.6, 6.7, 11.7). */
export interface CrawlCheck {
  /** Target URL; crawl targets carry no credentials and are not personal data. */
  readonly url: string;
  readonly allowed: boolean;
  readonly reason: string;
  /** ISO-8601 timestamp with offset, as decided by the ComplianceChecker. */
  readonly checkedAt: string;
}

export interface RunSummary {
  readonly status: RunStatus;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly imported: number;
  readonly updated: number;
  readonly rejected: number;
}

export interface RunLogger {
  readonly runId: string;
  /** Source identifier (= connector id) written into every line. */
  readonly source: string;
  runStarted(connectorType: ConnectorType): void;
  runFinished(summary: RunSummary): void;
  /** Run not executed on purpose (e.g. connector disabled); not an error. */
  runSkipped(reason: string): void;
  /** Connector configuration refused before `initialize` (Req 5.4). */
  configRejected(issues: readonly FieldIssue[]): void;
  /** Listing refused by the pipeline; lists every affected field. */
  recordRejected(listingId: string | undefined, issues: readonly FieldIssue[]): void;
  /** PII field removed by the allow-list filter; the value is never passed in. */
  piiFieldDropped(listingId: string, field: string): void;
  /**
   * Medium or tour removed by the pipeline. `url` is only passed for tours rejected because of
   * their host (Req 16.4); tour URLs are not personal data. Media URLs are not logged.
   */
  mediaDropped(
    listingId: string,
    kind: DroppedMediaKind,
    index: number,
    reason: string,
    url?: string,
  ): void;
  /** Valid media/tours beyond the limit of 50/10 were removed; logs their number (Req 16.11). */
  mediaTruncated(listingId: string, kind: DroppedMediaKind, droppedCount: number): void;
  /** Crawl log entry: one per checked target URL, allowed or not (Req 6.6, 6.7, 11.7). */
  crawlChecked(check: CrawlCheck): void;
  /** Allowed target could not be fetched or extracted (timeout, network error, non-2xx); run continues. */
  crawlPageFailed(url: string, reason: string): void;
  connectorError(reason: string): void;
}

/** Receives one serialized JSON line (no trailing newline). */
export type LogSink = (line: string) => void;

export interface RunLoggerOptions {
  readonly runId: string;
  readonly source: string;
  readonly sink?: LogSink;
  readonly now?: () => Date;
}

/** Caps free text so a misbehaving caller cannot dump large payloads into the log. */
const MAX_TEXT_LENGTH = 200;
const clip = (text: string, max = MAX_TEXT_LENGTH): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;
/** Stored URLs are at most 2,048 characters; longer ones are cut like other free text. */
const MAX_URL_LENGTH = 2048;
const issuesOf = (issues: readonly FieldIssue[]) =>
  issues.map(({ field, reason }) => ({ field: clip(field), reason: clip(reason) }));

const stdoutSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

export function createRunLogger({
  runId,
  source,
  sink = stdoutSink,
  now = () => new Date(),
}: RunLoggerOptions): RunLogger {
  const write = (level: LogLevel, event: string, fields: Record<string, unknown>): void => {
    sink(
      JSON.stringify({ timestamp: now().toISOString(), level, event, runId, source, ...fields }),
    );
  };

  return {
    runId,
    source,
    runStarted: (connectorType) => write('info', 'run.started', { connectorType }),
    runFinished: ({ status, startedAt, endedAt, imported, updated, rejected }) =>
      write(status === 'SUCCESS' ? 'info' : 'error', 'run.finished', {
        status,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        imported,
        updated,
        rejected,
      }),
    runSkipped: (reason) => write('info', 'run.skipped', { reason: clip(reason) }),
    configRejected: (issues) => write('error', 'config.rejected', { issues: issuesOf(issues) }),
    recordRejected: (listingId, issues) =>
      write('warn', 'record.rejected', {
        ...(listingId === undefined ? {} : { listingId: clip(listingId) }),
        issues: issuesOf(issues),
      }),
    piiFieldDropped: (listingId, field) =>
      write('info', 'pii.field_dropped', { listingId: clip(listingId), field: clip(field) }),
    mediaDropped: (listingId, kind, index, reason, url) =>
      write('warn', 'media.dropped', {
        listingId: clip(listingId),
        kind,
        index,
        reason: clip(reason),
        ...(kind === 'tour' && url !== undefined ? { url: clip(url, MAX_URL_LENGTH) } : {}),
      }),
    mediaTruncated: (listingId, kind, droppedCount) =>
      write('warn', 'media.truncated', { listingId: clip(listingId), kind, droppedCount }),
    crawlChecked: ({ url, allowed, reason, checkedAt }) =>
      write(allowed ? 'info' : 'warn', 'crawl.checked', {
        url: clip(url, MAX_URL_LENGTH),
        result: allowed ? 'ALLOWED' : 'DENIED',
        reason: clip(reason),
        checkedAt,
      }),
    crawlPageFailed: (url, reason) =>
      write('warn', 'crawl.page_failed', {
        url: clip(url, MAX_URL_LENGTH),
        reason: clip(reason),
      }),
    connectorError: (reason) => write('error', 'connector.error', { reason: clip(reason) }),
  };
}
