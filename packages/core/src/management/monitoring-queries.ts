import type { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import {
  authorize,
  ok,
  type AlarmView,
  type ConnectorRunsQuery,
  type ConnectorRunView,
  type MetricQuery,
  type MetricResult,
  type RunRejectionView,
} from '@open-estate/shared';
import {
  AgencyAuditTrail,
  decisionError,
  notFound,
  type AgencyActor,
  type AgencyAudit,
} from './agency-audit';
import type { AgencyStore } from './agency-store';
import type { ConnectorRunReader } from './connector-run-reader';
import type { KeyPage, KeyPageRequest } from './key-page';
import type { ManagedListingQueryStore } from './listing-store';
import { ownAgency } from './listing-query-service';
import { allAgencyIds, describePlatformAlarms, METRIC_CODES } from './metric-resolvers';
import {
  MONITORING_SOURCE_DEADLINE_MS,
  systemTimer,
  type MonitoringResult,
  type MonitoringService,
  type MonitoringTimer,
} from './monitoring-service';

// Fachliche Monitoring-Abfragen (`/monitoring/*`, design: "Management_API", Req 13.1–13.3, 13.5,
// 14.1–14.5). Metric views compose `MonitoringService.resolveMany` (same access rules, deadline and
// `available: false` per source); connector runs, rejections and alarms are direct source reads.

/** Overview period of the agency view (Req 13.1). */
export const OVERVIEW_DAYS = 30;
/** Default period of the connector run list (Req 13.2: at least the last 90 days). */
export const CONNECTOR_RUN_DAYS = 90;

const DAY_MS = 86_400_000;

export type MonitoringQueryAuditAction =
  | 'monitoring.connector-runs'
  | 'monitoring.run-rejections'
  | 'monitoring.alarms'
  | 'monitoring.agency-activity';

const MONITORING_READ = 'monitoring:read';
const MONITORING_PLATFORM = 'monitoring:platform';

export interface MonitoringQueriesDeps {
  monitoring: MonitoringService;
  connectorRuns: ConnectorRunReader;
  agencies: Pick<AgencyStore<unknown>, 'listByState'>;
  listings: ManagedListingQueryStore;
  cloudWatch: CloudWatchClient;
  /** Name prefix of the platform alarms (the stack prefix, e.g. `OpenEstate-`). */
  alarmNamePrefix: string;
  audit: AgencyAudit;
  clock: () => Date;
  /** Default {@link systemTimer}. */
  timer?: MonitoringTimer;
  /** Default {@link MONITORING_SOURCE_DEADLINE_MS}. */
  deadlineMs?: number;
}

/** Usage view (Req 13.5): totals per day and the per-listing series of one listing page. */
export interface UsageView {
  totals: MetricResult[];
  listings: { listingId: string; metrics: MetricResult[] }[];
  nextCursor?: string;
}

export interface AgencyActivityView {
  agencyId: string;
  metrics: MetricResult[];
}

export type AlarmsView = { available: true; alarms: AlarmView[] } | { available: false };

const USAGE_CODES = [METRIC_CODES.detailViews, METRIC_CODES.searchImpressions] as const;
const ACTIVITY_CODES = [
  METRIC_CODES.listingChanges,
  METRIC_CODES.listingCount,
  METRIC_CODES.detailViews,
  METRIC_CODES.searchImpressions,
] as const;

export class MonitoringQueries {
  private readonly deps: MonitoringQueriesDeps;
  private readonly trail: AgencyAuditTrail<MonitoringQueryAuditAction>;
  private readonly timer: MonitoringTimer;
  private readonly deadlineMs: number;

  constructor(deps: MonitoringQueriesDeps) {
    this.deps = deps;
    this.trail = new AgencyAuditTrail<MonitoringQueryAuditAction>(deps.audit);
    this.timer = deps.timer ?? systemTimer;
    this.deadlineMs = deps.deadlineMs ?? MONITORING_SOURCE_DEADLINE_MS;
  }

  /**
   * `GET /monitoring/overview` (Req 13.1): listings per status and changes per channel of the
   * last 30 days. Platform admins may pass `agencyId`; without it the values are platform sums.
   */
  overview(
    actor: AgencyActor,
    options: { agencyId?: string } = {},
  ): Promise<MonitoringResult<MetricResult[]>> {
    const to = this.deps.clock();
    const from = new Date(to.getTime() - OVERVIEW_DAYS * DAY_MS);
    return this.deps.monitoring.resolveMany(
      actor,
      [METRIC_CODES.listingCount, METRIC_CODES.listingChanges],
      {
        from: from.toISOString(),
        to: to.toISOString(),
        interval: 'day',
        ...(options.agencyId !== undefined && { agencyId: options.agencyId }),
      },
    );
  }

  /**
   * `GET /monitoring/usage` (Req 13.5): detail views and search impressions per day in total and
   * per listing, paged over the agency's listings (newest change first).
   */
  async usage(
    actor: AgencyActor,
    query: MetricQuery,
    page: KeyPageRequest,
  ): Promise<MonitoringResult<UsageView>> {
    const totals = await this.deps.monitoring.resolveMany(actor, USAGE_CODES, query);
    if (!totals.ok) return totals;
    // resolveMany has authorized the agency; agency actors are always their own agency.
    const agencyId = ownAgency(actor.principal) ?? query.agencyId;
    const listingPage = await this.deps.listings.query(
      agencyId !== undefined ? { agencyId } : {},
      page,
    );
    const listings = await Promise.all(
      listingPage.items.map(async ({ listing }) => {
        const metrics = await this.deps.monitoring.resolveMany(actor, USAGE_CODES, {
          ...query,
          listingId: listing.id,
        });
        return { listingId: listing.id, metrics: metrics.ok ? metrics.value : [] };
      }),
    );
    return ok({
      totals: totals.value,
      listings,
      ...(listingPage.nextCursor !== undefined && { nextCursor: listingPage.nextCursor }),
    });
  }

  /**
   * `GET /monitoring/connector-runs` (Req 13.2, 14.3): runs of the actor's agency (default last 90
   * days); platform admins across agencies with filter by agency, connector and status.
   * `problemsOnly` = runs with Ergebnisstatus `FAILURE` or rejections (Req 13.6).
   */
  async connectorRuns(
    actor: AgencyActor,
    query: ConnectorRunsQuery,
    options: { problemsOnly?: boolean } = {},
  ): Promise<MonitoringResult<KeyPage<ConnectorRunView>>> {
    const { principal } = actor;
    const agencyId = query.agencyId ?? ownAgency(principal);
    const denied = decisionError(
      authorize(principal, MONITORING_READ, agencyId ?? null),
      MONITORING_READ,
    );
    if (denied !== null) {
      return this.trail.reject(
        actor,
        'monitoring.connector-runs',
        'connector-runs',
        agencyId,
        denied,
      );
    }
    const now = this.deps.clock();
    const page = await this.deps.connectorRuns.query(
      {
        ...(agencyId !== undefined && { agencyId }),
        ...(query.connectorId !== undefined && { connectorId: query.connectorId }),
        ...(query.status !== undefined && { status: query.status }),
        from: query.from ?? new Date(now.getTime() - CONNECTOR_RUN_DAYS * DAY_MS).toISOString(),
        to: query.to ?? now.toISOString(),
        ...(options.problemsOnly === true && { problemsOnly: true }),
      },
      { limit: query.pageSize, ...(query.pageToken !== undefined && { cursor: query.pageToken }) },
    );
    return ok(page);
  }

  /**
   * `GET /monitoring/connector-runs/{runId}/rejections` (Req 13.3): identifier/Custom_Id, field
   * names and reason, never values. A run of another agency is 404 (Req 2.6).
   */
  async runRejections(
    actor: AgencyActor,
    runId: string,
    page: KeyPageRequest,
  ): Promise<MonitoringResult<KeyPage<RunRejectionView>>> {
    const { principal } = actor;
    const target = `connector-run/${runId}`;
    const result = await this.deps.connectorRuns.rejections(runId, page);
    if (result === null) {
      return this.trail.reject(
        actor,
        'monitoring.run-rejections',
        target,
        ownAgency(principal),
        notFound(),
      );
    }
    const denied = decisionError(
      authorize(principal, MONITORING_READ, result.agencyId ?? null),
      MONITORING_READ,
    );
    if (denied !== null) {
      return this.trail.reject(
        actor,
        'monitoring.run-rejections',
        target,
        ownAgency(principal),
        denied,
      );
    }
    return ok({
      items: result.items,
      ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor }),
    });
  }

  /** `GET /monitoring/platform` (Req 14.1): p95 latency, requests and 4xx/429/5xx per endpoint. */
  platform(actor: AgencyActor, query: MetricQuery): Promise<MonitoringResult<MetricResult[]>> {
    return this.deps.monitoring.resolveMany(
      actor,
      [METRIC_CODES.latencyP95, METRIC_CODES.requests, METRIC_CODES.responses],
      query,
    );
  }

  /** `GET /monitoring/history-size` (Req 14.5): versions and bytes per agency and platform-wide. */
  historySize(actor: AgencyActor, query: MetricQuery): Promise<MonitoringResult<MetricResult[]>> {
    return this.deps.monitoring.resolveMany(
      actor,
      [METRIC_CODES.versionCount, METRIC_CODES.storageBytes],
      query,
    );
  }

  /**
   * `GET /monitoring/alarms` (Req 14.2): state and last state change of every platform alarm; a
   * source slower than the deadline yields `{available: false}` (Req 14.7).
   */
  async alarms(actor: AgencyActor): Promise<MonitoringResult<AlarmsView>> {
    const denied = this.platformDenied(actor);
    if (denied !== null) {
      return this.trail.reject(
        actor,
        'monitoring.alarms',
        'alarms',
        ownAgency(actor.principal),
        denied,
      );
    }
    const alarms = await this.withDeadline((signal) =>
      describePlatformAlarms(this.deps.cloudWatch, this.deps.alarmNamePrefix, signal),
    );
    return ok(alarms === undefined ? { available: false } : { available: true, alarms });
  }

  /**
   * `GET /monitoring/agency-activity` (Req 14.4): per agency changes per channel, listings per
   * status, detail views and search impressions of the period.
   */
  async agencyActivity(
    actor: AgencyActor,
    query: MetricQuery,
  ): Promise<MonitoringResult<AgencyActivityView[]>> {
    const denied = this.platformDenied(actor);
    if (denied !== null) {
      return this.trail.reject(
        actor,
        'monitoring.agency-activity',
        'agency-activity',
        ownAgency(actor.principal),
        denied,
      );
    }
    const ids =
      query.agencyId !== undefined ? [query.agencyId] : await allAgencyIds(this.deps.agencies);
    const views: AgencyActivityView[] = [];
    for (const agencyId of ids) {
      const metrics = await this.deps.monitoring.resolveMany(actor, ACTIVITY_CODES, {
        ...query,
        agencyId,
      });
      if (!metrics.ok) return metrics;
      views.push({ agencyId, metrics: metrics.value });
    }
    return ok(views);
  }

  private platformDenied(actor: AgencyActor) {
    return authorize(actor.principal, MONITORING_PLATFORM, undefined) === 'ALLOW'
      ? null
      : decisionError('FORBIDDEN', MONITORING_PLATFORM);
  }

  /** Result of `source`, or `undefined` if it fails or exceeds the deadline (Req 14.7). */
  private withDeadline<T>(source: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    const controller = new AbortController();
    return new Promise<T | undefined>((resolve) => {
      const cancel = this.timer(() => {
        controller.abort(new Error('Monitoring source timed out'));
        resolve(undefined);
      }, this.deadlineMs);
      source(controller.signal).then(
        (value) => {
          cancel();
          resolve(value);
        },
        () => {
          cancel();
          resolve(undefined);
        },
      );
    });
  }
}
