import {
  AssignAgencyRequest,
  CreateListingRequest,
  ReplaceContentRequest,
  RestoreRequest,
  SetStatusRequest,
  type ErrorCode,
  type Permission,
} from '@open-estate/shared';
import { accessModeInputSchema, createApiKeyInputSchema, rateLimitSchema } from '@open-estate/core';
import { z } from 'zod';
import type { ComponentName } from './components';

// Documentation catalog of the Management_API operations (Req 16.2). Parameters and validated
// bodies come from the route schemas themselves (`Route.schemas`); this catalog adds what a route
// does not carry: the required permission (from `shared/permissions.ts`), summary, success
// responses, the bodies of routes that pass the raw body to the use case (listing commands,
// `/platform/*`) and the operation-specific 404/409 codes.

/** `authenticated`: any principal (no permission); `public`: no authentication at all. */
export type RequiredPermission = Permission | 'authenticated' | 'public';

export interface SuccessDoc {
  status: number;
  description: string;
  /** Component schema of the body; absent = no body. */
  schema?: ComponentName;
  /** Alternative body (e.g. the `dryRun=true` preview), documented as `oneOf`. */
  alternative?: ComponentName;
}

export interface OperationDoc {
  operationId: string;
  summary: string;
  description?: string;
  tag: string;
  permission: RequiredPermission;
  /** Body schema for routes that validate the body inside the use case. */
  body?: z.ZodType;
  responses: readonly SuccessDoc[];
  /** 404 codes; default `NOT_FOUND` for routes with path parameters or an `agencyId` filter. */
  notFound?: readonly ErrorCode[];
  /** 409 codes of the operation; absent = no 409. */
  conflicts?: readonly ErrorCode[];
  /** Additional 403 codes beyond `FORBIDDEN` and `AGENCY_SUSPENDED`. */
  forbidden?: readonly ErrorCode[];
  /** Additional 400 codes beyond the validation codes. */
  badRequest?: readonly ErrorCode[];
}

const ok = (schema: ComponentName, description = 'Success.'): SuccessDoc => ({
  status: 200,
  description,
  schema,
});
const created = (schema: ComponentName, description = 'Created.'): SuccessDoc => ({
  status: 201,
  description,
  schema,
});
const dryRunnable = (schema: ComponentName): SuccessDoc => ({
  status: 200,
  description: 'The changed resource; with `dryRun=true` the preview of affected listings/users.',
  schema,
  alternative: 'DryRunResponse',
});

const LISTING_WRITE_CONFLICTS = [
  'VERSION_CONFLICT',
  'DELETION_BLOCKED',
  'CUSTOM_ID_TAKEN',
] as const;

/** Body of `POST /platform/deletions` (Admin_API "request deletion"). */
const DeletionRequestBody = z.union([
  z.strictObject({ listingId: z.string().min(1).max(200) }),
  z.strictObject({ source: z.string().min(1).max(200) }),
]);

/** Body of the rate-limit operations (Admin_API, Req 17.1, 17.6). */
const RateLimitBody = z.strictObject(rateLimitSchema.shape);

const CreateApiKeyBody = createApiKeyInputSchema.extend({ rateLimit: RateLimitBody.optional() });

