// Framework-free logic of the Admin_Modus (design: Agentur_Portal und Admin_Modus; Req 10.3, 10.4,
// 10.7, 10.8, 14.6, 14.7): agency overview rows, platform monitoring periods and endpoint table,
// alarms, agency activity, history size, confirmation texts from `dryRun` counts and the input
// rules of the operation forms. Kept free of Angular imports so it can be unit-tested with Jest.
import {
  AuditLogQuery,
  CHANNELS,
  Email,
  LISTING_BOUNDS,
  LISTING_STATUSES,
  MANAGEMENT_BOUNDS,
  type Channel,
  type ListingStatus,
} from '@open-estate/shared';
import { summarizeOverview, type OverviewSummary } from '../monitoring/agency-monitoring-model';
import {
  isAvailable,
  type MetricInterval,
  type MetricResultData,
} from '../shared/metric-chart/metric-chart-model';

export const PLATFORM_METRIC = {
  latencyP95: 'api.latency_p95',
  requests: 'api.requests',
  responses: 'api.responses',
  versionCount: 'history.version_count',
  storageBytes: 'history.storage_bytes',
  detailViews: 'listing.detail_views',
  searchImpressions: 'listing.search_impressions',
} as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Agencies (Req 10.3)
// ---------------------------------------------------------------------------------------------

/** Row of `GET /agencies` (`AgencySummary`). */
export interface AgencySummaryData {
  readonly agencyId: string;
  readonly displayName: string;
  readonly state: string;
  readonly createdAt: string;
  readonly memberCount: number;
  readonly listingCounts: Readonly<Record<ListingStatus, number>>;
  readonly lastChangedAt?: string | undefined;
}

export interface AgencyRow {
  readonly agencyId: string;
  readonly displayName: string;
  readonly state: string;
  readonly suspended: boolean;
  readonly memberCount: number;
  readonly listingCounts: Readonly<Record<ListingStatus, number>>;
  readonly listingTotal: number;
  /** `undefined` if the agency was never changed. */
  readonly lastChangedAt: string | undefined;
}

export const toAgencyRow = (agency: AgencySummaryData): AgencyRow => ({
  agencyId: agency.agencyId,
  displayName: agency.displayName,
  state: agency.state,
  suspended: agency.state === 'SUSPENDED',
  memberCount: agency.memberCount,
  listingCounts: agency.listingCounts,
  listingTotal: LISTING_STATUSES.reduce((sum, s) => sum + (agency.listingCounts[s] ?? 0), 0),
  lastChangedAt: agency.lastChangedAt,
});

/** Display name of a new or renamed agency: trimmed, 1–200 characters (Req 1.4). */
export function validateAgencyName(
  value: string,
): { ok: true; value: string } | { ok: false; messageKey: string; params: Record<string, number> } {
  const name = value.trim();
  const { min, max } = MANAGEMENT_BOUNDS.agencyName;
  return name.length >= min && name.length <= max
    ? { ok: true, value: name }
    : { ok: false, messageKey: 'portal.admin.error.text', params: { min, max } };
}

// ---------------------------------------------------------------------------------------------
// Destructive confirmations (Req 10.8)
// ---------------------------------------------------------------------------------------------

/** Answer of a destructive operation with `?dryRun=true` (`DryRunResponse`). */
export interface DryRunData {
  readonly dryRun: true;
  readonly affectedListings?: number | undefined;
  readonly affectedUsers?: number | undefined;
}

export type DestructiveAction =
  | 'deletion'
  | 'suspendAgency'
  | 'removePlatformAdmin'
  | 'revokeApiKey'
  | 'disableDuplicateDetection';

