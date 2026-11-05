// Framework-free Management_API calls of the agency monitoring (Req 13.1–13.3, 13.5, 15.1, 15.2).
// Takes any `get` with the `ManagementApiClient` signature, so it can be tested with plain Jest.
import {
  ConnectorRunView,
  MetricDefinitionView,
  MetricResult,
  page,
  RunRejectionView,
} from '@open-estate/shared';
import { z } from 'zod';
import type {
  ManagementRequestOptions,
  ManagementResult,
} from '../../management/management-client';
import type { MetricInterval } from '../shared/metric-chart/metric-chart-model';

export interface MonitoringGetter {
  get<T = unknown>(
    path: string,
    options?: Omit<ManagementRequestOptions<T>, 'body'>,
  ): Promise<ManagementResult<T>>;
}

const MetricList = z.object({ metrics: z.array(MetricResult) });
const RunPage = page(ConnectorRunView);
const RejectionPage = page(RunRejectionView);
const UsageResponse = z.object({
  totals: z.array(MetricResult),
  listings: z.array(z.object({ listingId: z.string(), metrics: z.array(MetricResult) })),
  nextPageToken: z.string().optional(),
});
const Catalog = z.object({ metrics: z.array(MetricDefinitionView) });

export type MetricResultValue = z.output<typeof MetricResult>;
export type ConnectorRunPage = z.output<typeof RunPage>;
export type RejectionPageValue = z.output<typeof RejectionPage>;
export type UsageResponseValue = z.output<typeof UsageResponse>;
export type MetricDefinitionValue = z.output<typeof MetricDefinitionView>;

interface Call {
  signal?: AbortSignal;
}

/** `GET /monitoring/overview` (Req 13.1). */
export const fetchOverview = (api: MonitoringGetter, { signal }: Call = {}) =>
  api.get('/monitoring/overview', {
    ...(signal && { signal }),
    parse: (value) => MetricList.parse(value).metrics,
  });

/** `GET /monitoring/connector-runs` (Req 13.2, 13.6); the API defaults to the last 90 days. */
export const fetchConnectorRuns = (
  api: MonitoringGetter,
  { problemsOnly, pageToken, signal }: Call & { problemsOnly: boolean; pageToken?: string },
) =>
  api.get('/monitoring/connector-runs', {
    query: { problemsOnly: problemsOnly ? 'true' : undefined, pageToken },
    ...(signal && { signal }),
    parse: (value) => RunPage.parse(value),
  });

/** `GET /monitoring/connector-runs/{runId}/rejections` (Req 13.3). */
export const fetchRejections = (
  api: MonitoringGetter,
  runId: string,
  { pageToken, signal }: Call & { pageToken?: string } = {},
) =>
  api.get(`/monitoring/connector-runs/${encodeURIComponent(runId)}/rejections`, {
    query: { pageToken },
    ...(signal && { signal }),
    parse: (value) => RejectionPage.parse(value),
  });

/** `GET /monitoring/usage` (Req 13.5): `from`/`to` as ISO timestamps, at most 90 days apart. */
export const fetchUsage = (
  api: MonitoringGetter,
  { from, to, pageToken, signal }: Call & { from: string; to: string; pageToken?: string },
) =>
  api.get('/monitoring/usage', {
    query: { from, to, interval: 'day', pageToken },
    ...(signal && { signal }),
    parse: (value) => UsageResponse.parse(value),
  });

/** `GET /metrics` (Req 15.1): agency actors see agency metrics only. */
export const fetchCatalog = (api: MonitoringGetter, { signal }: Call = {}) =>
  api.get('/metrics', {
    ...(signal && { signal }),
    parse: (value) => Catalog.parse(value).metrics,
  });

/** `GET /metrics/{code}` (Req 15.2): uniform time series or `{available: false}`. */
export const fetchMetric = (
  api: MonitoringGetter,
  code: string,
  { from, to, interval, signal }: Call & { from: string; to: string; interval: MetricInterval },
) =>
  api.get(`/metrics/${encodeURIComponent(code)}`, {
    query: { from, to, interval },
    ...(signal && { signal }),
    parse: (value) => MetricResult.parse(value),
  });
