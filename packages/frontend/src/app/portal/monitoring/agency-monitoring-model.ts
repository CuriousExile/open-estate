// Framework-free logic of the agency monitoring view (design: `AgencyMonitoringComponent`,
// Req 13.6, 15.5): overview figures, connector runs with problems, usage period and totals, and the
// catalog metrics without an own view. Kept free of Angular imports so it can be unit-tested with
// plain Jest.
import {
  CHANNELS,
  LISTING_STATUSES,
  type Channel,
  type ListingStatus,
  type METRIC_INTERVALS,
  type METRIC_SCOPES,
} from '@open-estate/shared';
import {
  isAvailable,
  type MetricInterval,
  type MetricResultData,
  type TimeSeriesData,
} from '../shared/metric-chart/metric-chart-model';

export const METRIC = {
  listingCount: 'listing.count',
  listingChanges: 'listing.changes',
  detailViews: 'listing.detail_views',
  searchImpressions: 'listing.search_impressions',
} as const;

/** Catalog codes the agency view shows in its own sections; all others go to the generic chart. */
export const OWN_VIEW_CODES: readonly string[] = Object.values(METRIC);

/** Usage period bounds of `GET /monitoring/usage` (Req 13.5). */
export const USAGE_MIN_DAYS = 1;
export const USAGE_MAX_DAYS = 90;
/** Days preselected in the period form. */
export const USAGE_DEFAULT_DAYS = 30;

const DAY_MS = 86_400_000;

export type Availability<T> = { available: true; value: T } | { available: false };

export interface OverviewSummary {
  /** Current listings per Listing_Status (Req 13.1). */
  readonly listings: Availability<{ byStatus: Record<ListingStatus, number>; total: number }>;
  /** Changes per Änderungskanal in the last 30 days (Req 13.1). */
  readonly changes: Availability<{ byChannel: Record<Channel, number>; total: number }>;
}

const find = (metrics: readonly MetricResultData[], code: string) =>
  metrics.find((metric) => metric.code === code);

const zeroes = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;

/** Overview figures from `GET /monitoring/overview`; a missing or slow metric is unavailable. */
export function summarizeOverview(metrics: readonly MetricResultData[]): OverviewSummary {
  const count = find(metrics, METRIC.listingCount);
  const changes = find(metrics, METRIC.listingChanges);
  return {
    listings:
      count && isAvailable(count)
        ? { available: true, value: currentByStatus(count) }
        : { available: false },
    changes:
      changes && isAvailable(changes)
        ? { available: true, value: changesByChannel(changes) }
        : { available: false },
  };
}

/** Latest value per status (the series carries the current value at the period end). */
function currentByStatus(series: TimeSeriesData) {
  const byStatus = zeroes(LISTING_STATUSES);
  const latest = new Map<string, number>();
  for (const point of series.points) {
    const status = point.dims?.['status'];
    if (!status || !(LISTING_STATUSES as readonly string[]).includes(status)) continue;
    const t = Date.parse(point.t);
    if ((latest.get(status) ?? -Infinity) > t) continue;
    latest.set(status, t);
    byStatus[status as ListingStatus] = point.value;
  }
  return { byStatus, total: LISTING_STATUSES.reduce((sum, s) => sum + byStatus[s], 0) };
}

function changesByChannel(series: TimeSeriesData) {
  const byChannel = zeroes(CHANNELS);
  for (const point of series.points) {
    const channel = point.dims?.['channel'];
    if (!channel || !(CHANNELS as readonly string[]).includes(channel)) continue;
    byChannel[channel as Channel] += point.value;
  }
  return { byChannel, total: CHANNELS.reduce((sum, c) => sum + byChannel[c], 0) };
}

/** Connector_Lauf as delivered by `GET /monitoring/connector-runs` (Req 13.2). */
export interface ConnectorRunData {
  readonly runId: string;
  readonly connectorId: string;
  readonly startedAt: string;
  readonly endedAt?: string | undefined;
  readonly status: string;
  readonly imported: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly rejected: number;
}

/** Result statuses with their own label; others are shown as delivered. */
export const RUN_STATUSES = ['SUCCESS', 'FAILURE'] as const;

/** Run with Ergebnisstatus `Fehler` or with rejected Import_Datensätze (Req 13.6). */
export const isProblemRun = (run: Pick<ConnectorRunData, 'status' | 'rejected'>): boolean =>
  run.status === 'FAILURE' || run.rejected > 0;

export interface RunRow {
  readonly runId: string;
  readonly connectorId: string;
  readonly started: string;
  /** `undefined` while the run is still going. */
  readonly ended: string | undefined;
  /** Translation key of the status, or `undefined` for an unknown status (shown raw). */
  readonly statusKey: string | undefined;
  readonly status: string;
  readonly failed: boolean;
  readonly problem: boolean;
  readonly counts: { imported: number; updated: number; unchanged: number; rejected: number };
}

