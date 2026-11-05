import {
  authorize,
  ok,
  type ApiError,
  type METRIC_DIMENSIONS,
  type METRIC_INTERVALS,
  type METRIC_SCOPES,
  type METRIC_UNITS,
  type MetricDefinitionView,
  type MetricQuery,
  type MetricResult,
  type Principal,
  type Result,
} from '@open-estate/shared';
import {
  AgencyAuditTrail,
  apiError,
  decisionError,
  type AgencyActor,
  type AgencyAudit,
} from './agency-audit';
import { ownAgency } from './listing-query-service';

// Kennzahlenkatalog and uniform metric endpoint (design: "Monitoring und Kennzahlenkatalog",
// Req 14.7, 15). A new metric is a new catalog entry with `resolve`; the response format and the
// existing codes stay unchanged (Req 15.3). The `/monitoring/*` endpoints compose the same
// `resolve` calls via `MonitoringService.resolveMany`.

export type MetricUnit = (typeof METRIC_UNITS)[number];
export type MetricScope = (typeof METRIC_SCOPES)[number];
export type MetricInterval = (typeof METRIC_INTERVALS)[number];
export type MetricDimension = (typeof METRIC_DIMENSIONS)[number];

/** Uniform time series of one metric (Req 15.2); the shape of `TimeSeriesSchema`. */
export interface TimeSeries {
  code: string;
  unit: MetricUnit;
  interval: MetricInterval;
  points: { t: string; value: number; dims?: Record<string, string> }[];
}

/** Catalog entry: metadata plus the source call. */
export interface MetricDefinition {
  /** Stable code, e.g. `listing.detail_views`. */
  code: string;
  description: string;
  unit: MetricUnit;
  scope: MetricScope;
  intervals: MetricInterval[];
  dimensions: MetricDimension[];
  /**
   * Reads the series from the source. For agency actors `q.agencyId` is always the actor's agency,
   * so a resolver only has to restrict its source query to `q.agencyId` when set (Req 2.7).
   * `signal` aborts when the deadline expires.
   */
  resolve(q: MetricQuery, signal: AbortSignal): Promise<TimeSeries>;
}

export const toMetricDefinitionView = (definition: MetricDefinition): MetricDefinitionView => ({
  code: definition.code,
  description: definition.description,
  unit: definition.unit,
  scope: definition.scope,
  intervals: [...definition.intervals],
  dimensions: [...definition.dimensions],
});

/** Immutable set of metric definitions keyed by code. */
export class MetricCatalog {
  private readonly definitions = new Map<string, MetricDefinition>();

  constructor(definitions: readonly MetricDefinition[]) {
    for (const definition of definitions) {
      if (this.definitions.has(definition.code)) {
        throw new Error(`Duplicate metric code ${definition.code}`);
      }
      this.definitions.set(definition.code, definition);
    }
  }

  get(code: string): MetricDefinition | undefined {
    return this.definitions.get(code);
  }

  /** Definitions of the given scopes, in registration order. */
  list(scopes: readonly MetricScope[]): MetricDefinition[] {
    return [...this.definitions.values()].filter((definition) => scopes.includes(definition.scope));
  }
}

/** Deadline of every monitoring source call (Req 14.7). */
export const MONITORING_SOURCE_DEADLINE_MS = 10_000;

/** Schedules `callback` after `ms`; returns the cancel function. Injectable for tests. */
export type MonitoringTimer = (callback: () => void, ms: number) => () => void;

export const systemTimer: MonitoringTimer = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  return () => clearTimeout(handle);
};

export type MonitoringAuditAction = 'metric.catalog' | 'metric.get';

export type MonitoringResult<T> = Result<T, ApiError[]>;

export interface MonitoringServiceDeps {
  catalog: MetricCatalog;
  audit: AgencyAudit;
  /** Default {@link systemTimer}. */
  timer?: MonitoringTimer;
  /** Default {@link MONITORING_SOURCE_DEADLINE_MS}. */
  deadlineMs?: number;
}

const MONITORING_READ = 'monitoring:read';
const MONITORING_PLATFORM = 'monitoring:platform';

/** Query parameter → dimension it filters by (Req 15.2). */
const FILTER_DIMENSIONS = {
  agencyId: 'agency',
  listingId: 'listing',
  connectorId: 'connector',
  // config-check-ignore: dimension name of the metric catalog, not a service endpoint
  endpoint: 'endpoint',
} as const satisfies Partial<Record<keyof MetricQuery, MetricDimension>>;

const metricTarget = (code: string) => `metric/${code}`;

/** Unavailable marker of a metric whose source did not answer in time (Req 14.7). */
const unavailable = (code: string): MetricResult => ({ code, available: false });

const isPlatformAdmin = (principal: Principal) =>
  principal.kind === 'user' && principal.role === 'PLATFORM_ADMIN';

export class MonitoringService {
  private readonly catalogue: MetricCatalog;
  private readonly trail: AgencyAuditTrail<MonitoringAuditAction>;
  private readonly timer: MonitoringTimer;
  private readonly deadlineMs: number;

  constructor(deps: MonitoringServiceDeps) {
    this.catalogue = deps.catalog;
    this.trail = new AgencyAuditTrail<MonitoringAuditAction>(deps.audit);
    this.timer = deps.timer ?? systemTimer;
    this.deadlineMs = deps.deadlineMs ?? MONITORING_SOURCE_DEADLINE_MS;
  }

