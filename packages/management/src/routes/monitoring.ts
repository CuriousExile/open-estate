import {
  InvalidCursorError,
  ownAgency,
  type AgencyActor,
  type AgencyAudit,
  type AuditRecord,
  type Clock,
  type KeyPage,
} from '@open-estate/core';
import { authorize, type ApiError, type AuditEntry, type Principal } from '@open-estate/shared';
import { principalActor, principalChannel } from '../handler';
import { failure, fromResult, success, type Reply } from '../http';
import { defineRoute, type Route } from '../router';
import {
  AuditLogQuery,
  ConnectorRunListQuery,
  HistorySizeQuery,
  MetricCodeParams,
  MetricQuery,
  OverviewQuery,
  PageQuery,
  PlatformQuery,
  RunIdParams,
  UsageQuery,
} from './monitoring/schemas';
import {
  wireMonitoring,
  type MonitoringRouteDeps,
  type MonitoringWiringOptions,
} from './monitoring/wiring';
import type { RouteGroup } from './route-group';

// Audit, monitoring and metrics (design: "Management_API", Req 11.4, 11.5, 13, 14, 15):
// `/audit-log`, `/monitoring/*` (agency and platform views) and `/metrics[/{code}]`. Access rules,
// agency scoping and the per-source deadline live in the core use cases (`MonitoringService`,
// `MonitoringQueries`); the routes only parse, scope `/audit-log` and shape the responses.

export { MONITORING_ENV, MANAGEMENT_MONITORING_SOURCE_DEADLINE_MS } from './monitoring/wiring';
export type { MonitoringRouteDeps, MonitoringWiringOptions } from './monitoring/wiring';

export interface MonitoringRoutesDeps extends MonitoringRouteDeps {
  /** Audit sink for rejected `/audit-log` queries (403 is audited by the handler). */
  audit: AgencyAudit;
  clock: Clock;
}

const AUDIT_READ = 'audit:read';

const actorOf = (principal: Principal): AgencyActor => ({
  principal,
  channel: principalChannel(principal),
});

const invalidPageToken = (): ApiError => ({
  code: 'INVALID_PAGE_TOKEN',
  message: 'Invalid page token',
  field: 'pageToken',
});

/** A page token not issued by the store is a client error (400), not a 503. */
async function withPageToken(work: () => Promise<Reply>): Promise<Reply> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof InvalidCursorError) return failure(invalidPageToken());
    throw cause;
  }
}

/** `KeyPage` → API page (`items`, `nextPageToken` absent on the last page). */
function toApiPage<T, R = T>(page: KeyPage<T>, map: (item: T) => R = (item) => item as never) {
  return {
    items: page.items.map(map),
    ...(page.nextCursor !== undefined && { nextPageToken: page.nextCursor }),
  };
}

/** Stored audit record → `AuditEntry` view (without the storage category). */
function toAuditEntry(record: AuditRecord): AuditEntry {
  const entry: AuditEntry & { category?: string } = { ...record };
  delete entry.category;
  return entry;
}

/**
 * `GET /audit-log` (Req 11.4, 11.5): Plattform_Admins query platform-wide or one agency;
 * Agentur_Admins and machine accesses with `audit:read` only their own agency — another
 * `agencyId` is 404 (Req 2.6), a missing permission 403.
 */
function auditLogRoute(deps: MonitoringRoutesDeps): Route {
  return defineRoute({
    method: 'GET',
    path: '/audit-log',
    query: AuditLogQuery,
    handle: ({ principal, query }) =>
      withPageToken(async () => {
        const agencyId = query.agencyId ?? ownAgency(principal);
        const decision = authorize(principal, AUDIT_READ, agencyId);
        if (decision === 'FORBIDDEN') {
          return failure({ code: 'FORBIDDEN', message: `Missing permission ${AUDIT_READ}` });
        }
        if (decision === 'NOT_FOUND') {
          await deps.audit.append({
            category: 'management',
            actor: principalActor(principal),
            channel: principalChannel(principal),
            action: 'audit.query',
            target: 'audit-log',
            ...(ownAgency(principal) !== undefined && { agencyId: ownAgency(principal) }),
            result: 'NOT_FOUND',
          });
          return failure({ code: 'NOT_FOUND', message: 'Resource not found' });
        }
        const page = await deps.auditLog.query(
          {
            ...(query.actor !== undefined && { actor: query.actor }),
            ...(agencyId !== undefined && { agencyId }),
            ...(query.action !== undefined && { action: query.action }),
            ...(query.from !== undefined && { from: query.from }),
            ...(query.to !== undefined && { to: query.to }),
          },
          {
            limit: query.pageSize,
            ...(query.pageToken !== undefined && { cursor: query.pageToken }),
          },
        );
        return success(200, toApiPage(page, toAuditEntry));
      }),
  });
}

