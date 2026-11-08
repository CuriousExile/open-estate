import {
  DescribeAlarmsCommand,
  GetMetricDataCommand,
  ListMetricsCommand,
  type CloudWatchClient,
  type Dimension,
  type MetricDataQuery,
} from '@aws-sdk/client-cloudwatch';
import {
  AGENCY_STATES,
  CHANNELS,
  LISTING_STATUSES,
  type AlarmView,
  type MetricQuery,
} from '@open-estate/shared';
import { REQUEST_LATENCY_METRIC } from '../observability/observability';
import type { AgencyStore } from './agency-store';
import type { ConnectorRunReader } from './connector-run-reader';
import type { ManagedListingStore } from './listing-store';
import {
  agencyScope,
  listingScope,
  PLATFORM_SCOPE,
  NO_AGENCY_SCOPE_ID,
  type MetricCounterStore,
} from './metric-counter-store';
import type {
  MetricDefinition,
  MetricInterval,
  MetricUnit,
  TimeSeries,
} from './monitoring-service';
import { LISTING_COUNTER_CODES } from './versioned-listing-writer';

// Initial Kennzahlenkatalog (design: "Monitoring und Kennzahlenkatalog", Req 13.1, 13.2, 13.5,
// 14.1, 14.5): one `MetricDefinition` per code with its source call. Platform values of agency
// counters are the sum over all agency scopes, including `agency#_none`.

/**
 * Daily usage counters (written by the UsageAggregator, task 10.5) in the scopes `listing#{id}`
 * and `agency#{id|_none}`, sort key `code#{YYYY-MM-DD}`, TTL 100 days (Req 13.4).
 */
export const USAGE_COUNTER_CODES = {
  detailViews: 'listing.detail_views',
  searchImpressions: 'listing.search_impressions',
} as const;

/** CloudWatch metric `RequestCount` (EMF, task 10.5): dimensions `interface`, `endpoint`, `statusClass`. */
export const MONITORED_REQUEST_COUNT_METRIC = 'RequestCount';

/** `statusClass` values of `RequestCount`; `429` is counted additionally to `4xx`. */
export const REQUEST_STATUS_CLASSES = ['2xx', '4xx', '429', '5xx'] as const;
const RESPONSE_STATUS_CLASSES = ['4xx', '429', '5xx'] as const;

/** Stable codes of the initial catalog. */
export const METRIC_CODES = {
  listingCount: 'listing.count',
  listingChanges: 'listing.changes',
  detailViews: USAGE_COUNTER_CODES.detailViews,
  searchImpressions: USAGE_COUNTER_CODES.searchImpressions,
  connectorRuns: 'connector.runs',
  latencyP95: 'api.latency_p95',
  requests: 'api.requests',
  responses: 'api.responses',
  versionCount: 'history.version_count',
  storageBytes: 'history.storage_bytes',
  /** Listings with a Duplikat_Markierung (duplicate-detection Req 14.5). */
  duplicateFlags: 'listing.duplicate_flags',
  /** Agenturübergreifende Treffer in state `OPEN` (duplicate-detection Req 14.5). */
  crossAgencyOpen: 'duplicate.cross_agency_open',
} as const;

/** Counter of `duplicate.cross_agency_open` in {@link PLATFORM_SCOPE}; set by the Duplikat_Abgleich. */
export const CROSS_AGENCY_OPEN_COUNTER = 'duplicate.cross_agency_open';

/** Daily counters are kept 100 days; longer periods are cut to the retained days. */
export const MAX_COUNTER_DAYS = 100;

/** Parallel source calls per resolver (DynamoDB reads per scope). */
const CONCURRENCY = 8;
const AGENCY_PAGE = 100;
const RUN_PAGE = 100;
/** `GetMetricData` accepts at most 500 queries per call. */
const METRIC_DATA_QUERIES_PER_CALL = 500;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const INTERVAL_MS: Record<MetricInterval, number> = { hour: HOUR_MS, day: DAY_MS };