const IDENTITY: Record<string, OperationDoc> = {
  'GET /me': {
    operationId: 'getMe',
    summary: 'Identity, role, agency and effective permissions of the caller',
    tag: 'Identity',
    permission: 'authenticated',
    responses: [ok('MeResponse')],
  },
  'GET /agencies': {
    operationId: 'listAgencies',
    summary: 'Agency overview (Admin_Modus)',
    tag: 'Agencies',
    permission: 'agency:manage',
    responses: [ok('AgencySummaryPage')],
  },
  'POST /agencies': {
    operationId: 'createAgency',
    summary: 'Create an agency',
    tag: 'Agencies',
    permission: 'agency:manage',
    responses: [created('AgencyView')],
  },
  'GET /agencies/{agencyId}': {
    operationId: 'getAgency',
    summary: 'Get an agency',
    description: 'Agency actors may read their own agency.',
    tag: 'Agencies',
    permission: 'agency:manage',
    responses: [ok('AgencyView')],
  },
  'PATCH /agencies/{agencyId}': {
    operationId: 'updateAgency',
    summary: 'Rename, suspend or reactivate an agency',
    description: 'Suspending accepts `dryRun=true` and reports the affected listings and users.',
    tag: 'Agencies',
    permission: 'agency:manage',
    responses: [dryRunnable('AgencyView')],
  },
  'GET /agencies/{agencyId}/members': {
    operationId: 'listMembers',
    summary: 'List the members of an agency',
    tag: 'Members',
    permission: 'member:manage',
    responses: [ok('MemberPage')],
  },
  'POST /agencies/{agencyId}/members': {
    operationId: 'addMember',
    summary: 'Add a user to an agency',
    tag: 'Members',
    permission: 'member:manage',
    responses: [created('MemberView')],
    conflicts: ['USER_ALREADY_ASSIGNED'],
  },
  'PATCH /agencies/{agencyId}/members/{userId}': {
    operationId: 'changeMemberRole',
    summary: 'Change the role of a member',
    tag: 'Members',
    permission: 'member:manage',
    responses: [ok('MemberView')],
    conflicts: ['LAST_AGENCY_ADMIN'],
  },
  'DELETE /agencies/{agencyId}/members/{userId}': {
    operationId: 'removeMember',
    summary: 'Remove a member from an agency',
    tag: 'Members',
    permission: 'member:manage',
    responses: [dryRunnable('MemberView')],
    conflicts: ['LAST_AGENCY_ADMIN'],
  },
  'GET /platform-admins': {
    operationId: 'listPlatformAdmins',
    summary: 'List the Plattform_Admins',
    tag: 'Members',
    permission: 'agency:manage',
    responses: [ok('MemberPage')],
  },
  'POST /platform-admins': {
    operationId: 'addPlatformAdmin',
    summary: 'Grant the Plattform_Admin role',
    tag: 'Members',
    permission: 'agency:manage',
    responses: [created('MemberView')],
    conflicts: ['USER_ALREADY_ASSIGNED'],
  },
  'DELETE /platform-admins/{userId}': {
    operationId: 'removePlatformAdmin',
    summary: 'Revoke the Plattform_Admin role',
    tag: 'Members',
    permission: 'agency:manage',
    responses: [dryRunnable('MemberView')],
    conflicts: ['LAST_PLATFORM_ADMIN'],
  },
  'GET /agencies/{agencyId}/machine-access': {
    operationId: 'listMachineAccess',
    summary: 'List the machine accesses of an agency (without secrets)',
    tag: 'Machine access',
    permission: 'machine-access:manage',
    responses: [ok('MachineAccessPage')],
  },
  'POST /agencies/{agencyId}/machine-access': {
    operationId: 'createMachineAccess',
    summary: 'Create a machine access; the secret is returned exactly once',
    tag: 'Machine access',
    permission: 'machine-access:manage',
    responses: [created('CreatedMachineAccess')],
    badRequest: ['INVALID_PERMISSION'],
  },
  'DELETE /agencies/{agencyId}/machine-access/{keyId}': {
    operationId: 'revokeMachineAccess',
    summary: 'Revoke a machine access',
    tag: 'Machine access',
    permission: 'machine-access:manage',
    responses: [dryRunnable('MachineAccessView')],
  },
};