  /**
   * `GET /metrics` (Req 15.1): agency actors see only agency metrics, Plattform_Admins all.
   * Requires `monitoring:read` in the actor's own agency.
   */
  async catalog(actor: AgencyActor): Promise<MonitoringResult<MetricDefinitionView[]>> {
    const { principal } = actor;
    const agencyId = ownAgency(principal);
    const denied = decisionError(
      authorize(principal, MONITORING_READ, agencyId ?? null),
      MONITORING_READ,
    );
    if (denied !== null)
      return this.trail.reject(actor, 'metric.catalog', 'metric', agencyId, denied);
    const scopes: MetricScope[] = isPlatformAdmin(principal) ? ['agency', 'platform'] : ['agency'];
    return ok(this.catalogue.list(scopes).map(toMetricDefinitionView));
  }

  /**
   * `GET /metrics/{code}` (Req 15.2, 15.4): unknown code → 400 `UNKNOWN_METRIC`, platform metric
   * for an agency actor → 403 `METRIC_NOT_ALLOWED`, another agency → 404 (Req 2.6). A source
   * slower than the deadline yields `{code, available: false}` instead of an error (Req 14.7).
   */
  async query(
    actor: AgencyActor,
    code: string,
    query: MetricQuery,
  ): Promise<MonitoringResult<MetricResult>> {
    const prepared = await this.prepare(actor, code, query);
    if (!prepared.ok) return prepared;
    return ok(await this.resolveWithDeadline(prepared.value.definition, prepared.value.query));
  }

  /**
   * Several metrics of one period, resolved in parallel, each with its own deadline (the
   * `/monitoring/*` views, Req 14.7). Fails with the first rejection before any source is called.
   */
  async resolveMany(
    actor: AgencyActor,
    codes: readonly string[],
    query: MetricQuery,
  ): Promise<MonitoringResult<MetricResult[]>> {
    const prepared: { definition: MetricDefinition; query: MetricQuery }[] = [];
    for (const code of codes) {
      const result = await this.prepare(actor, code, query);
      if (!result.ok) return result;
      prepared.push(result.value);
    }
    return ok(
      await Promise.all(
        prepared.map((entry) => this.resolveWithDeadline(entry.definition, entry.query)),
      ),
    );
  }

  /** Checks code, scope, agency and parameters; returns the definition and the scoped query. */
  private async prepare(
    actor: AgencyActor,
    code: string,
    query: MetricQuery,
  ): Promise<MonitoringResult<{ definition: MetricDefinition; query: MetricQuery }>> {
    const { principal } = actor;
    const target = metricTarget(code);
    const definition = this.catalogue.get(code);
    if (definition === undefined) {
      const error = {
        ...apiError('UNKNOWN_METRIC', `Unknown metric ${code}`),
        field: 'code',
        details: { code },
      };
      return this.trail.reject(actor, 'metric.get', target, query.agencyId, error);
    }

    if (definition.scope === 'platform') {
      if (authorize(principal, MONITORING_PLATFORM, undefined) !== 'ALLOW') {
        const error = {
          ...apiError('METRIC_NOT_ALLOWED', `Metric ${code} is not allowed`),
          field: 'code',
          details: { code },
        };
        return this.trail.reject(actor, 'metric.get', target, ownAgency(principal), error);
      }
    } else {
      // Agency actors are always scoped to their own agency; another agency is NOT_FOUND.
      const agencyId = query.agencyId ?? ownAgency(principal);
      const denied = decisionError(
        authorize(principal, MONITORING_READ, agencyId ?? null),
        MONITORING_READ,
      );
      if (denied !== null) return this.trail.reject(actor, 'metric.get', target, agencyId, denied);
      if (agencyId !== undefined) query = { ...query, agencyId };
    }

    const invalid = unsupportedParameter(definition, query);
    if (invalid !== null)
      return this.trail.reject(actor, 'metric.get', target, query.agencyId, invalid);
    return ok({ definition, query });
  }

  /** Races the source against the deadline; a late or failing source is `available: false`. */
  private resolveWithDeadline(
    definition: MetricDefinition,
    query: MetricQuery,
  ): Promise<MetricResult> {
    const controller = new AbortController();
    return new Promise<MetricResult>((resolve) => {
      const cancel = this.timer(() => {
        controller.abort(new Error(`Metric source ${definition.code} timed out`));
        resolve(unavailable(definition.code));
      }, this.deadlineMs);
      const settle = (result: MetricResult) => {
        cancel();
        resolve(result);
      };
      definition.resolve(query, controller.signal).then(
        (series) => settle(series),
        () => settle(unavailable(definition.code)),
      );
    });
  }
}

/**
 * Interval or dimension filter the metric does not support → 400 `INVALID_PARAMETER`. `agencyId`
 * is always accepted for agency metrics (scoping) and for metrics with the `agency` dimension.
 */
function unsupportedParameter(definition: MetricDefinition, query: MetricQuery): ApiError | null {
  if (!definition.intervals.includes(query.interval)) {
    return {
      ...apiError(
        'INVALID_PARAMETER',
        `Metric ${definition.code} does not support interval ${query.interval}`,
      ),
      field: 'interval',
    };
  }
  for (const [parameter, dimension] of Object.entries(FILTER_DIMENSIONS)) {
    if (query[parameter as keyof typeof FILTER_DIMENSIONS] === undefined) continue;
    if (parameter === 'agencyId' && definition.scope === 'agency') continue;
    if (!definition.dimensions.includes(dimension)) {
      return {
        ...apiError('INVALID_PARAMETER', `Metric ${definition.code} has no dimension ${dimension}`),
        field: parameter,
      };
    }
  }
  return null;
}
