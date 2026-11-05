import { z } from 'zod';
import { CONTENT_MASK, ListingContent } from '../content';
import type { ApiIssueParams } from '../errors';
import {
  AGENCY_ROLES,
  AGENCY_STATES,
  CHANGE_TYPES,
  CHANNELS,
  IMPORT_MODES,
  LISTING_STATUSES,
  ORIGINS,
  PERMISSIONS,
  ROLES,
  type Permission,
} from '../management';
import {
  HttpUrl,
  IsoDateTime,
  LISTING_BOUNDS,
  ListingBase,
  OFFER_TYPES,
  refineListing,
} from './listing';
import { integer } from './non-aborting';

// Request and response schemas of the Management_API (design: "Management_API"). Request bodies
// are strict (unknown keys are rejected, like the Admin_API); query parameters arrive as strings
// and are coerced, unknown query parameters are ignored. Errors map to the shared catalog via
// `toApiErrors` (Req 16.3).

/** Limits of the Management_API in addition to {@link LISTING_BOUNDS}. */
export const MANAGEMENT_BOUNDS = {
  /** Custom_Id: 1–128 characters, unique within an agency (Req 4.11). */
  customId: { min: 1, max: 128 },
  /** Platform-assigned identifiers (agency, user, machine access, version run ids). */
  id: { min: 1, max: 128 },
  agencyName: { min: 1, max: 200 },
  machineAccessLabel: { min: 1, max: 100 },
  email: { min: 3, max: 254 },
  displayName: { min: 1, max: 200 },
  /** Free-text title filter of the listing overview (Req 4.14). */
  titleQuery: { min: 1, max: LISTING_BOUNDS.title.max },
  pageSize: { min: 1, max: 50, default: 20 },
  pageToken: { min: 1, max: 1024 },
  action: { min: 1, max: 100 },
  metricCode: { min: 1, max: 100 },
  dimension: { min: 1, max: 256 },
} as const;

const M = MANAGEMENT_BOUNDS;

const boundedString = (bounds: { readonly min: number; readonly max: number }) =>
  z.string().min(bounds.min).max(bounds.max);

/** JSON number grammar, so query strings coerce exactly like JSON numbers. */
const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const toNumber = (value: unknown): unknown =>
  typeof value === 'string' && JSON_NUMBER.test(value) ? Number(value) : value;
const toBoolean = (value: unknown): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

const addApiIssue = (
  ctx: z.core.$RefinementCtx,
  message: string,
  params: ApiIssueParams,
  path: PropertyKey[] = [],
) => ctx.addIssue({ code: 'custom', message, params, path });

// ---------------------------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------------------------

export const ListingStatusSchema = z.enum(LISTING_STATUSES);
export const ChannelSchema = z.enum(CHANNELS);
export const OriginSchema = z.enum(ORIGINS);
export const ChangeTypeSchema = z.enum(CHANGE_TYPES);
export const ImportModeSchema = z.enum(IMPORT_MODES);
export const AgencyStateSchema = z.enum(AGENCY_STATES);
export const AgencyRoleSchema = z.enum(AGENCY_ROLES);
export const RoleSchema = z.enum(ROLES);
export const PermissionSchema = z.enum(PERMISSIONS);

/** Custom_Id: external reference of the agency, 1–128 characters (Req 4.11). */
export const CustomId = boundedString(M.customId);
export const EntityId = boundedString(M.id);
export const Email = z.email().min(M.email.min).max(M.email.max);

/** Versionsnummer: starts at 1 per listing. */
export const VersionNumber = integer().min(1);
const QueryVersionNumber = z.preprocess(toNumber, VersionNumber);

const pagination = {
  pageSize: z
    .preprocess(toNumber, integer().min(M.pageSize.min).max(M.pageSize.max))
    .default(M.pageSize.default),
  pageToken: boundedString(M.pageToken).optional(),
};

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

/**
 * Non-empty permission set; every unknown permission yields its own `INVALID_PERMISSION` error
 * (`details.permission`, Req 3.3). Whether a known permission is grantable to a machine access is
 * checked by the domain (`GRANTABLE_MACHINE_PERMISSIONS`). Duplicates are collapsed.
 */
export const PermissionList = z
  .array(z.string().meta({ enum: [...PERMISSIONS] }))
  .min(1)
  .superRefine((permissions, ctx) => {
    permissions.forEach((permission, index) => {
      if (!PERMISSION_SET.has(permission)) {
        addApiIssue(
          ctx,
          `Unknown permission "${permission}"`,
          { code: 'INVALID_PERMISSION', details: { permission } },
          [index],
        );
      }
    });
  })
  .transform((permissions) => [...new Set(permissions)] as Permission[]);

