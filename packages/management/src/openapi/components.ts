import {
  apiKeyRecordSchema,
  deletionRequestRecordSchema,
  rateLimitSchema,
  ACCESS_MODES,
} from '@open-estate/core';
import {
  AgencySummary,
  AgencyView,
  AlarmView,
  AuditEntry,
  ConnectorRunView,
  CreatedMachineAccess,
  DiffResponse,
  DryRunResponse,
  ERROR_CODES,
  ListingPage,
  ListingView,
  MachineAccessView,
  MeResponse,
  MemberView,
  MetricDefinitionView,
  MetricResult,
  page,
  RunRejectionView,
  VersionDetail,
  VersionPage,
} from '@open-estate/shared';
import { z } from 'zod';

// Component schemas of the Management_API document: the shared response schemas of
// `shared/schema/management.ts` (one schema source) plus the shapes of the core use cases that
// have no shared schema. All are rendered in their API (input) representation: amounts and areas
// as decimal strings, like the Search_API document.

const ErrorCode = z.enum(ERROR_CODES);

const ApiError = z.object({
  code: ErrorCode,
  message: z.string().meta({ description: 'Human-readable cause of the error' }),
  field: z.string().optional().meta({ description: 'Affected request field(s)' }),
  details: z.record(z.string(), z.unknown()).optional(),
});

const ErrorResponse = z.object({
  errors: z.array(ApiError).min(1),
  retryAfterSeconds: z.number().int().min(1).optional().meta({
    description: 'Only with RATE_LIMITED: seconds until the next admitted request',
  }),
});

const MetricList = z.object({ metrics: z.array(MetricResult) });

const UsageView = z.object({
  totals: z.array(MetricResult),
  listings: z.array(z.object({ listingId: z.string(), metrics: z.array(MetricResult) })),
  nextPageToken: z.string().optional().meta({ description: 'Absent on the last page' }),
});

const AlarmsView = z.union([
  z.object({ available: z.literal(true), alarms: z.array(AlarmView) }),
  z.object({ available: z.literal(false) }),
]);

const AgencyActivityList = z.object({
  agencies: z.array(z.object({ agencyId: z.string(), metrics: z.array(MetricResult) })),
});

/** Admin_API key record without its hash. */
const ApiKey = apiKeyRecordSchema.omit({ keyHash: true });

const ReloadOutcome = z.union([
  z.object({
    functionName: z.string(),
    status: z.literal('updated'),
    previousConfigVersion: z.string().nullable(),
    configVersion: z.string(),
  }),
  z.object({ functionName: z.string(), status: z.literal('failed'), error: z.string() }),
]);

/** Name → schema; every name is registered under `components.schemas`. */
export const COMPONENT_SCHEMAS = {
  ErrorCode,
  ApiError,
  ErrorResponse,
  MeResponse,
  AgencyView,
  AgencySummaryPage: page(AgencySummary),
  MemberView,
  MemberPage: page(MemberView),
  MachineAccessView,
  MachineAccessPage: page(MachineAccessView),
  CreatedMachineAccess,
  DryRunResponse,
  ListingView,
  ListingPage,
  VersionPage,
  VersionDetail,
  DiffResponse,
  AuditEntryPage: page(AuditEntry),
  MetricResult,
  MetricList,
  MetricDefinitionList: z.object({ metrics: z.array(MetricDefinitionView) }),
  ConnectorRunPage: page(ConnectorRunView),
  RunRejectionPage: page(RunRejectionView),
  UsageView,
  AlarmsView,
  AgencyActivityList,
  DeletionRequest: deletionRequestRecordSchema,
  BlocklistEntryRemoved: z.object({ listingId: z.string() }),
  ApiKey,
  CreatedApiKey: ApiKey.extend({
    apiKey: z.string().meta({ description: 'Plain key; returned exactly once' }),
  }),
  RateLimitSetting: z.object({ rateLimit: rateLimitSchema }),
  AccessModeSetting: z.object({ mode: z.enum(ACCESS_MODES) }),
  ReloadResult: z.object({ functions: z.array(ReloadOutcome) }),
} satisfies Record<string, z.ZodType>;

export type ComponentName = keyof typeof COMPONENT_SCHEMAS;
