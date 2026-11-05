import { gunzipSync } from 'node:zlib';
import type { CloudWatchLogsDecodedData, CloudWatchLogsEvent } from 'aws-lambda';
import { USAGE_COUNTER_CODES } from '../management/metric-resolvers';
import {
  agencyScope,
  listingScope,
  type MetricCounterIncrement,
  type MetricCounterStore,
} from '../management/metric-counter-store';
import { UsageLine, type UsageKind } from './usage-line';

// UsageAggregator (design: "UsageAggregator", Req 13.4, 13.5, 13.7): receives the usage lines of
// the API and MCP log groups via a CloudWatch Logs subscription filter, counts per
// `(listingId, UTC day)` and `(agencyId, UTC day)` and writes one `ADD` per counter and batch into
// `MetricCounters` (daily values, TTL 100 days). Delay: seconds (≤ 15 min required, Req 13.7).

/** Environment of the UsageAggregator Lambda (wiring: task 12.2). */
export const USAGE_AGGREGATOR_ENV = {
  /** `MetricCounters` table (same name as for the connector Lambdas). */
  metricCountersTable: 'METRIC_COUNTERS_TABLE_NAME',
} as const;

/** Lambda entry relative to the `core` package directory (`handler` export). */
export const USAGE_AGGREGATOR_ENTRY = 'src/usage/handler.ts';

/** Counter code per usage kind; read by `listing.detail_views` / `listing.search_impressions`. */
export const USAGE_COUNTER_CODE: Readonly<Record<UsageKind, string>> = {
  detail: USAGE_COUNTER_CODES.detailViews,
  impression: USAGE_COUNTER_CODES.searchImpressions,
};

/** Parallel `ADD`s per batch. */
const WRITE_CONCURRENCY = 8;

export interface UsageLogEvent {
  /** Epoch ms of the log event; decides the UTC day. */
  timestamp: number;
  message: string;
}

/** Decodes the subscription payload (base64, gzip); control messages yield no events. */
export function decodeLogsEvent(event: CloudWatchLogsEvent): UsageLogEvent[] {
  const data = JSON.parse(
    gunzipSync(Buffer.from(event.awslogs.data, 'base64')).toString('utf8'),
  ) as CloudWatchLogsDecodedData;
  if (data.messageType !== 'DATA_MESSAGE') return [];
  return data.logEvents.map(({ timestamp, message }) => ({ timestamp, message }));
}

/** The usage line of a log message, or `null` for any other or malformed message. */
export function parseUsageLine(message: string): UsageLine | null {
  // The line is written raw; a runtime prefix (text log format) is skipped up to the JSON.
  const start = message.indexOf('{');
  if (start === -1) return null;
  let json: unknown;
  try {
    json = JSON.parse(message.slice(start));
  } catch {
    return null;
  }
  const parsed = UsageLine.safeParse(json);
  return parsed.success ? parsed.data : null;
}

const utcDay = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);

export interface UsageAggregation {
  /** One increment per `(scope, code, day)`, sorted by scope, code and day. */
  increments: MetricCounterIncrement[];
  /** Usage lines counted. */
  lines: number;
  /** Messages that were not a valid usage line. */
  skipped: number;
}

/**
 * Sums a batch: every item adds 1 to its listing and 1 to its agency (`agency#_none` without
 * agency) for the code of the line's kind and the UTC day of the log event.
 */
export function aggregateUsage(events: readonly UsageLogEvent[]): UsageAggregation {
  const sums = new Map<string, MetricCounterIncrement>();
  const add = (scope: string, code: string, day: string) => {
    const key = JSON.stringify([scope, code, day]);
    const current = sums.get(key);
    if (current === undefined) sums.set(key, { scope, code, day, delta: 1 });
    else current.delta += 1;
  };
  let lines = 0;
  let skipped = 0;
  for (const { timestamp, message } of events) {
    const line = Number.isFinite(timestamp) ? parseUsageLine(message) : null;
    if (line === null) {
      skipped += 1;
      continue;
    }
    lines += 1;
    const day = utcDay(timestamp);
    const code = USAGE_COUNTER_CODE[line.usage.kind];
    for (const { id, agencyId } of line.usage.items) {
      add(listingScope(id), code, day);
      add(agencyScope(agencyId), code, day);
    }
  }
  const increments = [...sums.values()].sort(
    (a, b) =>
      compare(a.scope, b.scope) || compare(a.code, b.code) || compare(a.day ?? '', b.day ?? ''),
  );
  return { increments, lines, skipped };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface UsageAggregatorDeps {
  counters: Pick<MetricCounterStore<unknown>, 'add'>;
  log?: (entry: Record<string, unknown>) => void;
}

export interface UsageBatchResult {
  lines: number;
  skipped: number;
  /** `ADD` calls made (one per counter). */
  writes: number;
}

/**
 * Handles one subscription batch. A failed `ADD` rejects the invocation, so Lambda retries the
 * batch (at-least-once: counters already written in the failed attempt may be counted twice).
 */
export async function handleUsageBatch(
  events: readonly UsageLogEvent[],
  { counters, log }: UsageAggregatorDeps,
): Promise<UsageBatchResult> {
  const { increments, lines, skipped } = aggregateUsage(events);
  let next = 0;
  const worker = async () => {
    while (next < increments.length) {
      const increment = increments[next++] as MetricCounterIncrement;
      await counters.add(increment);
    }
  };
  await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, increments.length) }, worker));
  const result = { lines, skipped, writes: increments.length };
  log?.({ message: 'UsageAggregator: batch counted', ...result });
  return result;
}

/** Lambda handler over a `MetricCounterStore`; decodes the subscription payload first. */
export function createUsageAggregatorHandler(
  deps: UsageAggregatorDeps,
): (event: CloudWatchLogsEvent) => Promise<UsageBatchResult> {
  return (event) => handleUsageBatch(decodeLogsEvent(event), deps);
}
