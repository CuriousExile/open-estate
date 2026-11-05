// Framework-free model and Management_API calls of the team view (Req 1.5–1.7): members of the
// agency, invitations by email and role, role changes and removal with a dry-run preview.
import {
  AddMemberRequest,
  AGENCY_ROLES,
  DryRunResponse,
  MemberView,
  page,
  UpdateMemberRequest,
  type AgencyRole,
} from '@open-estate/shared';
import * as z from 'zod';
import { dryRunImpact, type ImpactLine, type ManagementCaller } from '../shared/management-caller';

export const MEMBER_ROLES = AGENCY_ROLES;
export type MemberRole = AgencyRole;

export type Member = z.output<typeof MemberView>;
const MemberPage = page(MemberView);

const membersPath = (agencyId: string) => `/agencies/${encodeURIComponent(agencyId)}/members`;
const memberPath = (agencyId: string, userId: string) =>
  `${membersPath(agencyId)}/${encodeURIComponent(userId)}`;

interface Call {
  signal?: AbortSignal;
}

/** `GET /agencies/{agencyId}/members`. */
export const fetchMembers = (
  api: ManagementCaller,
  agencyId: string,
  { pageToken, signal }: Call & { pageToken?: string } = {},
) =>
  api.get(membersPath(agencyId), {
    query: { pageToken },
    ...(signal && { signal }),
    parse: (value) => MemberPage.parse(value),
  });

/** `POST /agencies/{agencyId}/members` (Req 1.5): unknown emails get an account with invitation. */
export const addMember = (api: ManagementCaller, agencyId: string, request: AddMemberRequest) =>
  api.post(membersPath(agencyId), request, { parse: (value) => MemberView.parse(value) });

/** `PATCH /agencies/{agencyId}/members/{userId}` (Req 1.6); 409 for the last agency admin (1.7). */
export const changeRole = (
  api: ManagementCaller,
  agencyId: string,
  userId: string,
  request: UpdateMemberRequest,
) =>
  api.patch(memberPath(agencyId, userId), request, { parse: (value) => MemberView.parse(value) });

/** `DELETE …?dryRun=true`: what the removal would affect, without changing anything. */
export const previewRemoval = (api: ManagementCaller, agencyId: string, userId: string) =>
  api.delete(memberPath(agencyId, userId), {
    query: { dryRun: true },
    parse: (value) => DryRunResponse.parse(value),
  });

/** `DELETE /agencies/{agencyId}/members/{userId}` (Req 1.6, 1.7). */
export const removeMember = (api: ManagementCaller, agencyId: string, userId: string) =>
  api.delete(memberPath(agencyId, userId));

/** Invitation form as typed. */
export interface InviteValues {
  email: string;
  role: string;
}

export const EMPTY_INVITE: InviteValues = { email: '', role: 'AGENCY_MEMBER' };

export type InviteField = keyof InviteValues;

export interface InviteError {
  readonly field: InviteField;
  readonly messageKey: string;
}

const INVITE_ERROR_KEYS: Record<InviteField, string> = {
  email: 'portal.team.error.email',
  role: 'portal.team.error.role',
};

/** Validates the invitation with the API's request schema; one error per field. */
export function validateInvite(
  values: InviteValues,
): { ok: true; request: AddMemberRequest } | { ok: false; errors: InviteError[] } {
  const result = AddMemberRequest.safeParse({ email: values.email.trim(), role: values.role });
  if (result.success) return { ok: true, request: result.data };
  const fields = new Set(result.error.issues.map((issue) => issue.path[0]));
  return {
    ok: false,
    errors: (['email', 'role'] as const)
      .filter((field) => fields.has(field))
      .map((field) => ({ field, messageKey: INVITE_ERROR_KEYS[field] })),
  };
}

/** Invitation fields named by a 400 answer of the API (`email`, `role`). */
export const inviteErrorsFromApi = (fields: readonly string[]): InviteError[] =>
  (['email', 'role'] as const)
    .filter((field) => fields.includes(field))
    .map((field) => ({ field, messageKey: INVITE_ERROR_KEYS[field] }));

export const isMemberRole = (role: string): role is MemberRole =>
  (MEMBER_ROLES as readonly string[]).includes(role);

export const roleKey = (role: string): string => `portal.team.role.${role}`;

/** Lines of the removal confirmation from the dry-run counts. */
export const removalImpact = (preview: z.output<typeof DryRunResponse>): ImpactLine[] =>
  dryRunImpact(preview, 'portal.team.remove');

/** Replaces the member with the same `userId`, or appends it. */
export function upsertMember(members: readonly Member[], member: Member): Member[] {
  const index = members.findIndex((m) => m.userId === member.userId);
  if (index === -1) return [...members, member];
  return members.map((m, i) => (i === index ? member : m));
}
