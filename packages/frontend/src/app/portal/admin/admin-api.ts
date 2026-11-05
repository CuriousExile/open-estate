// Framework-free Management_API calls of the Admin_Modus (Req 10.3, 10.4, 10.7, 10.8, 14). Takes
// any `request` with the `ManagementApiClient` signature, so it can be tested with plain Jest.
// Destructive operations come in pairs: `preview…` sends `?dryRun=true` and returns the counts for
// the confirmation dialog, the plain call executes (Req 10.8).
import {
  AgencySummary,
  AgencyView,
  AlarmView,
  AuditEntry,
  ConnectorRunView,
  DryRunResponse,
  MemberView,
  MetricResult,
  page,
} from '@open-estate/shared';
import { z } from 'zod';
import type {
  HttpMethod,
  ManagementRequestOptions,
  ManagementResult,
} from '../../management/management-client';
import type { MetricInterval } from '../shared/metric-chart/metric-chart-model';
import type {
  AccessMode,
  AuditQuery,
  DeletionCriterion,
  RateLimitData,
  ReloadOutcomeData,
} from './admin-model';

export interface AdminRequester {
  request<T = unknown>(
    method: HttpMethod,
    path: string,
    options?: ManagementRequestOptions<T>,
  ): Promise<ManagementResult<T>>;
}

interface Call {
  signal?: AbortSignal;
}

const AgencyPage = page(AgencySummary);
const MemberPage = page(MemberView);
const AuditPage = page(AuditEntry);
const RunPage = page(ConnectorRunView);
const MetricList = z.object({ metrics: z.array(MetricResult) });
const Alarms = z.union([
  z.object({ available: z.literal(true), alarms: z.array(AlarmView) }),
  z.object({ available: z.literal(false) }),
]);
const Activity = z.object({
  agencies: z.array(z.object({ agencyId: z.string(), metrics: z.array(MetricResult) })),
});
const DeletionRequest = z.looseObject({
  requestId: z.string(),
  status: z.string(),
  requestedAt: z.string().optional(),
  executedAt: z.string().optional(),
  removedCount: z.number().optional(),
});
const ApiKey = z.looseObject({
  keyId: z.string(),
  status: z.string(),
  expiresAt: z.string().optional(),
  rateLimit: z.object({ requests: z.number(), windowSeconds: z.number() }).optional(),
});
const CreatedApiKey = ApiKey.extend({ apiKey: z.string() });
const Reload = z.object({
  functions: z.array(
    z.union([
      z.object({
        functionName: z.string(),
        status: z.literal('updated'),
        previousConfigVersion: z.string().nullable(),
        configVersion: z.string(),
      }),
      z.object({ functionName: z.string(), status: z.literal('failed'), error: z.string() }),
    ]),
  ),
});

export type AgencyPageValue = z.output<typeof AgencyPage>;
export type AgencyValue = z.output<typeof AgencyView>;
export type MemberPageValue = z.output<typeof MemberPage>;
export type AuditPageValue = z.output<typeof AuditPage>;
export type RunPageValue = z.output<typeof RunPage>;
export type AlarmsValue = z.output<typeof Alarms>;
export type ActivityValue = z.output<typeof Activity>['agencies'];
export type DeletionRequestValue = z.output<typeof DeletionRequest>;
export type ApiKeyValue = z.output<typeof ApiKey>;
export type CreatedApiKeyValue = z.output<typeof CreatedApiKey>;
export type DryRunValue = z.output<typeof DryRunResponse>;

const opts = <T>(signal: AbortSignal | undefined, parse: (value: unknown) => T) => ({
  ...(signal && { signal }),
  parse,
});
const enc = encodeURIComponent;
const DRY_RUN = { dryRun: 'true' } as const;

// --- agencies (Req 1.4, 1.8, 10.3) -----------------------------------------------------------