export interface MetricResolverDeps {
  counters: Pick<MetricCounterStore<unknown>, 'get' | 'listDays'>;
  /** Agency list for platform sums (all states). */
  agencies: Pick<AgencyStore<unknown>, 'listByState'>;
  /** Ownership check of the `listing` filter. */
  listings: Pick<ManagedListingStore<unknown>, 'get'>;
  connectorRuns: ConnectorRunReader;
  cloudWatch: CloudWatchClient;
  /** EMF namespace of `RequestLatency` and `RequestCount`. */
  metricsNamespace: string;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const utcDay = (iso: string) => new Date(Date.parse(iso)).toISOString().slice(0, 10);
const dayStart = (day: string) => `${day}T00:00:00.000Z`;
const isoOf = (iso: string) => new Date(Date.parse(iso)).toISOString();

/** UTC days touched by `[from, to]`, cut to the last {@link MAX_COUNTER_DAYS}. */
export function periodDays(q: Pick<MetricQuery, 'from' | 'to'>): string[] {
  const last = Date.parse(dayStart(utcDay(q.to)));
  const first = Math.max(
    Date.parse(dayStart(utcDay(q.from))),
    last - (MAX_COUNTER_DAYS - 1) * DAY_MS,
  );
  const days: string[] = [];
  for (let t = first; t <= last; t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

/** Start of the `interval` bucket containing `iso`. */
const bucketStart = (iso: string, interval: MetricInterval) => {
  const size = INTERVAL_MS[interval];
  return new Date(Math.floor(Date.parse(iso) / size) * size).toISOString();
};

/** Maps with at most {@link CONCURRENCY} calls in flight; stops when `signal` aborts. */
async function mapLimited<T, R>(
  items: readonly T[],
  signal: AbortSignal,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      signal.throwIfAborted();
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
}

/** All agency ids (every state), ordered by state then id. */
export async function allAgencyIds(
  agencies: Pick<AgencyStore<unknown>, 'listByState'>,
  signal?: AbortSignal,
): Promise<string[]> {
  const ids: string[] = [];
  for (const state of AGENCY_STATES) {
    let cursor: string | undefined;
    do {
      signal?.throwIfAborted();
      const page = await agencies.listByState(state, {
        limit: AGENCY_PAGE,
        ...(cursor !== undefined && { cursor }),
      });
      ids.push(...page.items.map((agency) => agency.agencyId));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }
  return ids;
}

/** `agency#{q.agencyId}`, or every agency scope plus `agency#_none` (platform sum). */
async function agencyScopes(deps: MetricResolverDeps, q: MetricQuery, signal: AbortSignal) {
  if (q.agencyId !== undefined) return [{ id: q.agencyId, scope: agencyScope(q.agencyId) }];
  const ids = await allAgencyIds(deps.agencies, signal);
  return [...ids, NO_AGENCY_SCOPE_ID].map((id) => ({ id, scope: `agency#${id}` }));
}

async function sumCurrent(
  deps: MetricResolverDeps,
  scopes: readonly string[],
  code: string,
  signal: AbortSignal,
): Promise<number> {
  const values = await mapLimited(scopes, signal, (scope) =>
    deps.counters.get(scope, code, undefined, signal),
  );
  return values.reduce((sum, value) => sum + value, 0);
}

/** Per-day sums over `scopes`; every day of the period, 0 if never written. */
async function sumDaily(
  deps: MetricResolverDeps,
  scopes: readonly string[],
  code: string,
  days: readonly string[],
  signal: AbortSignal,
): Promise<Map<string, number>> {
  const sums = new Map(days.map((day) => [day, 0]));
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) return sums;
  const perScope = await mapLimited(scopes, signal, (scope) =>
    deps.counters.listDays(scope, code, first, last, signal),
  );
  for (const values of perScope) {
    for (const { day, value } of values) {
      if (sums.has(day)) sums.set(day, (sums.get(day) ?? 0) + value);
    }
  }
  return sums;
}

const series = (
  code: string,
  unit: MetricUnit,
  interval: MetricInterval,
  points: TimeSeries['points'],
): TimeSeries => ({ code, unit, interval, points });

// ---------------------------------------------------------------------------------------------
// MetricCounters resolvers
// ---------------------------------------------------------------------------------------------

/** `listing.count`: current number of listings per Listing_Status, one point at `to` (Req 13.1). */
function listingCount(deps: MetricResolverDeps): MetricDefinition {
  const code = METRIC_CODES.listingCount;
  return {
    code,
    description: 'Current number of listings per listing status',
    unit: 'count',
    scope: 'agency',
    intervals: ['hour', 'day'],
    dimensions: ['status'],
    async resolve(q, signal) {
      const scopes = (await agencyScopes(deps, q, signal)).map(({ scope }) => scope);
      const t = isoOf(q.to);
      const points = await mapLimited(LISTING_STATUSES, signal, async (status) => ({
        t,
        value: await sumCurrent(deps, scopes, LISTING_COUNTER_CODES.status(status), signal),
        dims: { status },
      }));
      return series(code, 'count', q.interval, points);
    },
  };
}

/**
 * `listing.duplicate_flags`: current number of listings with a Duplikat_Markierung, one point at
 * `to` (duplicate-detection Req 14.5); the writer keeps the counter in its transactions.
 */
function duplicateFlags(deps: MetricResolverDeps): MetricDefinition {
  const code = METRIC_CODES.duplicateFlags;
  return {
    code,
    description: 'Current number of listings flagged as possible duplicates',
    unit: 'count',
    scope: 'agency',
    intervals: ['hour', 'day'],
    dimensions: [],
    async resolve(q, signal) {
      const scopes = (await agencyScopes(deps, q, signal)).map(({ scope }) => scope);
      const value = await sumCurrent(deps, scopes, LISTING_COUNTER_CODES.duplicateFlags, signal);
      return series(code, 'count', q.interval, [{ t: isoOf(q.to), value }]);
    },
  };
}

/**
 * `duplicate.cross_agency_open`: agenturübergreifende Treffer in state `OPEN` after the last
 * Duplikat_Abgleich, one point at `to` (duplicate-detection Req 14.5).
 */
function crossAgencyOpen(deps: MetricResolverDeps): MetricDefinition {
  const code = METRIC_CODES.crossAgencyOpen;
  return {
    code,
    description: 'Open possible duplicates across agencies (last daily check)',
    unit: 'count',
    scope: 'platform',
    intervals: ['hour', 'day'],
    dimensions: [],
    async resolve(q, signal) {
      const value = await deps.counters.get(
        PLATFORM_SCOPE,
        CROSS_AGENCY_OPEN_COUNTER,
        undefined,
        signal,
      );
      return series(code, 'count', q.interval, [{ t: isoOf(q.to), value }]);
    },
  };
}

/** `listing.changes`: changes per Änderungskanal and UTC day (Req 13.1, 14.4). */
function listingChanges(deps: MetricResolverDeps): MetricDefinition {
  const code = METRIC_CODES.listingChanges;
  return {
    code,
    description: 'Listing changes per change channel and day',
    unit: 'count',
    scope: 'agency',
    intervals: ['day'],
    dimensions: ['channel'],
    async resolve(q, signal) {
      const scopes = (await agencyScopes(deps, q, signal)).map(({ scope }) => scope);
      const days = periodDays(q);
      const perChannel = await Promise.all(
        CHANNELS.map((channel) =>
          sumDaily(deps, scopes, LISTING_COUNTER_CODES.changes(channel), days, signal),
        ),
      );
      const points = days.flatMap((day) =>
        CHANNELS.map((channel, index) => ({
          t: dayStart(day),
          value: perChannel[index]?.get(day) ?? 0,
          dims: { channel },
        })),
      );
      return series(code, 'count', 'day', points);
    },
  };
}

/**
 * Detail views / search impressions per UTC day (Req 13.5): the agency total, or with `listingId`
 * the listing's own counter (dims `listing`). A listing of another agency yields no points, so its
 * existence is not revealed (Req 2.6).
 */
function usage(deps: MetricResolverDeps, code: string, description: string): MetricDefinition {
  return {
    code,
    description,
    unit: 'count',
    scope: 'agency',
    intervals: ['day'],
    dimensions: ['listing'],
    async resolve(q, signal) {
      const days = periodDays(q);
      if (q.listingId !== undefined) {
        const listingId = q.listingId;
        const listing = await deps.listings.get(listingId);
        signal.throwIfAborted();
        if (
          listing === null ||
          (q.agencyId !== undefined && listing.management.agencyId !== q.agencyId)
        ) {
          return series(code, 'count', 'day', []);
        }
        const sums = await sumDaily(deps, [listingScope(listingId)], code, days, signal);
        return series(
          code,
          'count',
          'day',
          days.map((day) => ({
            t: dayStart(day),
            value: sums.get(day) ?? 0,
            dims: { listing: listingId },
          })),
        );
      }
      const scopes = (await agencyScopes(deps, q, signal)).map(({ scope }) => scope);
      const sums = await sumDaily(deps, scopes, code, days, signal);
      return series(
        code,
        'count',
        'day',
        days.map((day) => ({ t: dayStart(day), value: sums.get(day) ?? 0 })),
      );
    },
  };
}

/**
 * `history.version_count` / `history.storage_bytes` (Req 14.5): current value per agency (dims
 * `agency`, `_none` = listings without agency) plus, without `agencyId` filter, the platform total
 * as point without dims.
 */
function historySize(
  deps: MetricResolverDeps,
  code: string,
  unit: MetricUnit,
  description: string,
): MetricDefinition {
  return {
    code,
    description,
    unit,
    scope: 'platform',
    intervals: ['hour', 'day'],
    dimensions: ['agency'],
    async resolve(q, signal) {
      const scopes = await agencyScopes(deps, q, signal);
      const t = isoOf(q.to);
      const perAgency = await mapLimited(scopes, signal, async ({ id, scope }) => ({
        t,
        value: await deps.counters.get(scope, code, undefined, signal),
        dims: { agency: id },
      }));
      const total = perAgency.reduce((sum, point) => sum + point.value, 0);
      const points = q.agencyId === undefined ? [...perAgency, { t, value: total }] : perAgency;
      return series(code, unit, q.interval, points);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// ConnectorRuns resolver
// ---------------------------------------------------------------------------------------------

/** `connector.runs`: number of runs per interval, connector and Ergebnisstatus (Req 13.2). */
function connectorRuns(deps: MetricResolverDeps): MetricDefinition {
  const code = METRIC_CODES.connectorRuns;
  return {
    code,
    description: 'Connector runs per connector and result status',
    unit: 'count',
    scope: 'agency',
    intervals: ['hour', 'day'],
    dimensions: ['connector', 'status'],
    async resolve(q, signal) {
      const counts = new Map<
        string,
        { t: string; connector: string; status: string; value: number }
      >();
      let cursor: string | undefined;
      do {
        signal.throwIfAborted();
        const page = await deps.connectorRuns.query(
          {
            ...(q.agencyId !== undefined && { agencyId: q.agencyId }),
            ...(q.connectorId !== undefined && { connectorId: q.connectorId }),
            from: q.from,
            to: q.to,
          },
          { limit: RUN_PAGE, ...(cursor !== undefined && { cursor }) },
          signal,
        );
        for (const run of page.items) {
          const t = bucketStart(run.startedAt, q.interval);
          const key = JSON.stringify([t, run.connectorId, run.status]);
          const entry = counts.get(key) ?? {
            t,
            connector: run.connectorId,
            status: run.status,
            value: 0,
          };
          entry.value += 1;
          counts.set(key, entry);
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      const points = [...counts.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, { t, connector, status, value }]) => ({ t, value, dims: { connector, status } }));
      return series(code, 'count', q.interval, points);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// CloudWatch resolvers
// ---------------------------------------------------------------------------------------------

/** One discovered CloudWatch series: its dimensions by name. */
type SeriesDims = Record<string, string>;

const dimensionsOf = (dims: SeriesDims): Dimension[] =>
  Object.entries(dims)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([Name, Value]) => ({ Name, Value }));

/** `endpoint` filter: the bare endpoint or `interface/endpoint`. */
const matchesEndpoint = (dims: SeriesDims, endpoint: string | undefined) =>
  endpoint === undefined ||
  dims.endpoint === endpoint ||
  `${dims.interface}/${dims.endpoint}` === endpoint;

/**
 * Series of `metricName` that carry exactly `names` as dimensions (`ListMetrics`; metrics without
 * data in the last two weeks are not listed, so they have no points either).
 */
async function discoverSeries(
  deps: MetricResolverDeps,
  metricName: string,
  names: readonly string[],
  signal: AbortSignal,
): Promise<SeriesDims[]> {
  const found: SeriesDims[] = [];
  let token: string | undefined;
  do {
    const out = await deps.cloudWatch.send(
      new ListMetricsCommand({
        Namespace: deps.metricsNamespace,
        MetricName: metricName,
        NextToken: token,
      }),
      { abortSignal: signal },
    );
    for (const metric of out.Metrics ?? []) {
      const dims = metric.Dimensions ?? [];
      if (
        dims.length !== names.length ||
        !dims.every((d) => d.Name !== undefined && names.includes(d.Name))
      ) {
        continue;
      }
      found.push(Object.fromEntries(dims.map((d) => [d.Name as string, d.Value ?? ''])));
    }
    token = out.NextToken;
  } while (token !== undefined);
  return found.sort((a, b) => {
    const ka = JSON.stringify(dimensionsOf(a));
    const kb = JSON.stringify(dimensionsOf(b));
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** `GetMetricData` for every series; returns per series index the `(t, value)` pairs. */
async function metricData(
  deps: MetricResolverDeps,
  metricName: string,
  stat: string,
  all: readonly SeriesDims[],
  q: MetricQuery,
  signal: AbortSignal,
): Promise<{ t: string; value: number }[][]> {
  const results = all.map(() => [] as { t: string; value: number }[]);
  for (let offset = 0; offset < all.length; offset += METRIC_DATA_QUERIES_PER_CALL) {
    const chunk = all.slice(offset, offset + METRIC_DATA_QUERIES_PER_CALL);
    const queries: MetricDataQuery[] = chunk.map((dims, index) => ({
      Id: `m${offset + index}`,
      MetricStat: {
        Metric: {
          Namespace: deps.metricsNamespace,
          MetricName: metricName,
          Dimensions: dimensionsOf(dims),
        },
        Period: INTERVAL_MS[q.interval] / 1000,
        Stat: stat,
      },
      ReturnData: true,
    }));
    let token: string | undefined;
    do {
      const out = await deps.cloudWatch.send(
        new GetMetricDataCommand({
          MetricDataQueries: queries,
          StartTime: new Date(Date.parse(q.from)),
          EndTime: new Date(Date.parse(q.to)),
          ScanBy: 'TimestampAscending',
          NextToken: token,
        }),
        { abortSignal: signal },
      );
      for (const result of out.MetricDataResults ?? []) {
        const index = Number(result.Id?.slice(1));
        const target = results[index];
        if (target === undefined) continue;
        const timestamps = result.Timestamps ?? [];
        const values = result.Values ?? [];
        timestamps.forEach((timestamp, i) => {
          const value = values[i];
          if (value !== undefined) target.push({ t: timestamp.toISOString(), value });
        });
      }
      token = out.NextToken;
    } while (token !== undefined);
  }
  for (const points of results) points.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return results;
}

const sortPoints = (points: TimeSeries['points']) =>
  points.sort((a, b) => {
    const ka = `${a.t}|${JSON.stringify(a.dims ?? {})}`;
    const kb = `${b.t}|${JSON.stringify(b.dims ?? {})}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

/** `api.latency_p95`: p95 of `RequestLatency` per interface/endpoint (Req 14.1). */
function latencyP95(deps: MetricResolverDeps): MetricDefinition {
  const code = METRIC_CODES.latencyP95;
  return {
    code,
    description: 'p95 request latency per endpoint of Search_API, MCP_Server and Management_API',
    unit: 'milliseconds',
    scope: 'platform',
    intervals: ['hour', 'day'],
    dimensions: ['endpoint'],
    async resolve(q, signal) {
      const all = (
        await discoverSeries(deps, REQUEST_LATENCY_METRIC, ['interface', 'endpoint'], signal)
      ).filter((dims) => matchesEndpoint(dims, q.endpoint));
      const data = await metricData(deps, REQUEST_LATENCY_METRIC, 'p95', all, q, signal);
      const points = all.flatMap((dims, index) =>
        (data[index] ?? []).map(({ t, value }) => ({ t, value, dims: { ...dims } })),
      );
      return series(code, 'milliseconds', q.interval, sortPoints(points));
    },
  };
}

/** `RequestCount` sums per series (`statusClass` included in the dims). */
async function requestCounts(deps: MetricResolverDeps, q: MetricQuery, signal: AbortSignal) {
  const all = (
    await discoverSeries(
      deps,
      MONITORED_REQUEST_COUNT_METRIC,
      ['interface', 'endpoint', 'statusClass'],
      signal,
    )
  ).filter((dims) => matchesEndpoint(dims, q.endpoint));
  const data = await metricData(deps, MONITORED_REQUEST_COUNT_METRIC, 'Sum', all, q, signal);
  return all.map((dims, index) => ({ dims, points: data[index] ?? [] }));
}

/** `api.requests`: requests per interface/endpoint (all status classes, `429` not twice). */
function requests(deps: MetricResolverDeps): MetricDefinition {
  const code = METRIC_CODES.requests;
  return {
    code,
    description: 'Number of requests per endpoint',
    unit: 'count',
    scope: 'platform',
    intervals: ['hour', 'day'],
    dimensions: ['endpoint'],
    async resolve(q, signal) {
      const sums = new Map<string, { t: string; value: number; dims: SeriesDims }>();
      for (const { dims, points } of await requestCounts(deps, q, signal)) {
        // `429` is already part of `4xx` (design: "Plattform-Kennzahlen").
        if (dims.statusClass === '429') continue;
        const target = { interface: dims.interface ?? '', endpoint: dims.endpoint ?? '' };
        for (const { t, value } of points) {
          const key = JSON.stringify([t, target.interface, target.endpoint]);
          const entry = sums.get(key) ?? { t, value: 0, dims: target };
          entry.value += value;
          sums.set(key, entry);
        }
      }
      return series(code, 'count', q.interval, sortPoints([...sums.values()]));
    },
  };
}

/** `api.responses`: responses with status class 4xx, 429 and 5xx per interface/endpoint. */
function responses(deps: MetricResolverDeps): MetricDefinition {
  const code = METRIC_CODES.responses;
  return {
    code,
    description: 'Number of 4xx, 429 and 5xx responses per endpoint',
    unit: 'count',
    scope: 'platform',
    intervals: ['hour', 'day'],
    dimensions: ['endpoint', 'statusClass'],
    async resolve(q, signal) {
      const points = (await requestCounts(deps, q, signal))
        .filter(({ dims }) =>
          (RESPONSE_STATUS_CLASSES as readonly string[]).includes(dims.statusClass ?? ''),
        )
        .flatMap(({ dims, points: values }) =>
          values.map(({ t, value }) => ({ t, value, dims: { ...dims } })),
        );
      return series(code, 'count', q.interval, sortPoints(points));
    },
  };
}

/** The initial catalog of the design, in catalog order. */
export function createMetricDefinitions(deps: MetricResolverDeps): MetricDefinition[] {
  return [
    listingCount(deps),
    listingChanges(deps),
    duplicateFlags(deps),
    usage(deps, METRIC_CODES.detailViews, 'Detail views per day, total or per listing'),
    usage(deps, METRIC_CODES.searchImpressions, 'Search impressions per day, total or per listing'),
    connectorRuns(deps),
    latencyP95(deps),
    requests(deps),
    responses(deps),
    historySize(deps, METRIC_CODES.versionCount, 'count', 'Stored listing versions per agency'),
    historySize(
      deps,
      METRIC_CODES.storageBytes,
      'bytes',
      'Storage of listing versions in bytes per agency',
    ),
    crossAgencyOpen(deps),
  ];
}

// ---------------------------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------------------------

const ALARM_STATES = new Set<AlarmView['state']>(['OK', 'ALARM', 'INSUFFICIENT_DATA']);

/**
 * Current state of every platform alarm (metric and composite) whose name starts with
 * `alarmNamePrefix` (Req 14.2), ordered by name.
 */
export async function describePlatformAlarms(
  cloudWatch: CloudWatchClient,
  alarmNamePrefix: string,
  signal: AbortSignal,
): Promise<AlarmView[]> {
  const alarms: AlarmView[] = [];
  let token: string | undefined;
  do {
    const out = await cloudWatch.send(
      new DescribeAlarmsCommand({
        AlarmNamePrefix: alarmNamePrefix,
        AlarmTypes: ['MetricAlarm', 'CompositeAlarm'],
        NextToken: token,
      }),
      { abortSignal: signal },
    );
    for (const alarm of [...(out.MetricAlarms ?? []), ...(out.CompositeAlarms ?? [])]) {
      const state = alarm.StateValue as AlarmView['state'] | undefined;
      if (alarm.AlarmName === undefined || state === undefined || !ALARM_STATES.has(state))
        continue;
      const updated = alarm.StateTransitionedTimestamp ?? alarm.StateUpdatedTimestamp;
      alarms.push({
        name: alarm.AlarmName,
        state,
        updatedAt: (updated ?? new Date(0)).toISOString(),
      });
    }
    token = out.NextToken;
  } while (token !== undefined);
  return alarms.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