export function formatDateTime(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale || undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function toRunRow(run: ConnectorRunData, locale: string): RunRow {
  return {
    runId: run.runId,
    connectorId: run.connectorId,
    started: formatDateTime(run.startedAt, locale),
    ended: run.endedAt === undefined ? undefined : formatDateTime(run.endedAt, locale),
    statusKey: (RUN_STATUSES as readonly string[]).includes(run.status)
      ? `portal.monitoring.runs.status.${run.status}`
      : undefined,
    status: run.status,
    failed: run.status === 'FAILURE',
    problem: isProblemRun(run),
    counts: {
      imported: run.imported,
      updated: run.updated,
      unchanged: run.unchanged,
      rejected: run.rejected,
    },
  };
}

/** Rejected Import_Datensatz (Req 13.3): identity, field names and reason, never values. */
export interface RunRejectionData {
  readonly listingId?: string | undefined;
  readonly customId?: string | undefined;
  readonly fields: readonly string[];
  readonly reason: string;
}

export interface RejectionRow {
  /** Custom_Id if present, else the listing id; `undefined` if the record had neither. */
  readonly identifier: string | undefined;
  readonly fields: string;
  readonly reason: string;
}

export const toRejectionRow = (rejection: RunRejectionData): RejectionRow => ({
  identifier: rejection.customId ?? rejection.listingId,
  fields: rejection.fields.join(', '),
  reason: rejection.reason,
});

/** Period of the usage figures and generic metrics as UTC calendar days (`YYYY-MM-DD`). */
export interface DayPeriod {
  readonly from: string;
  readonly to: string;
}

export type PeriodError = 'invalid' | 'reversed' | 'tooLong';

export type PeriodResult =
  { ok: true; from: string; to: string; days: number } | { ok: false; error: PeriodError };

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const dayMs = (day: string): number => {
  if (!DAY_PATTERN.test(day)) return NaN;
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  // Rejects rolled-over dates such as 2026-02-31.
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day ? ms : NaN;
};

const toDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The last `days` UTC days up to and including today. */
export function defaultPeriod(now: Date, days = USAGE_DEFAULT_DAYS): DayPeriod {
  const today = dayMs(toDay(now.getTime()));
  return { from: toDay(today - (days - 1) * DAY_MS), to: toDay(today) };
}

/**
 * Query bounds of a day period (`from` 00:00 UTC to `to` 23:59:59.999 UTC), at most 90 days
 * (Req 13.5); the form keeps its values on an error.
 */
export function resolvePeriod(period: DayPeriod): PeriodResult {
  const from = dayMs(period.from);
  const to = dayMs(period.to);
  if (Number.isNaN(from) || Number.isNaN(to)) return { ok: false, error: 'invalid' };
  if (from > to) return { ok: false, error: 'reversed' };
  const days = (to - from) / DAY_MS + 1;
  if (days < USAGE_MIN_DAYS || days > USAGE_MAX_DAYS) return { ok: false, error: 'tooLong' };
  return {
    ok: true,
    from: new Date(from).toISOString(),
    to: new Date(to + DAY_MS - 1).toISOString(),
    days,
  };
}

export const periodErrorKey = (error: PeriodError): string =>
  `portal.monitoring.period.error.${error}`;

const sum = (metric: MetricResultData | undefined): number | undefined =>
  metric && isAvailable(metric)
    ? metric.points.reduce((total, point) => total + point.value, 0)
    : undefined;

/** Usage view of `GET /monitoring/usage` (Req 13.5). */
export interface UsageData {
  readonly totals: readonly MetricResultData[];
  readonly listings: readonly { listingId: string; metrics: readonly MetricResultData[] }[];
}

export interface UsageTotals {
  readonly detailViews: MetricResultData;
  readonly searchImpressions: MetricResultData;
}

export interface UsageListingRow {
  readonly listingId: string;
  /** Sum over the period; `undefined` if not available. */
  readonly detailViews: number | undefined;
  readonly searchImpressions: number | undefined;
}

const unavailable = (code: string): MetricResultData => ({ code, available: false });

/** Daily totals of the agency; a missing metric counts as not available. */
export function usageTotals(view: UsageData): UsageTotals {
  return {
    detailViews: find(view.totals, METRIC.detailViews) ?? unavailable(METRIC.detailViews),
    searchImpressions:
      find(view.totals, METRIC.searchImpressions) ?? unavailable(METRIC.searchImpressions),
  };
}

/** Per-listing sums over the period, in API order. */
export const usageListingRows = (view: UsageData): UsageListingRow[] =>
  view.listings.map(({ listingId, metrics }) => ({
    listingId,
    detailViews: sum(find(metrics, METRIC.detailViews)),
    searchImpressions: sum(find(metrics, METRIC.searchImpressions)),
  }));

/** Sum of a total series over the period; `undefined` if not available. */
export const totalOf = (metric: MetricResultData): number | undefined => sum(metric);

/** Entry of the Kennzahlenkatalog (`GET /metrics`, Req 15.1). */
export interface MetricDefinitionData {
  readonly code: string;
  readonly description: string;
  readonly scope: (typeof METRIC_SCOPES)[number];
  readonly intervals: readonly (typeof METRIC_INTERVALS)[number][];
}

/**
 * Catalog metrics of the agency without an own section (Req 15.5); new catalog entries appear
 * here automatically.
 */
export const genericMetrics = <T extends MetricDefinitionData>(catalog: readonly T[]): T[] =>
  catalog.filter((metric) => metric.scope === 'agency' && !OWN_VIEW_CODES.includes(metric.code));

/** Daily aggregation where supported, else the metric's first interval. */
export const preferredInterval = (metric: MetricDefinitionData): MetricInterval =>
  metric.intervals.includes('day') ? 'day' : (metric.intervals[0] ?? 'day');