export interface TranslatedText {
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

/** Content of the confirmation dialog: question plus the affected counts of the preview. */
export interface Confirmation {
  readonly action: DestructiveAction;
  readonly title: TranslatedText;
  readonly lines: readonly TranslatedText[];
  readonly confirmKey: string;
}

/**
 * Dialog text of a destructive operation. Counts come only from the `dryRun` preview; actions
 * without preview (API keys have no `dryRun`) state that no count is available.
 */
export function confirmation(
  action: DestructiveAction,
  target: string,
  preview: DryRunData | undefined,
): Confirmation {
  const lines: TranslatedText[] = [];
  if (preview?.affectedListings !== undefined) {
    lines.push({
      key: 'portal.admin.confirm.affectedListings',
      params: { count: preview.affectedListings },
    });
  }
  if (preview?.affectedUsers !== undefined) {
    lines.push({
      key: 'portal.admin.confirm.affectedUsers',
      params: { count: preview.affectedUsers },
    });
  }
  if (preview === undefined) lines.push({ key: 'portal.admin.confirm.noPreview' });
  lines.push({ key: 'portal.admin.confirm.irreversible' });
  return {
    action,
    title: { key: `portal.admin.confirm.${action}`, params: { target } },
    lines,
    confirmKey: `portal.admin.confirm.do.${action}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Platform monitoring (Req 14.1–14.7)
// ---------------------------------------------------------------------------------------------

/** Periods of `GET /monitoring/platform` within 1 hour … 30 days (Req 14.1). */
export const PLATFORM_PERIODS = {
  '1h': { ms: HOUR_MS, interval: 'hour' },
  '24h': { ms: DAY_MS, interval: 'hour' },
  '7d': { ms: 7 * DAY_MS, interval: 'hour' },
  '30d': { ms: 30 * DAY_MS, interval: 'day' },
} as const satisfies Record<string, { ms: number; interval: MetricInterval }>;

export type PlatformPeriodKey = keyof typeof PLATFORM_PERIODS;
export const PLATFORM_PERIOD_KEYS = Object.keys(PLATFORM_PERIODS) as PlatformPeriodKey[];
export const DEFAULT_PLATFORM_PERIOD: PlatformPeriodKey = '24h';

export const isPlatformPeriodKey = (value: string): value is PlatformPeriodKey =>
  Object.hasOwn(PLATFORM_PERIODS, value);

/**
 * Interval of `GET /monitoring/agency-activity`: its metric `listing.changes` is a daily counter
 * and the Management_API refuses other intervals (`INVALID_PARAMETER`), so the activity is always
 * asked per UTC day — the days that overlap the selected period.
 */
export const AGENCY_ACTIVITY_INTERVAL: MetricInterval = 'day';

/** Query of the period ending `now`. */
export function platformPeriod(
  key: PlatformPeriodKey,
  now: Date,
): { from: string; to: string; interval: MetricInterval } {
  const { ms, interval } = PLATFORM_PERIODS[key];
  return { from: new Date(now.getTime() - ms).toISOString(), to: now.toISOString(), interval };
}

const find = (metrics: readonly MetricResultData[], code: string): MetricResultData =>
  metrics.find((m) => m.code === code) ?? { code, available: false };

/** The platform metrics of the view; a metric missing in the answer counts as unavailable. */
export function platformMetrics(metrics: readonly MetricResultData[]) {
  return {
    latencyP95: find(metrics, PLATFORM_METRIC.latencyP95),
    requests: find(metrics, PLATFORM_METRIC.requests),
    responses: find(metrics, PLATFORM_METRIC.responses),
  };
}

/** A figure of the endpoint table: a number, or not available (Req 14.7). */
export type Figure = number | undefined;

export interface EndpointRow {
  /** `interface/endpoint`, e.g. `search/GET /listings`. */
  readonly key: string;
  readonly interface: string;
  readonly endpoint: string;
  /** Highest p95 latency of an interval in the period (ms). */
  readonly latencyP95: Figure;
  readonly requests: Figure;
  readonly status4xx: Figure;
  readonly status429: Figure;
  readonly status5xx: Figure;
}

const endpointKey = (dims: Readonly<Record<string, string>> | undefined) =>
  `${dims?.['interface'] ?? ''}/${dims?.['endpoint'] ?? ''}`;

/**
 * Per endpoint of Search_API, MCP_Server and Management_API: p95 latency, requests and 4xx/429/5xx
 * responses in the period (Req 14.1). Each column of an unavailable metric is `undefined`; within
 * an available metric an endpoint without points has 0.
 */
export function endpointRows(metrics: readonly MetricResultData[]): EndpointRow[] {
  const { latencyP95, requests, responses } = platformMetrics(metrics);
  const keys = new Map<string, { interface: string; endpoint: string }>();
  for (const metric of [latencyP95, requests, responses]) {
    if (!isAvailable(metric)) continue;
    for (const point of metric.points) {
      keys.set(endpointKey(point.dims), {
        interface: point.dims?.['interface'] ?? '',
        endpoint: point.dims?.['endpoint'] ?? '',
      });
    }
  }
  const sumOf = (metric: MetricResultData, key: string, statusClass?: string): Figure => {
    if (!isAvailable(metric)) return undefined;
    return metric.points
      .filter(
        (p) =>
          endpointKey(p.dims) === key &&
          (statusClass === undefined || p.dims?.['statusClass'] === statusClass),
      )
      .reduce((sum, p) => sum + p.value, 0);
  };
  const maxOf = (metric: MetricResultData, key: string): Figure => {
    if (!isAvailable(metric)) return undefined;
    const values = metric.points.filter((p) => endpointKey(p.dims) === key).map((p) => p.value);
    return values.length === 0 ? undefined : Math.max(...values);
  };
  return [...keys.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, ids]) => ({
      key,
      ...ids,
      latencyP95: maxOf(latencyP95, key),
      requests: sumOf(requests, key),
      status4xx: sumOf(responses, key, '4xx'),
      status429: sumOf(responses, key, '429'),
      status5xx: sumOf(responses, key, '5xx'),
    }));
}

/** Platform alarm (`AlarmView`, Req 14.2). */
export interface AlarmData {
  readonly name: string;
  readonly state: 'OK' | 'ALARM' | 'INSUFFICIENT_DATA';
  readonly updatedAt: string;
}

const ALARM_ORDER: Record<AlarmData['state'], number> = { ALARM: 0, INSUFFICIENT_DATA: 1, OK: 2 };

/** Alarms in state `ALARM` first (highlighted, Req 14.6), then insufficient data, then OK. */
export const sortAlarms = <T extends AlarmData>(alarms: readonly T[]): T[] =>
  [...alarms].sort(
    (a, b) => ALARM_ORDER[a.state] - ALARM_ORDER[b.state] || a.name.localeCompare(b.name),
  );

export const countAlarming = (alarms: readonly AlarmData[]): number =>
  alarms.filter((alarm) => alarm.state === 'ALARM').length;

/** Agency activity of `GET /monitoring/agency-activity` (Req 14.4). */
export interface AgencyActivityData {
  readonly agencyId: string;
  readonly metrics: readonly MetricResultData[];
}

export interface AgencyActivityRow {
  readonly agencyId: string;
  readonly overview: OverviewSummary;
  readonly detailViews: Figure;
  readonly searchImpressions: Figure;
}

const total = (metric: MetricResultData): Figure =>
  isAvailable(metric) ? metric.points.reduce((sum, p) => sum + p.value, 0) : undefined;

export const toActivityRow = (activity: AgencyActivityData): AgencyActivityRow => ({
  agencyId: activity.agencyId,
  overview: summarizeOverview(activity.metrics),
  detailViews: total(find(activity.metrics, PLATFORM_METRIC.detailViews)),
  searchImpressions: total(find(activity.metrics, PLATFORM_METRIC.searchImpressions)),
});

export const CHANNEL_LIST: readonly Channel[] = CHANNELS;

/** Agency of history points without agency (`_none`). */
export const NO_AGENCY = '_none';

export interface HistoryRow {
  /** Agency id, {@link NO_AGENCY}, or `undefined` for the platform total. */
  readonly agencyId: string | undefined;
  readonly versions: Figure;
  readonly bytes: Figure;
}

/**
 * Version history size per agency plus the platform total (Req 14.5); the total row comes last.
 * A point without `agency` dimension is the platform total.
 */
export function historyRows(metrics: readonly MetricResultData[]): HistoryRow[] {
  const versions = find(metrics, PLATFORM_METRIC.versionCount);
  const bytes = find(metrics, PLATFORM_METRIC.storageBytes);
  const valueOf = (metric: MetricResultData, agency: string | undefined): Figure => {
    if (!isAvailable(metric)) return undefined;
    return metric.points.find((p) => p.dims?.['agency'] === agency)?.value ?? 0;
  };
  const agencies = new Set<string>();
  for (const metric of [versions, bytes]) {
    if (!isAvailable(metric)) continue;
    for (const p of metric.points) {
      const agency = p.dims?.['agency'];
      if (agency !== undefined) agencies.add(agency);
    }
  }
  const rows: HistoryRow[] = [...agencies]
    .sort((a, b) => a.localeCompare(b))
    .map((agencyId) => ({
      agencyId,
      versions: valueOf(versions, agencyId),
      bytes: valueOf(bytes, agencyId),
    }));
  rows.push({
    agencyId: undefined,
    versions: valueOf(versions, undefined),
    bytes: valueOf(bytes, undefined),
  });
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Operations (`/platform/*`, Req 10.7)
// ---------------------------------------------------------------------------------------------

export type FieldResult<T> =
  | { ok: true; value: T }
  | { ok: false; field: string; messageKey: string; params?: Record<string, number> };

/** Deletion criterion (Req 18.4 of real-estate-platform): one listing or one data source. */
export type DeletionCriterion = { listingId: string } | { source: string };
export type DeletionKind = 'listingId' | 'source';

export function deletionCriterion(
  kind: DeletionKind,
  value: string,
): FieldResult<DeletionCriterion> {
  const text = value.trim();
  const { min, max } = kind === 'listingId' ? LISTING_BOUNDS.id : LISTING_BOUNDS.source;
  if (text.length < min || text.length > max) {
    return {
      ok: false,
      field: 'deletionValue',
      messageKey: 'portal.admin.error.text',
      params: { min, max },
    };
  }
  return { ok: true, value: kind === 'listingId' ? { listingId: text } : { source: text } };
}

/** Bounds of a rate limit; mirror `rateLimitSchema` of the Admin_API (Req 17.1, 17.6). */
export const RATE_LIMIT_BOUNDS = {
  requests: { min: 1, max: 10_000 },
  windowSeconds: { min: 1, max: 3_600 },
} as const;

export interface RateLimitData {
  readonly requests: number;
  readonly windowSeconds: number;
}

const INTEGER = /^\d+$/;

/** Rate limit inputs: integers within {@link RATE_LIMIT_BOUNDS}; the backend stays authoritative. */
export function parseRateLimit(
  requests: string,
  windowSeconds: string,
): FieldResult<RateLimitData> {
  const values: Record<keyof RateLimitData, string> = { requests, windowSeconds };
  const parsed: Partial<Record<keyof RateLimitData, number>> = {};
  for (const field of ['requests', 'windowSeconds'] as const) {
    const text = values[field].trim();
    const { min, max } = RATE_LIMIT_BOUNDS[field];
    const n = INTEGER.test(text) ? Number(text) : NaN;
    if (!(n >= min && n <= max)) {
      return { ok: false, field, messageKey: 'portal.admin.error.range', params: { min, max } };
    }
    parsed[field] = n;
  }
  return { ok: true, value: parsed as RateLimitData };
}

/** Body of `POST /platform/api-keys`: optional expiry (in the future) and rate limit. */
export function apiKeyRequest(
  input: { expiresAt: string; requests: string; windowSeconds: string },
  now: Date,
): FieldResult<{ expiresAt?: string; rateLimit?: RateLimitData }> {
  const body: { expiresAt?: string; rateLimit?: RateLimitData } = {};
  if (input.expiresAt.trim() !== '') {
    const ms = Date.parse(input.expiresAt);
    if (Number.isNaN(ms) || ms <= now.getTime()) {
      return { ok: false, field: 'expiresAt', messageKey: 'portal.admin.error.future' };
    }
    body.expiresAt = new Date(ms).toISOString();
  }
  if (input.requests.trim() !== '' || input.windowSeconds.trim() !== '') {
    const limit = parseRateLimit(input.requests, input.windowSeconds);
    if (!limit.ok) return limit;
    body.rateLimit = limit.value;
  }
  return { ok: true, value: body };
}

/** E-mail address of a new Plattform_Admin (Req 1.2). */
export function validateEmail(value: string): FieldResult<string> {
  const email = value.trim();
  return Email.safeParse(email).success
    ? { ok: true, value: email }
    : { ok: false, field: 'email', messageKey: 'portal.admin.error.email' };
}

/** A required identifier (API key id, deletion request id, listing id) of an operation form. */
export function requiredId(
  field: string,
  value: string,
  max = MANAGEMENT_BOUNDS.id.max,
): FieldResult<string> {
  const id = value.trim();
  return id.length >= 1 && id.length <= max
    ? { ok: true, value: id }
    : { ok: false, field, messageKey: 'portal.admin.error.text', params: { min: 1, max } };
}

export const ACCESS_MODES = ['open', 'api-keys'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

/** Outcome per function of `POST /platform/reload`. */
export type ReloadOutcomeData =
  | {
      functionName: string;
      status: 'updated';
      previousConfigVersion: string | null;
      configVersion: string;
    }
  | { functionName: string; status: 'failed'; error: string };

export const reloadFailed = (outcomes: readonly ReloadOutcomeData[]): number =>
  outcomes.filter((o) => o.status === 'failed').length;

// ---------------------------------------------------------------------------------------------
// Platform audit log (Req 11.4)
// ---------------------------------------------------------------------------------------------

export interface AuditFilterValues {
  actor: string;
  agencyId: string;
  action: string;
  /** `YYYY-MM-DD` (UTC days) or `''`. */
  from: string;
  to: string;
}

export const EMPTY_AUDIT_FILTERS: AuditFilterValues = {
  actor: '',
  agencyId: '',
  action: '',
  from: '',
  to: '',
};

export type AuditQuery = Partial<Record<keyof AuditFilterValues, string>>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const dayBound = (day: string, end: boolean): string | undefined => {
  if (!DAY.test(day)) return undefined;
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day) return undefined;
  return new Date(end ? ms + DAY_MS - 1 : ms).toISOString();
};

/** Filters of the platform audit log, validated with the API's `AuditLogQuery`. */
export function validateAuditFilters(
  values: AuditFilterValues,
):
  | { ok: true; query: AuditQuery }
  | { ok: false; field: keyof AuditFilterValues; messageKey: string } {
  const query: AuditQuery = {};
  for (const field of ['actor', 'agencyId', 'action'] as const) {
    const value = values[field].trim();
    if (value !== '') query[field] = value;
  }
  for (const field of ['from', 'to'] as const) {
    const value = values[field].trim();
    if (value === '') continue;
    const bound = dayBound(value, field === 'to');
    if (bound === undefined) return { ok: false, field, messageKey: 'portal.admin.error.date' };
    query[field] = bound;
  }
  const result = AuditLogQuery.safeParse(query);
  if (result.success) return { ok: true, query };
  const issue = result.error.issues[0];
  const field = (issue?.path[0] ?? 'from') as keyof AuditFilterValues;
  const reversed = issue?.code === 'custom';
  return {
    ok: false,
    field,
    messageKey: reversed ? 'portal.admin.error.reversed' : 'portal.admin.error.invalid',
  };
}

/** Actor of an audit entry (`ActorRef`), as shown in the table. */
export type ActorData =
  | { kind: 'user'; userId: string; displayName: string }
  | { kind: 'machine'; keyId: string; label: string }
  | { kind: 'connector'; connectorId: string; runId: string }
  | { kind: 'iam'; userArn: string }
  | { kind: 'system'; job: string; runId: string };

export function actorText(actor: ActorData | undefined): { kindKey: string; name: string } {
  if (actor === undefined) return { kindKey: 'portal.admin.auditLog.actor.none', name: '' };
  const kindKey = `portal.admin.auditLog.actor.${actor.kind}`;
  switch (actor.kind) {
    case 'user':
      return { kindKey, name: actor.displayName || actor.userId };
    case 'machine':
      return { kindKey, name: actor.label || actor.keyId };
    case 'connector':
      return { kindKey, name: actor.connectorId };
    case 'iam':
      return { kindKey, name: actor.userArn };
    case 'system':
      return { kindKey, name: actor.job };
  }
}

// ---------------------------------------------------------------------------------------------
// Ein/Aus of the Duplikat-Erkennung (duplicate-detection design: "Ein- und Ausschalten")
// ---------------------------------------------------------------------------------------------

/** Answer of `GET`/`PUT /platform/duplicate-detection` (`DuplicateDetectionView`). */
export interface DuplicateDetectionData {
  readonly enabled: boolean;
  readonly sweep?: { readonly executionName: string; readonly alreadyRunning: boolean } | undefined;
}

/** What the operations view shows for the switch. */
export interface DuplicateDetectionState {
  readonly enabled: boolean;
  readonly statusKey: string;
  /** Label of the button: the change it makes. */
  readonly actionKey: string;
}

export function toDuplicateDetectionState({
  enabled,
}: DuplicateDetectionData): DuplicateDetectionState {
  return {
    enabled,
    statusKey: enabled ? 'portal.admin.ops.duplicates.on' : 'portal.admin.ops.duplicates.off',
    actionKey: enabled
      ? 'portal.admin.ops.duplicates.disable'
      : 'portal.admin.ops.duplicates.enable',
  };
}

/**
 * Success message after switching: off, or on with the started Duplikat_Abgleich that rebuilds the
 * index (`sweep` absent: it could not be started; the daily run or a manual start catches up).
 */
export function duplicateDetectionSwitched(result: DuplicateDetectionData): TranslatedText {
  if (!result.enabled) return { key: 'portal.admin.ops.duplicates.switchedOff' };
  if (result.sweep === undefined) return { key: 'portal.admin.ops.duplicates.switchedOnNoSweep' };
  return {
    key: 'portal.admin.ops.duplicates.switchedOn',
    params: { name: result.sweep.executionName },
  };
}

/** Dialog before switching the Duplikat-Erkennung off: what stops and what stays. */
export function disableDuplicateDetectionConfirmation(): Confirmation {
  return {
    action: 'disableDuplicateDetection',
    title: { key: 'portal.admin.confirm.disableDuplicateDetection' },
    lines: [
      { key: 'portal.admin.ops.duplicates.offEffect' },
      { key: 'portal.admin.ops.duplicates.offKeeps' },
    ],
    confirmKey: 'portal.admin.confirm.do.disableDuplicateDetection',
  };
}
