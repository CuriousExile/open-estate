import {
  AuditLogQuery,
  ConnectorRunsQuery,
  EntityId,
  ListVersionsQuery,
  MetricQuery,
} from '@open-estate/shared';
import { z } from 'zod';

// Request schemas of the audit, monitoring and metric routes. They reuse the shared query
// schemas (one schema source) and only add the period bounds of the individual views and the
// pagination of combined queries.

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Usage of an agency: 1 to 90 days (Req 13.5). */
export const USAGE_MAX_DAYS = 90;
/** Platform monitoring: 1 hour to 30 days (Req 14.1). */
export const PLATFORM_MIN_HOURS = 1;
export const PLATFORM_MAX_DAYS = 30;

/** `pageSize` / `pageToken` of the shared management schemas. */
export const PageQuery = ListVersionsQuery;

interface PeriodBounds {
  minMs?: number;
  maxMs: number;
  /** Human-readable bounds for the error message, e.g. `1 hour and 30 days`. */
  label: string;
}

/**
 * Adds `INVALID_RANGE` on `from` if the span `to - from` leaves `bounds`. Malformed or reversed
 * periods are already reported by the shared `periodRule`.
 */
function periodBounds({ minMs, maxMs, label }: PeriodBounds) {
  return (value: { from?: string; to?: string }, ctx: z.core.$RefinementCtx): void => {
    if (value.from === undefined || value.to === undefined) return;
    const span = Date.parse(value.to) - Date.parse(value.from);
    if (Number.isNaN(span) || span < 0) return;
    if (span <= maxMs && (minMs === undefined || span >= minMs)) return;
    ctx.addIssue({
      code: 'custom',
      path: ['from'],
      message: `The period must be between ${label}`,
      params: { code: 'INVALID_RANGE', details: { fields: ['from', 'to'] } },
    });
  };
}

export { AuditLogQuery, MetricQuery };

/** `GET /monitoring/overview` (Req 13.1): Plattform_Admins may pick an agency. */
export const OverviewQuery = z.object({ agencyId: EntityId.optional() });

/** `GET /monitoring/history-size` (Req 14.5): current values, optionally of one agency. */
export const HistorySizeQuery = OverviewQuery;

/** `GET /monitoring/connector-runs` (Req 13.2, 13.6, 14.3). */
export const ConnectorRunListQuery = z.intersection(
  ConnectorRunsQuery,
  z.object({
    /** Only runs with Ergebnisstatus `FAILURE` or with rejections (Req 13.6). */
    problemsOnly: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  }),
);
export type ConnectorRunListQuery = z.output<typeof ConnectorRunListQuery>;

/** `GET /monitoring/connector-runs/{runId}/rejections` (Req 13.3). */
export const RunIdParams = z.object({ runId: z.string().min(1).max(200) });

/** `GET /monitoring/usage` (Req 13.5): period of at most 90 days, paged over listings. */
export const UsageQuery = z
  .intersection(MetricQuery, PageQuery)
  .superRefine(
    periodBounds({ maxMs: USAGE_MAX_DAYS * DAY_MS, label: `1 and ${USAGE_MAX_DAYS} days` }),
  );
export type UsageQuery = z.output<typeof UsageQuery>;

/** `GET /monitoring/platform` (Req 14.1): period of 1 hour to 30 days. */
export const PlatformQuery = MetricQuery.superRefine(
  periodBounds({
    minMs: PLATFORM_MIN_HOURS * HOUR_MS,
    maxMs: PLATFORM_MAX_DAYS * DAY_MS,
    label: `${PLATFORM_MIN_HOURS} hour and ${PLATFORM_MAX_DAYS} days`,
  }),
);

/**
 * `GET /metrics/{code}`: any string; unknown codes become 400 `UNKNOWN_METRIC` with the code
 * (Req 15.4) instead of a generic format error.
 */
export const MetricCodeParams = z.object({ code: z.string().min(1).max(100) });