export const listAgencies = (
  api: AdminRequester,
  {
    state,
    pageToken,
    pageSize,
    signal,
  }: Call & { state?: string; pageToken?: string; pageSize?: number } = {},
) =>
  api.request('GET', '/agencies', {
    query: { state, pageToken, pageSize },
    ...opts(signal, (v) => AgencyPage.parse(v)),
  });

export const createAgency = (api: AdminRequester, displayName: string, { signal }: Call = {}) =>
  api.request('POST', '/agencies', {
    body: { displayName },
    ...opts(signal, (v) => AgencyView.parse(v)),
  });

export const getAgency = (api: AdminRequester, agencyId: string, { signal }: Call = {}) =>
  api.request(
    'GET',
    `/agencies/${enc(agencyId)}`,
    opts(signal, (v) => AgencyView.parse(v)),
  );

export const updateAgency = (
  api: AdminRequester,
  agencyId: string,
  body: { displayName?: string; state?: string },
  { signal }: Call = {},
) =>
  api.request('PATCH', `/agencies/${enc(agencyId)}`, {
    body,
    ...opts(signal, (v) => AgencyView.parse(v)),
  });

/** `PATCH /agencies/{id}?dryRun=true` with `state: SUSPENDED`: affected listings and users. */
export const previewSuspension = (api: AdminRequester, agencyId: string, { signal }: Call = {}) =>
  api.request('PATCH', `/agencies/${enc(agencyId)}`, {
    query: DRY_RUN,
    body: { state: 'SUSPENDED' },
    ...opts(signal, (v) => DryRunResponse.parse(v)),
  });

/** `GET /monitoring/overview?agencyId=` of one agency (Req 10.2, 13.1). */
export const fetchAgencyOverview = (api: AdminRequester, agencyId: string, { signal }: Call = {}) =>
  api.request('GET', '/monitoring/overview', {
    query: { agencyId },
    ...opts(signal, (v) => MetricList.parse(v).metrics),
  });

// --- platform admins (Req 1.2, 10.8, 10.9) ---------------------------------------------------

export const listPlatformAdmins = (
  api: AdminRequester,
  { pageToken, signal }: Call & { pageToken?: string } = {},
) =>
  api.request('GET', '/platform-admins', {
    query: { pageToken },
    ...opts(signal, (v) => MemberPage.parse(v)),
  });

export const addPlatformAdmin = (api: AdminRequester, email: string, { signal }: Call = {}) =>
  api.request('POST', '/platform-admins', {
    body: { email },
    ...opts(signal, (v) => MemberView.parse(v)),
  });

export const previewRemovePlatformAdmin = (
  api: AdminRequester,
  userId: string,
  { signal }: Call = {},
) =>
  api.request('DELETE', `/platform-admins/${enc(userId)}`, {
    query: DRY_RUN,
    ...opts(signal, (v) => DryRunResponse.parse(v)),
  });

export const removePlatformAdmin = (api: AdminRequester, userId: string, { signal }: Call = {}) =>
  api.request(
    'DELETE',
    `/platform-admins/${enc(userId)}`,
    opts(signal, (v) => v),
  );

// --- platform monitoring (Req 14.1–14.5, 14.7) -----------------------------------------------

export const fetchPlatform = (
  api: AdminRequester,
  { from, to, interval, signal }: Call & { from: string; to: string; interval: MetricInterval },
) =>
  api.request('GET', '/monitoring/platform', {
    query: { from, to, interval },
    ...opts(signal, (v) => MetricList.parse(v).metrics),
  });

export const fetchAlarms = (api: AdminRequester, { signal }: Call = {}) =>
  api.request(
    'GET',
    '/monitoring/alarms',
    opts(signal, (v) => Alarms.parse(v)),
  );

export const fetchAgencyActivity = (
  api: AdminRequester,
  { from, to, interval, signal }: Call & { from: string; to: string; interval: MetricInterval },
) =>
  api.request('GET', '/monitoring/agency-activity', {
    query: { from, to, interval },
    ...opts(signal, (v) => Activity.parse(v).agencies),
  });