const LISTINGS: Record<string, OperationDoc> = {
  'GET /listings': {
    operationId: 'listListings',
    summary: 'Listing overview with filters',
    description:
      'Plattform_Admins may filter by `agencyId`; agency actors see their own agency. With `ids`, ' +
      'a lookup of up to 50 listings (e.g. a page of search results): those the caller may read, ' +
      'in the given order, in one page; unknown ids and other agencies’ listings are left out.',
    tag: 'Listings',
    permission: 'listing:read',
    responses: [ok('ListingPage')],
  },
  'POST /listings': {
    operationId: 'createListing',
    summary: 'Create a listing (status INACTIVE unless given)',
    description:
      'The content passes the PII filter and the media/tour cleanup of the import; dropped ' +
      'fields are named in `droppedFields`. Plattform_Admins choose the agency with `agencyId`.',
    tag: 'Listings',
    permission: 'listing:write',
    body: CreateListingRequest,
    responses: [created('ListingView')],
    conflicts: ['CUSTOM_ID_TAKEN', 'DELETION_BLOCKED'],
  },
  'GET /listings/by-custom-id/{customId}': {
    operationId: 'getListingByCustomId',
    summary: 'Get a listing by its Custom_Id',
    tag: 'Listings',
    permission: 'listing:read',
    responses: [ok('ListingView')],
  },
  'GET /listings/{id}': {
    operationId: 'getListing',
    summary: 'Get a listing',
    tag: 'Listings',
    permission: 'listing:read',
    responses: [ok('ListingView')],
  },
  'PUT /listings/{id}': {
    operationId: 'replaceListingContent',
    summary: 'Replace the content of a listing',
    description: '`baseVersion` must equal the current version (optimistic locking).',
    tag: 'Listings',
    permission: 'listing:write',
    body: ReplaceContentRequest,
    responses: [ok('ListingView')],
    conflicts: LISTING_WRITE_CONFLICTS,
  },
  'PUT /listings/{id}/status': {
    operationId: 'setListingStatus',
    summary: 'Activate or deactivate a listing',
    tag: 'Listings',
    permission: 'listing:status',
    body: SetStatusRequest,
    responses: [ok('ListingView')],
    conflicts: ['VERSION_CONFLICT', 'DELETION_BLOCKED'],
  },
  'PUT /listings/{id}/agency': {
    operationId: 'assignListingAgency',
    summary: 'Assign a listing to another agency (Plattform_Admin)',
    tag: 'Listings',
    permission: 'listing:assign',
    body: AssignAgencyRequest,
    responses: [ok('ListingView')],
    conflicts: LISTING_WRITE_CONFLICTS,
  },
  'GET /listings/{id}/versions': {
    operationId: 'listListingVersions',
    summary: 'Version history of a listing, newest first',
    tag: 'Versions',
    permission: 'listing:read',
    responses: [ok('VersionPage')],
  },
  'GET /listings/{id}/versions/{n}': {
    operationId: 'getListingVersion',
    summary: 'One version with its full content',
    tag: 'Versions',
    permission: 'listing:read',
    responses: [ok('VersionDetail')],
  },
  'GET /listings/{id}/diff': {
    operationId: 'diffListingVersions',
    summary: 'Field-level difference between two versions',
    tag: 'Versions',
    permission: 'listing:read',
    responses: [ok('DiffResponse')],
  },
  'POST /listings/{id}/restore': {
    operationId: 'restoreListingVersion',
    summary: 'Restore the content of an earlier version as a new version',
    tag: 'Versions',
    permission: 'version:restore',
    body: RestoreRequest,
    responses: [ok('ListingView')],
    conflicts: LISTING_WRITE_CONFLICTS,
  },
};

const MONITORING: Record<string, OperationDoc> = {
  'GET /audit-log': {
    operationId: 'queryAuditLog',
    summary: 'Query the Audit_Log',
    description: 'Plattform_Admins query platform-wide or one agency; others their own agency.',
    tag: 'Audit',
    permission: 'audit:read',
    responses: [ok('AuditEntryPage')],
  },
  'GET /monitoring/overview': {
    operationId: 'getMonitoringOverview',
    summary: 'Monitoring overview of an agency',
    tag: 'Monitoring',
    permission: 'monitoring:read',
    responses: [ok('MetricList')],
  },
  'GET /monitoring/connector-runs': {
    operationId: 'listConnectorRuns',
    summary: 'Connector_Läufe of an agency (or all, for Plattform_Admins)',
    tag: 'Monitoring',
    permission: 'monitoring:read',
    responses: [ok('ConnectorRunPage')],
  },
  'GET /monitoring/connector-runs/{runId}/rejections': {
    operationId: 'listRunRejections',
    summary: 'Rejected Import_Datensätze of a Connector_Lauf',
    tag: 'Monitoring',
    permission: 'monitoring:read',
    responses: [ok('RunRejectionPage')],
  },
  'GET /monitoring/usage': {
    operationId: 'getUsage',
    summary: 'Detail views and search impressions per listing (1–90 days)',
    tag: 'Monitoring',
    permission: 'monitoring:read',
    responses: [ok('UsageView')],
  },
  'GET /monitoring/platform': {
    operationId: 'getPlatformMonitoring',
    summary: 'Platform metrics (1 hour to 30 days)',
    tag: 'Monitoring',
    permission: 'monitoring:platform',
    responses: [ok('MetricList')],
  },
  'GET /monitoring/alarms': {
    operationId: 'getAlarms',
    summary: 'State of the platform alarms',
    tag: 'Monitoring',
    permission: 'monitoring:platform',
    responses: [ok('AlarmsView')],
  },
  'GET /monitoring/agency-activity': {
    operationId: 'getAgencyActivity',
    summary: 'Activity metrics per agency',
    tag: 'Monitoring',
    permission: 'monitoring:platform',
    responses: [ok('AgencyActivityList')],
  },
  'GET /monitoring/history-size': {
    operationId: 'getHistorySize',
    summary: 'Current size of the version history',
    tag: 'Monitoring',
    permission: 'monitoring:platform',
    responses: [ok('MetricList')],
  },
  'GET /metrics': {
    operationId: 'listMetrics',
    summary: 'Kennzahlenkatalog visible to the caller',
    tag: 'Metrics',
    permission: 'monitoring:read',
    responses: [ok('MetricDefinitionList')],
  },
  'GET /metrics/{code}': {
    operationId: 'getMetric',
    summary: 'Time series of one metric',
    description: 'Platform-scoped metrics additionally require `monitoring:platform`.',
    tag: 'Metrics',
    permission: 'monitoring:read',
    responses: [ok('MetricResult')],
    forbidden: ['METRIC_NOT_ALLOWED'],
    badRequest: ['UNKNOWN_METRIC'],
  },
};