/** Optional ISO-8601 period; `from` > `to` yields `INVALID_RANGE` on `from`. */
function periodRule(
  value: { from?: string | undefined; to?: string | undefined },
  ctx: z.core.$RefinementCtx,
): void {
  const failed = new Set(ctx.issues.map((issue) => issue.path?.[0]));
  const { from, to } = value;
  if (from === undefined || to === undefined || failed.has('from') || failed.has('to')) return;
  if (Date.parse(from) > Date.parse(to)) {
    addApiIssue(
      ctx,
      'from must be less than or equal to to',
      { code: 'INVALID_RANGE', details: { fields: ['from', 'to'] } },
      ['from'],
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Listing content input
// ---------------------------------------------------------------------------------------------

/**
 * Listing_Inhalt as accepted by the Management_API, without refinements so it can be extended
 * (e.g. with the taxonomy enum like `buildSchemas`). `sourceUrl` is optional: for listings with
 * origin `MANUAL` the platform stores the Öffentliche_Detail_URL instead (Req 4.5).
 */
export const ManualContentInputBase = ListingBase.pick(CONTENT_MASK).extend({
  sourceUrl: HttpUrl.optional(),
});

/** Listing_Inhalt input of create/update requests (Req 4.3, 4.5). */
export const ManualContentInput = refineListing(ManualContentInputBase);
export type ManualContentInput = z.output<typeof ManualContentInput>;

// ---------------------------------------------------------------------------------------------
// Listing requests
// ---------------------------------------------------------------------------------------------

/** `POST /listings`: status defaults to `INACTIVE` (Req 4.2); `agencyId` only for Plattform_Admins. */
export const CreateListingRequest = z.strictObject({
  content: ManualContentInput,
  status: ListingStatusSchema.default('INACTIVE'),
  customId: CustomId.optional(),
  agencyId: EntityId.optional(),
});
export type CreateListingRequest = z.output<typeof CreateListingRequest>;

/** `PUT /listings/{id}`: replaces the whole Listing_Inhalt (Req 4.6–4.12). */
export const ReplaceContentRequest = z.strictObject({
  content: ManualContentInput,
  customId: CustomId.optional(),
  baseVersion: VersionNumber,
});
export type ReplaceContentRequest = z.output<typeof ReplaceContentRequest>;

/** `PUT /listings/{id}/status` (Req 6.2, 6.9). */
export const SetStatusRequest = z.strictObject({
  status: ListingStatusSchema,
  baseVersion: VersionNumber.optional(),
});
export type SetStatusRequest = z.output<typeof SetStatusRequest>;

/** `PUT /listings/{id}/agency` (Plattform_Admin, Req 10.6). */
export const AssignAgencyRequest = z.strictObject({
  agencyId: EntityId,
  baseVersion: VersionNumber,
});
export type AssignAgencyRequest = z.output<typeof AssignAgencyRequest>;

/** `POST /listings/{id}/restore` (Req 8.1, 8.5). */
export const RestoreRequest = z.strictObject({
  version: VersionNumber,
  baseVersion: VersionNumber,
});
export type RestoreRequest = z.output<typeof RestoreRequest>;

/** `GET /listings`: filters of Req 4.14; `agencyId` only for Plattform_Admins (Req 10.4). */
export const ListListingsQuery = z.object({
  status: ListingStatusSchema.optional(),
  origin: OriginSchema.optional(),
  offerType: z.enum(OFFER_TYPES).optional(),
  listingType: boundedString(LISTING_BOUNDS.listingType).optional(),
  customId: CustomId.optional(),
  q: boundedString(M.titleQuery).optional(),
  agencyId: EntityId.optional(),
  ...pagination,
});
export type ListListingsQuery = z.output<typeof ListListingsQuery>;

/** `GET /listings/{id}/versions` (Req 7.5). */
export const ListVersionsQuery = z.object(pagination);
export type ListVersionsQuery = z.output<typeof ListVersionsQuery>;

/** `GET /listings/{id}/diff?from=&to=`: any two versions (Req 7.6). */
export const DiffQuery = z.object({ from: QueryVersionNumber, to: QueryVersionNumber });
export type DiffQuery = z.output<typeof DiffQuery>;

/** `?dryRun=true` on destructive operations (Req 10.8). */
export const DryRunQuery = z.object({
  dryRun: z.preprocess(toBoolean, z.boolean()).default(false),
});
export type DryRunQuery = z.output<typeof DryRunQuery>;

// ---------------------------------------------------------------------------------------------
// Agencies, members, machine access
// ---------------------------------------------------------------------------------------------

/** `POST /agencies` (Req 1.4). */
export const CreateAgencyRequest = z.strictObject({ displayName: boundedString(M.agencyName) });
export type CreateAgencyRequest = z.output<typeof CreateAgencyRequest>;

/** `PATCH /agencies/{agencyId}`: rename and/or suspend/reactivate (Req 1.8, 1.9). */
export const UpdateAgencyRequest = z
  .strictObject({
    displayName: boundedString(M.agencyName).optional(),
    state: AgencyStateSchema.optional(),
  })
  .refine((r) => r.displayName !== undefined || r.state !== undefined, {
    message: 'At least one of displayName and state is required',
  });
export type UpdateAgencyRequest = z.output<typeof UpdateAgencyRequest>;

/** `POST /agencies/{agencyId}/members` (Req 1.5). */
export const AddMemberRequest = z.strictObject({ email: Email, role: AgencyRoleSchema });
export type AddMemberRequest = z.output<typeof AddMemberRequest>;

/** `PATCH /agencies/{agencyId}/members/{userId}` (Req 1.6, 1.7). */
export const UpdateMemberRequest = z.strictObject({ role: AgencyRoleSchema });
export type UpdateMemberRequest = z.output<typeof UpdateMemberRequest>;

/** `POST /platform-admins` (Req 1.2, 10.9). */
export const AddPlatformAdminRequest = z.strictObject({ email: Email });
export type AddPlatformAdminRequest = z.output<typeof AddPlatformAdminRequest>;

/** `POST /agencies/{agencyId}/machine-access` (Req 3.1, 3.3). */
export const CreateMachineAccessRequest = z.strictObject({
  label: boundedString(M.machineAccessLabel),
  permissions: PermissionList,
  expiresAt: IsoDateTime.optional(),
});
export type CreateMachineAccessRequest = z.output<typeof CreateMachineAccessRequest>;

// ---------------------------------------------------------------------------------------------
// Audit log and monitoring queries
// ---------------------------------------------------------------------------------------------

/** `GET /audit-log` (Req 11.4, 11.5). */
export const AuditLogQuery = z
  .object({
    actor: boundedString(M.id).optional(),
    agencyId: EntityId.optional(),
    action: boundedString(M.action).optional(),
    from: IsoDateTime.optional(),
    to: IsoDateTime.optional(),
    ...pagination,
  })
  .superRefine(periodRule, { when: () => true });
export type AuditLogQuery = z.output<typeof AuditLogQuery>;

export const METRIC_INTERVALS = ['hour', 'day'] as const;
export const METRIC_UNITS = ['count', 'bytes', 'milliseconds'] as const;
export const METRIC_SCOPES = ['agency', 'platform'] as const;
export const METRIC_DIMENSIONS = [
  'agency',
  'listing',
  'connector',
  'endpoint',
  'status',
  'channel',
  'statusClass',
] as const;

/** Stable Monitoring_Kennzahl code, e.g. `listing.detail_views`. */
export const MetricCode = boundedString(M.metricCode).regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/, {
  message: 'Expected a metric code like listing.detail_views',
});

/** `GET /metrics/{code}` and the `/monitoring/*` periods (Req 13.5, 14.1, 15.2). */
export const MetricQuery = z
  .object({
    from: IsoDateTime,
    to: IsoDateTime,
    interval: z.enum(METRIC_INTERVALS).default('day'),
    agencyId: EntityId.optional(),
    listingId: boundedString(LISTING_BOUNDS.id).optional(),
    connectorId: boundedString(M.dimension).optional(),
    endpoint: boundedString(M.dimension).optional(),
  })
  .superRefine(periodRule, { when: () => true });
export type MetricQuery = z.output<typeof MetricQuery>;

/** `GET /monitoring/connector-runs` (Req 13.2, 14.3). */
export const ConnectorRunsQuery = z
  .object({
    agencyId: EntityId.optional(),
    connectorId: boundedString(M.dimension).optional(),
    status: boundedString(M.dimension).optional(),
    from: IsoDateTime.optional(),
    to: IsoDateTime.optional(),
    ...pagination,
  })
  .superRefine(periodRule, { when: () => true });
export type ConnectorRunsQuery = z.output<typeof ConnectorRunsQuery>;

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

export const ActorRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string(), displayName: z.string() }),
  z.object({ kind: z.literal('machine'), keyId: z.string(), label: z.string() }),
  z.object({ kind: z.literal('connector'), connectorId: z.string(), runId: z.string() }),
  z.object({ kind: z.literal('iam'), userArn: z.string() }),
]);