/** Agency views (`monitoring:read`, Req 13.1–13.3, 13.5, 14.3). */
function agencyMonitoringRoutes({ queries }: MonitoringRoutesDeps): Route[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/monitoring/overview',
      query: OverviewQuery,
      handle: async ({ principal, query }) => {
        const result = await queries.overview(
          actorOf(principal),
          query.agencyId !== undefined ? { agencyId: query.agencyId } : {},
        );
        return result.ok ? success(200, { metrics: result.value }) : failure(result.error);
      },
    }),
    defineRoute({
      method: 'GET',
      path: '/monitoring/connector-runs',
      query: ConnectorRunListQuery,
      handle: ({ principal, query }) =>
        withPageToken(async () => {
          const { problemsOnly, ...filter } = query;
          const result = await queries.connectorRuns(actorOf(principal), filter, { problemsOnly });
          return result.ok ? success(200, toApiPage(result.value)) : failure(result.error);
        }),
    }),
    defineRoute({
      method: 'GET',
      path: '/monitoring/connector-runs/{runId}/rejections',
      params: RunIdParams,
      query: PageQuery,
      handle: ({ principal, params, query }) =>
        withPageToken(async () => {
          const result = await queries.runRejections(actorOf(principal), params.runId, {
            limit: query.pageSize,
            ...(query.pageToken !== undefined && { cursor: query.pageToken }),
          });
          return result.ok ? success(200, toApiPage(result.value)) : failure(result.error);
        }),
    }),
    defineRoute({
      method: 'GET',
      path: '/monitoring/usage',
      query: UsageQuery,
      handle: ({ principal, query }) =>
        withPageToken(async () => {
          const { pageSize, pageToken, ...period } = query;
          const result = await queries.usage(actorOf(principal), period, {
            limit: pageSize,
            ...(pageToken !== undefined && { cursor: pageToken }),
          });
          if (!result.ok) return failure(result.error);
          const { nextCursor, ...view } = result.value;
          return success(200, {
            ...view,
            ...(nextCursor !== undefined && { nextPageToken: nextCursor }),
          });
        }),
    }),
  ];
}

/** Platform views (`monitoring:platform`, Req 14.1, 14.2, 14.4, 14.5). */
function platformMonitoringRoutes({ queries, clock }: MonitoringRoutesDeps): Route[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/monitoring/platform',
      query: PlatformQuery,
      handle: async ({ principal, query }) => {
        const result = await queries.platform(actorOf(principal), query);
        return result.ok ? success(200, { metrics: result.value }) : failure(result.error);
      },
    }),
    defineRoute({
      method: 'GET',
      path: '/monitoring/alarms',
      handle: async ({ principal }) => fromResult(200, await queries.alarms(actorOf(principal))),
    }),
    defineRoute({
      method: 'GET',
      path: '/monitoring/agency-activity',
      query: MetricQuery,
      handle: async ({ principal, query }) => {
        const result = await queries.agencyActivity(actorOf(principal), query);
        return result.ok ? success(200, { agencies: result.value }) : failure(result.error);
      },
    }),
    defineRoute({
      method: 'GET',
      path: '/monitoring/history-size',
      query: HistorySizeQuery,
      handle: async ({ principal, query }) => {
        // Current values: a point at "now"; the period is irrelevant for these counters.
        const now = new Date(clock()).toISOString();
        const result = await queries.historySize(actorOf(principal), {
          from: now,
          to: now,
          interval: 'day',
          ...(query.agencyId !== undefined && { agencyId: query.agencyId }),
        });
        return result.ok ? success(200, { metrics: result.value }) : failure(result.error);
      },
    }),
  ];
}

/** Kennzahlenkatalog and uniform metric endpoint (Req 15.1, 15.2, 15.4). */
function metricRoutes({ monitoring }: MonitoringRoutesDeps): Route[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/metrics',
      handle: async ({ principal }) => {
        const result = await monitoring.catalog(actorOf(principal));
        return result.ok ? success(200, { metrics: result.value }) : failure(result.error);
      },
    }),
    defineRoute({
      method: 'GET',
      path: '/metrics/{code}',
      params: MetricCodeParams,
      query: MetricQuery,
      handle: async ({ principal, params, query }) =>
        fromResult(200, await monitoring.query(actorOf(principal), params.code, query)),
    }),
  ];
}

/** All routes of the group over already wired use cases (tests pass fakes). */
export function createMonitoringRoutes(deps: MonitoringRoutesDeps): Route[] {
  return [
    auditLogRoute(deps),
    ...agencyMonitoringRoutes(deps),
    ...platformMonitoringRoutes(deps),
    ...metricRoutes(deps),
  ];
}

/** Route group wired from the Lambda environment (`MONITORING_ENV` plus the shared tables). */
export function createMonitoringRouteGroup(options: MonitoringWiringOptions = {}): RouteGroup {
  return {
    name: 'monitoring',
    create: (context) =>
      createMonitoringRoutes({
        ...wireMonitoring(context, options),
        audit: context.shared.audit,
        clock: context.shared.clock,
      }),
  };
}

export const monitoringRoutes: RouteGroup = createMonitoringRouteGroup();