const PLATFORM: Record<string, OperationDoc> = {
  'POST /platform/deletions': {
    operationId: 'requestDeletion',
    summary: 'Request the deletion of a listing or of all listings of a source',
    description: 'With `dryRun=true` the number of affected listings, nothing is requested.',
    tag: 'Platform',
    permission: 'platform:operate',
    body: DeletionRequestBody,
    responses: [
      { status: 202, description: 'Deletion requested.', schema: 'DeletionRequest' },
      { status: 200, description: 'Preview (`dryRun=true`).', schema: 'DryRunResponse' },
    ],
    notFound: ['DELETION_TARGET_NOT_FOUND'],
  },
  'GET /platform/deletions/{requestId}': {
    operationId: 'getDeletionRequest',
    summary: 'State of a deletion request',
    tag: 'Platform',
    permission: 'platform:operate',
    responses: [ok('DeletionRequest')],
  },
  'DELETE /platform/deletion-blocklist/{listingId}': {
    operationId: 'removeDeletionBlocklistEntry',
    summary: 'Remove a deletion block so the identifier can be reused',
    tag: 'Platform',
    permission: 'platform:operate',
    responses: [ok('BlocklistEntryRemoved')],
  },
  'POST /platform/api-keys': {
    operationId: 'createApiKey',
    summary: 'Create a Search_API key; the key is returned exactly once',
    tag: 'Platform',
    permission: 'platform:operate',
    body: CreateApiKeyBody,
    responses: [created('CreatedApiKey')],
    badRequest: ['INVALID_RATE_LIMIT'],
    notFound: [],
  },
  'DELETE /platform/api-keys/{keyId}': {
    operationId: 'revokeApiKey',
    summary: 'Revoke a Search_API key',
    tag: 'Platform',
    permission: 'platform:operate',
    responses: [ok('ApiKey')],
  },
  'PUT /platform/api-keys/{keyId}/rate-limit': {
    operationId: 'setApiKeyRateLimit',
    summary: 'Set the rate limit of one Search_API key',
    tag: 'Platform',
    permission: 'platform:operate',
    body: RateLimitBody,
    responses: [ok('ApiKey')],
    badRequest: ['INVALID_RATE_LIMIT'],
  },
  'PUT /platform/rate-limit': {
    operationId: 'setRateLimit',
    summary: 'Set the global rate limit of the Search_API',
    tag: 'Platform',
    permission: 'platform:operate',
    body: RateLimitBody,
    responses: [ok('RateLimitSetting')],
    badRequest: ['INVALID_RATE_LIMIT'],
  },
  'PUT /platform/access-mode': {
    operationId: 'setAccessMode',
    summary: 'Switch the Search_API between open access and API keys',
    tag: 'Platform',
    permission: 'platform:operate',
    body: accessModeInputSchema,
    responses: [ok('AccessModeSetting')],
  },
  'POST /platform/reload': {
    operationId: 'reloadConfiguration',
    summary: 'Restart the API, MCP and connector functions to load new configuration',
    tag: 'Platform',
    permission: 'platform:operate',
    responses: [ok('ReloadResult')],
  },
};

const PUBLIC: Record<string, OperationDoc> = {
  'GET /openapi.json': {
    operationId: 'getOpenApi',
    summary: 'This OpenAPI document',
    tag: 'Documentation',
    permission: 'public',
    responses: [{ status: 200, description: 'OpenAPI 3.1 document of the Management API.' }],
  },
};

/** All documented operations by `METHOD path`. */
export const OPERATIONS: Readonly<Record<string, OperationDoc>> = {
  ...IDENTITY,
  ...LISTINGS,
  ...MONITORING,
  ...PLATFORM,
  ...PUBLIC,
};