export const FieldSourceSchema = z.object({
  channel: ChannelSchema,
  actor: ActorRefSchema,
  version: VersionNumber,
});

/** Feldherkunft keyed by content path (e.g. `address.city`). */
export const FieldSourcesSchema = z.record(z.string(), FieldSourceSchema);

/** Paged list; `nextPageToken` is absent on the last page. */
export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextPageToken: z.string().optional() });

/** `GET /listings/{id}` and every successful listing command (Req 4.13). */
export const ListingView = z.object({
  id: boundedString(LISTING_BOUNDS.id),
  content: ListingContent,
  status: ListingStatusSchema,
  origin: OriginSchema,
  customId: CustomId.optional(),
  agencyId: EntityId.optional(),
  version: VersionNumber,
  updatedAt: IsoDateTime,
  fieldSources: FieldSourcesSchema,
  /** `content.sourceUrl` is the derived Öffentliche_Detail_URL (Req 4.5). */
  sourceUrlDerived: z.boolean(),
  source: boundedString(LISTING_BOUNDS.source),
  lastImportedAt: IsoDateTime,
  lastRunId: boundedString(LISTING_BOUNDS.runId),
  /** PII fields and media dropped by the import rules in this request (Req 4.10). */
  droppedFields: z.array(z.string()).optional(),
});
export type ListingView = z.input<typeof ListingView>;

