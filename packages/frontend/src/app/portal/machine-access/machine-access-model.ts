// Framework-free model and Management_API calls of the machine-access view (Req 3.1, 3.3, 3.5,
// 3.7). The secret of a new machine access is returned exactly once; it is only ever held in the
// component's memory until the user dismisses it and is never written to any storage.
import {
  CreatedMachineAccess,
  CreateMachineAccessRequest,
  DryRunResponse,
  GRANTABLE_MACHINE_PERMISSIONS,
  MachineAccessView,
  MANAGEMENT_BOUNDS,
  page,
  type Permission,
} from '@open-estate/shared';
import { z } from 'zod';
import { dryRunImpact, type ImpactLine, type ManagementCaller } from '../shared/management-caller';

export type MachineAccess = z.output<typeof MachineAccessView>;
export type CreatedAccess = z.output<typeof CreatedMachineAccess>;
const AccessPage = page(MachineAccessView);

/** Permissions a machine access may be granted (Req 3.3), in the platform's order. */
export const GRANTABLE_PERMISSIONS: readonly Permission[] = GRANTABLE_MACHINE_PERMISSIONS;

const accessesPath = (agencyId: string) =>
  `/agencies/${encodeURIComponent(agencyId)}/machine-access`;
const accessPath = (agencyId: string, keyId: string) =>
  `${accessesPath(agencyId)}/${encodeURIComponent(keyId)}`;

interface Call {
  signal?: AbortSignal;
}

/** `GET /agencies/{agencyId}/machine-access` (Req 3.7): never contains a secret. */
export const fetchMachineAccesses = (
  api: ManagementCaller,
  agencyId: string,
  { pageToken, signal }: Call & { pageToken?: string } = {},
) =>
  api.get(accessesPath(agencyId), {
    query: { pageToken },
    ...(signal && { signal }),
    parse: (value) => AccessPage.parse(value),
  });

/** `POST /agencies/{agencyId}/machine-access` (Req 3.1): the answer carries the secret once. */
export const createMachineAccess = (
  api: ManagementCaller,
  agencyId: string,
  request: CreateMachineAccessRequest,
) =>
  api.post(accessesPath(agencyId), request, {
    parse: (value) => CreatedMachineAccess.parse(value),
  });

/** `DELETE …?dryRun=true` (Req 10.8). */
export const previewRevocation = (api: ManagementCaller, agencyId: string, keyId: string) =>
  api.delete(accessPath(agencyId, keyId), {
    query: { dryRun: true },
    parse: (value) => DryRunResponse.parse(value),
  });

/** `DELETE /agencies/{agencyId}/machine-access/{keyId}` (Req 3.5). */
export const revokeMachineAccess = (api: ManagementCaller, agencyId: string, keyId: string) =>
  api.delete(accessPath(agencyId, keyId), { parse: (value) => MachineAccessView.parse(value) });

/** Splits the creation answer: the listable view and the secret to show once. */
export function splitSecret(created: CreatedAccess): { access: MachineAccess; secret: string } {
  const { secret, ...access } = created;
  return { access, secret };
}

/** Creation form as typed; `expiresAt` from a `datetime-local` input (local time) or `''`. */
export interface CreateValues {
  label: string;
  permissions: readonly string[];
  expiresAt: string;
}

export const EMPTY_CREATE: CreateValues = { label: '', permissions: [], expiresAt: '' };

export type CreateField = 'label' | 'permissions' | 'expiresAt';

export interface CreateError {
  readonly field: CreateField;
  readonly messageKey: string;
  readonly params?: Readonly<Record<string, number>>;
}

const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/;

/** ISO timestamp of a `datetime-local` value, interpreted in the browser's time zone. */
export function localToIso(value: string): string | undefined {
  if (!LOCAL_DATE_TIME.test(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

const errorFor = (field: CreateField): CreateError =>
  field === 'label'
    ? {
        field,
        messageKey: 'portal.machineAccess.error.label',
        params: { ...MANAGEMENT_BOUNDS.machineAccessLabel },
      }
    : { field, messageKey: `portal.machineAccess.error.${field}` };

const CREATE_FIELDS: readonly CreateField[] = ['label', 'permissions', 'expiresAt'];

/**
 * Validates the creation form with the API's request schema; additionally only grantable
 * permissions and an expiry in the future are accepted. One error per field.
 */
export function validateCreate(
  values: CreateValues,
  now: Date,
): { ok: true; request: CreateMachineAccessRequest } | { ok: false; errors: CreateError[] } {
  const failed = new Set<CreateField>();
  const label = values.label.trim();
  const permissions = GRANTABLE_PERMISSIONS.filter((p) => values.permissions.includes(p));
  if (permissions.length !== new Set(values.permissions).size) failed.add('permissions');
  let expiresAt: string | undefined;
  if (values.expiresAt.trim() !== '') {
    expiresAt = localToIso(values.expiresAt.trim());
    if (expiresAt === undefined || Date.parse(expiresAt) <= now.getTime()) failed.add('expiresAt');
  }
  const result = CreateMachineAccessRequest.safeParse({
    label,
    permissions,
    ...(expiresAt !== undefined && { expiresAt }),
  });
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path[0];
      if (field === 'label' || field === 'permissions' || field === 'expiresAt') failed.add(field);
    }
  }
  if (failed.size > 0 || !result.success) {
    return { ok: false, errors: CREATE_FIELDS.filter((f) => failed.has(f)).map(errorFor) };
  }
  return { ok: true, request: result.data };
}

/** Creation fields named by a 400 answer (`permissions.2` → `permissions`). */
export const createErrorsFromApi = (fields: readonly string[]): CreateError[] => {
  const named = new Set(fields.map((field) => field.split('.')[0]));
  return CREATE_FIELDS.filter((f) => named.has(f)).map(errorFor);
};

export type AccessState = 'active' | 'expired' | 'revoked';

/** Revoked wins over expired; both reject every call (Req 3.5, 3.6). */
export function accessState(
  access: Pick<MachineAccess, 'revokedAt' | 'expiresAt'>,
  now: Date,
): AccessState {
  if (access.revokedAt !== undefined) return 'revoked';
  if (access.expiresAt !== undefined && Date.parse(access.expiresAt) <= now.getTime()) {
    return 'expired';
  }
  return 'active';
}

export const permissionKey = (permission: string): string =>
  `portal.machineAccess.permission.${permission}`;

/** Lines of the revocation confirmation from the dry-run counts. */
export const revocationImpact = (preview: z.output<typeof DryRunResponse>): ImpactLine[] =>
  dryRunImpact(preview, 'portal.machineAccess.revoke');

/** Replaces the access with the same `keyId`, or puts it first. */
export function upsertAccess(
  accesses: readonly MachineAccess[],
  access: MachineAccess,
): MachineAccess[] {
  const index = accesses.findIndex((a) => a.keyId === access.keyId);
  if (index === -1) return [access, ...accesses];
  return accesses.map((a, i) => (i === index ? access : a));
}