export const fetchHistorySize = (api: AdminRequester, { signal }: Call = {}) =>
  api.request(
    'GET',
    '/monitoring/history-size',
    opts(signal, (v) => MetricList.parse(v).metrics),
  );

/** Cross-agency Connector_Läufe with filters (Req 14.3). */
export const fetchPlatformRuns = (
  api: AdminRequester,
  {
    agencyId,
    connectorId,
    status,
    pageToken,
    signal,
  }: Call & { agencyId?: string; connectorId?: string; status?: string; pageToken?: string },
) =>
  api.request('GET', '/monitoring/connector-runs', {
    query: { agencyId, connectorId, status, pageToken },
    ...opts(signal, (v) => RunPage.parse(v)),
  });

// --- platform audit (Req 11.4) ---------------------------------------------------------------

export const fetchAuditLog = (
  api: AdminRequester,
  { query, pageToken, signal }: Call & { query: AuditQuery; pageToken?: string },
) =>
  api.request('GET', '/audit-log', {
    query: { ...query, pageToken },
    ...opts(signal, (v) => AuditPage.parse(v)),
  });

// --- operations `/platform/*` (Req 10.7) -----------------------------------------------------

export const previewDeletion = (
  api: AdminRequester,
  criterion: DeletionCriterion,
  { signal }: Call = {},
) =>
  api.request('POST', '/platform/deletions', {
    query: DRY_RUN,
    body: criterion,
    ...opts(signal, (v) => DryRunResponse.parse(v)),
  });

export const requestDeletion = (
  api: AdminRequester,
  criterion: DeletionCriterion,
  { signal }: Call = {},
) =>
  api.request('POST', '/platform/deletions', {
    body: criterion,
    ...opts(signal, (v) => DeletionRequest.parse(v)),
  });

export const getDeletion = (api: AdminRequester, requestId: string, { signal }: Call = {}) =>
  api.request(
    'GET',
    `/platform/deletions/${enc(requestId)}`,
    opts(signal, (v) => DeletionRequest.parse(v)),
  );

export const removeBlocklistEntry = (
  api: AdminRequester,
  listingId: string,
  { signal }: Call = {},
) =>
  api.request(
    'DELETE',
    `/platform/deletion-blocklist/${enc(listingId)}`,
    opts(signal, (v) => v),
  );

export const createApiKey = (
  api: AdminRequester,
  body: { expiresAt?: string; rateLimit?: RateLimitData },
  { signal }: Call = {},
) =>
  api.request('POST', '/platform/api-keys', {
    body,
    ...opts(signal, (v) => CreatedApiKey.parse(v)),
  });

export const revokeApiKey = (api: AdminRequester, keyId: string, { signal }: Call = {}) =>
  api.request(
    'DELETE',
    `/platform/api-keys/${enc(keyId)}`,
    opts(signal, (v) => ApiKey.parse(v)),
  );

export const setApiKeyRateLimit = (
  api: AdminRequester,
  keyId: string,
  rateLimit: RateLimitData,
  { signal }: Call = {},
) =>
  api.request('PUT', `/platform/api-keys/${enc(keyId)}/rate-limit`, {
    body: rateLimit,
    ...opts(signal, (v) => ApiKey.parse(v)),
  });

export const setRateLimit = (
  api: AdminRequester,
  rateLimit: RateLimitData,
  { signal }: Call = {},
) => api.request('PUT', '/platform/rate-limit', { body: rateLimit, ...opts(signal, (v) => v) });

export const setAccessMode = (api: AdminRequester, mode: AccessMode, { signal }: Call = {}) =>
  api.request('PUT', '/platform/access-mode', { body: { mode }, ...opts(signal, (v) => v) });

export const reload = (api: AdminRequester, { signal }: Call = {}) =>
  api.request('POST', '/platform/reload', {
    ...opts(signal, (v): ReloadOutcomeData[] => Reload.parse(v).functions),
  });