/** Row of the listing overview (Req 5.2). */
export const ListingSummary = z.object({
  id: boundedString(LISTING_BOUNDS.id),
  title: z.string(),
  status: ListingStatusSchema,
  origin: OriginSchema,
  customId: CustomId.optional(),
  agencyId: EntityId.optional(),
  offerTypes: z.array(z.enum(OFFER_TYPES)),
  listingType: z.string(),
  version: VersionNumber,
  updatedAt: IsoDateTime,
});
export type ListingSummary = z.input<typeof ListingSummary>;

export const ListingPage = page(ListingSummary);

/** Changed Inhaltsfeld of a version with its previous Feldherkunft (Req 7.2, 12.11). */
export const ChangedPath = z.object({
  path: z.string(),
  previous: FieldSourceSchema.optional(),
  overwrittenByImport: z.boolean(),
});

/** Entry of the version history (Req 7.5). */
export const VersionEntry = z.object({
  version: VersionNumber,
  changeType: ChangeTypeSchema,
  channel: ChannelSchema,
  actor: ActorRefSchema,
  createdAt: IsoDateTime,
  status: ListingStatusSchema,
  customId: CustomId.optional(),
  agencyId: EntityId.optional(),
  changedPaths: z.array(ChangedPath),
  restoredFrom: VersionNumber.optional(),
});
export type VersionEntry = z.input<typeof VersionEntry>;

export const VersionPage = page(VersionEntry);

/** `GET /listings/{id}/versions/{n}`: entry plus the full Listing_Inhalt of the version. */
export const VersionDetail = VersionEntry.extend({ content: ListingContent });
export type VersionDetail = z.input<typeof VersionDetail>;

const DiffPath = z.array(z.union([z.string(), z.number()]));

/** One Diff entry; values in the API representation (amounts as decimal strings). */
export const DiffEntrySchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), path: DiffPath, value: z.unknown() }),
  z.object({ op: z.literal('remove'), path: DiffPath, oldValue: z.unknown() }),
  z.object({ op: z.literal('change'), path: DiffPath, oldValue: z.unknown(), value: z.unknown() }),
]);

/** `GET /listings/{id}/diff` (Req 7.6). */
export const DiffResponse = z.object({
  from: VersionNumber,
  to: VersionNumber,
  entries: z.array(DiffEntrySchema),
});
export type DiffResponse = z.input<typeof DiffResponse>;

/** `GET /me`: identity and effective permissions for the portal (Req 5.6). */
export const MeResponse = z.object({
  kind: z.enum(['user', 'machine']),
  /** User id (Cognito `sub`) or machine-access key id. */
  id: EntityId,
  displayName: z.string(),
  role: RoleSchema.optional(),
  agencyId: EntityId.optional(),
  permissions: z.array(PermissionSchema),
});
export type MeResponse = z.input<typeof MeResponse>;

export const AgencyView = z.object({
  agencyId: EntityId,
  displayName: boundedString(M.agencyName),
  state: AgencyStateSchema,
  createdAt: IsoDateTime,
});
export type AgencyView = z.input<typeof AgencyView>;

/** Row of the agency overview of the Admin_Modus (Req 10.3). */
export const AgencySummary = AgencyView.extend({
  memberCount: integer().min(0),
  listingCounts: z.object({ ACTIVE: integer().min(0), INACTIVE: integer().min(0) }),
  lastChangedAt: IsoDateTime.optional(),
});
export type AgencySummary = z.input<typeof AgencySummary>;

export const MemberView = z.object({
  userId: EntityId,
  email: z.string(),
  displayName: z.string(),
  role: RoleSchema,
  agencyId: EntityId.optional(),
  createdAt: IsoDateTime,
});
export type MemberView = z.input<typeof MemberView>;

/** Machine access without its secret (Req 3.7). */
export const MachineAccessView = z.object({
  keyId: EntityId,
  agencyId: EntityId,
  label: boundedString(M.machineAccessLabel),
  permissions: z.array(PermissionSchema),
  createdBy: EntityId,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime.optional(),
  revokedAt: IsoDateTime.optional(),
  lastUsedAt: IsoDateTime.optional(),
});
export type MachineAccessView = z.input<typeof MachineAccessView>;

/** Creation response: the secret (`oem_<keyId>_<secret>`) is returned exactly once (Req 3.1). */
export const CreatedMachineAccess = MachineAccessView.extend({ secret: z.string() });
export type CreatedMachineAccess = z.input<typeof CreatedMachineAccess>;

/** Count of affected listings/users of a destructive operation with `dryRun=true` (Req 10.8). */
export const DryRunResponse = z.object({
  dryRun: z.literal(true),
  affectedListings: integer().min(0).optional(),
  affectedUsers: integer().min(0).optional(),
});
export type DryRunResponse = z.input<typeof DryRunResponse>;

/** Audit_Log entry; identifiers, field names and codes only, never PII values (Req 9.4, 11.1). */
export const AuditEntry = z.object({
  id: z.string(),
  timestamp: IsoDateTime,
  actor: ActorRefSchema.optional(),
  channel: ChannelSchema.optional(),
  action: z.string(),
  target: z.string(),
  agencyId: EntityId.optional(),
  result: z.string(),
});
export type AuditEntry = z.input<typeof AuditEntry>;

/** Entry of the Kennzahlenkatalog (Req 15.1). */
export const MetricDefinitionView = z.object({
  code: MetricCode,
  description: z.string(),
  unit: z.enum(METRIC_UNITS),
  scope: z.enum(METRIC_SCOPES),
  intervals: z.array(z.enum(METRIC_INTERVALS)),
  dimensions: z.array(z.enum(METRIC_DIMENSIONS)),
});
export type MetricDefinitionView = z.input<typeof MetricDefinitionView>;

/** Uniform time series of one metric (Req 15.2). */
export const TimeSeriesSchema = z.object({
  code: MetricCode,
  unit: z.enum(METRIC_UNITS),
  interval: z.enum(METRIC_INTERVALS),
  points: z.array(
    z.object({
      t: IsoDateTime,
      value: z.number(),
      dims: z.record(z.string(), z.string()).optional(),
    }),
  ),
});
export type TimeSeriesView = z.input<typeof TimeSeriesSchema>;

/** A metric whose source did not answer within 10 s (Req 14.7). */
export const UnavailableMetric = z.object({ code: MetricCode, available: z.literal(false) });

export const MetricResult = z.union([TimeSeriesSchema, UnavailableMetric]);
export type MetricResult = z.input<typeof MetricResult>;

/** Connector_Lauf summary (Req 13.2). */
export const ConnectorRunView = z.object({
  runId: z.string(),
  connectorId: z.string(),
  agencyId: EntityId.optional(),
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.optional(),
  status: z.string(),
  imported: integer().min(0),
  updated: integer().min(0),
  unchanged: integer().min(0),
  rejected: integer().min(0),
});
export type ConnectorRunView = z.input<typeof ConnectorRunView>;

/** Rejected Import_Datensatz: identity, field names and reason, never values (Req 13.3). */
export const RunRejectionView = z.object({
  listingId: z.string().optional(),
  customId: CustomId.optional(),
  fields: z.array(z.string()),
  reason: z.string(),
});
export type RunRejectionView = z.input<typeof RunRejectionView>;

/** Platform alarm state (Req 14.2). */
export const AlarmView = z.object({
  name: z.string(),
  state: z.enum(['OK', 'ALARM', 'INSUFFICIENT_DATA']),
  updatedAt: IsoDateTime,
});
export type AlarmView = z.input<typeof AlarmView>;
