import type { AgencyActor, DryRunOr } from '@open-estate/core';
import {
  AddMemberRequest,
  AddPlatformAdminRequest,
  AgencyStateSchema,
  authorize,
  CreateAgencyRequest,
  CreateMachineAccessRequest,
  DryRunQuery,
  EntityId,
  principalPermissions,
  UpdateAgencyRequest,
  UpdateMemberRequest,
  type ApiError,
  type DryRunResponse,
  type MeResponse,
  type Principal,
  type Result,
} from '@open-estate/shared';
import { z } from 'zod';
import { principalChannel } from '../handler';
import { failure, fromResult, success, type Reply } from '../http';
import { defineRoute, type Route } from '../router';
import { PageQuery, toApiPage, toKeyPageRequest, withPageToken } from './identity/paging';
import {
  createIdentityServices,
  type IdentityServiceOptions,
  type IdentityServices,
} from './identity/services';
import type { RouteGroup } from './route-group';

// Identity and agencies (design: "Management_API"): `/me`, `/agencies[/{agencyId}]`, members,
// `/platform-admins`, machine accesses. Authorization, invariants ("last admin", "exactly one
// assignment") and audit live in the core use cases; the routes only validate input, pick the
// actor's channel and map results. Destructive operations — suspending an agency, removing a
// member, revoking the Plattform_Admin role, revoking a machine access — accept `?dryRun=true`
// and then report the affected listings/users without changing anything (Req 10.8).

export { IDENTITY_ENV } from './identity/services';
export type { IdentityServices, IdentityServiceOptions } from './identity/services';

const AgencyParams = z.object({ agencyId: EntityId });
const MemberParams = z.object({ agencyId: EntityId, userId: EntityId });
const PlatformAdminParams = z.object({ userId: EntityId });
const MachineAccessParams = z.object({ agencyId: EntityId, keyId: EntityId });
const AgencyListQuery = PageQuery.extend({ state: AgencyStateSchema.optional() });

const actorOf = (principal: Principal): AgencyActor => ({
  principal,
  channel: principalChannel(principal),
});

/** Req 5.6: identity and effective permissions, so the portal shows only allowed controls. */
export function meResponse(principal: Principal): MeResponse {
  const permissions = [...principalPermissions(principal)];
  if (principal.kind === 'machine') {
    return {
      kind: 'machine',
      id: principal.keyId,
      displayName: principal.label,
      agencyId: principal.agencyId,
      permissions,
    };
  }
  return {
    kind: 'user',
    id: principal.userId,
    displayName: principal.displayName,
    role: principal.role,
    ...('agencyId' in principal && { agencyId: principal.agencyId }),
    permissions,
  };
}

/** Preview → 200 with the counts; executed change → 200 with the changed resource. */
function fromDryRun<T>(result: Result<DryRunOr<T>, ApiError[]>): Reply {
  if (!result.ok) return failure(result.error);
  const outcome = result.value;
  return outcome.dryRun ? success(200, outcome) : success(200, outcome.value);
}

/**
 * Revocation preview (Req 10.8): same authorization and 404 semantics as the revocation, nothing
 * is written. A machine access is neither a user nor owns listings, so both counts are 0.
 */
async function previewRevoke(
  services: IdentityServices,
  principal: Principal,
  agencyId: string,
  keyId: string,
): Promise<Reply> {
  const decision = authorize(principal, 'machine-access:manage', agencyId);
  if (decision === 'FORBIDDEN') {
    return failure({ code: 'FORBIDDEN', message: 'Missing permission machine-access:manage' });
  }
  const current = decision === 'ALLOW' ? await services.machineAccessStore.get(keyId) : null;
  if (current === null || current.agencyId !== agencyId) {
    return failure({ code: 'NOT_FOUND', message: 'Resource not found' });
  }
  const preview: DryRunResponse = { dryRun: true, affectedListings: 0, affectedUsers: 0 };
  return success(200, preview);
}

/** Routes of the group on the given use cases. */
export function createIdentityRouteList(services: IdentityServices): Route[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/me',
      handle: async ({ principal }) => success(200, meResponse(principal)),
    }),

    // Agencies (Req 1.1, 1.4, 1.8, 1.9, 10.3)
    defineRoute({
      method: 'GET',
      path: '/agencies',
      query: AgencyListQuery,
      handle: ({ principal, query, signal }) =>
        withPageToken(async () => {
          const result = await services.overview.list(
            principal,
            {
              ...(query.state !== undefined && { state: query.state }),
              page: toKeyPageRequest(query),
            },
            signal,
          );
          return result.ok ? success(200, toApiPage(result.value)) : failure(result.error);
        }),
    }),
    defineRoute({
      method: 'POST',
      path: '/agencies',
      body: CreateAgencyRequest,
      handle: async ({ principal, body }) =>
        fromResult(201, await services.agencies.create(actorOf(principal), body)),
    }),
    defineRoute({
      method: 'GET',
      path: '/agencies/{agencyId}',
      params: AgencyParams,
      handle: async ({ principal, params }) =>
        fromResult(200, await services.agencies.get(actorOf(principal), params.agencyId)),
    }),
    defineRoute({
      method: 'PATCH',
      path: '/agencies/{agencyId}',
      params: AgencyParams,
      query: DryRunQuery,
      body: UpdateAgencyRequest,
      handle: async ({ principal, params, query, body }) =>
        fromDryRun(
          await services.agencies.update(actorOf(principal), params.agencyId, body, {
            dryRun: query.dryRun,
          }),
        ),
    }),

    // Members (Req 1.2, 1.5–1.7)
    defineRoute({
      method: 'GET',
      path: '/agencies/{agencyId}/members',
      params: AgencyParams,
      query: PageQuery,
      handle: ({ principal, params, query }) =>
        withPageToken(async () => {
          const result = await services.memberships.listMembers(
            actorOf(principal),
            params.agencyId,
            toKeyPageRequest(query),
          );
          return result.ok ? success(200, toApiPage(result.value)) : failure(result.error);
        }),
    }),
    defineRoute({
      method: 'POST',
      path: '/agencies/{agencyId}/members',
      params: AgencyParams,
      body: AddMemberRequest,
      handle: async ({ principal, params, body }) =>
        fromResult(
          201,
          await services.memberships.addMember(actorOf(principal), params.agencyId, body),
        ),
    }),
    defineRoute({
      method: 'PATCH',
      path: '/agencies/{agencyId}/members/{userId}',
      params: MemberParams,
      body: UpdateMemberRequest,
      handle: async ({ principal, params, body }) =>
        fromResult(
          200,
          await services.memberships.changeRole(
            actorOf(principal),
            params.agencyId,
            params.userId,
            body,
          ),
        ),
    }),
    defineRoute({
      method: 'DELETE',
      path: '/agencies/{agencyId}/members/{userId}',
      params: MemberParams,
      query: DryRunQuery,
      handle: async ({ principal, params, query }) =>
        fromDryRun(
          await services.memberships.removeMember(
            actorOf(principal),
            params.agencyId,
            params.userId,
            { dryRun: query.dryRun },
          ),
        ),
    }),

    // Plattform_Admins (Req 1.2, 10.8, 10.9)
    defineRoute({
      method: 'GET',
      path: '/platform-admins',
      query: PageQuery,
      handle: ({ principal, query }) =>
        withPageToken(async () => {
          const result = await services.memberships.listPlatformAdmins(
            actorOf(principal),
            toKeyPageRequest(query),
          );
          return result.ok ? success(200, toApiPage(result.value)) : failure(result.error);
        }),
    }),
    defineRoute({
      method: 'POST',
      path: '/platform-admins',
      body: AddPlatformAdminRequest,
      handle: async ({ principal, body }) =>
        fromResult(201, await services.memberships.addPlatformAdmin(actorOf(principal), body)),
    }),
    defineRoute({
      method: 'DELETE',
      path: '/platform-admins/{userId}',
      params: PlatformAdminParams,
      query: DryRunQuery,
      handle: async ({ principal, params, query }) =>
        fromDryRun(
          await services.memberships.removePlatformAdmin(actorOf(principal), params.userId, {
            dryRun: query.dryRun,
          }),
        ),
    }),

    // Machine accesses (Req 3.1, 3.3, 3.5, 3.7)
    defineRoute({
      method: 'GET',
      path: '/agencies/{agencyId}/machine-access',
      params: AgencyParams,
      query: PageQuery,
      handle: ({ principal, params, query }) =>
        withPageToken(async () => {
          const result = await services.machineAccess.list(
            actorOf(principal),
            params.agencyId,
            toKeyPageRequest(query),
          );
          return result.ok ? success(200, toApiPage(result.value)) : failure(result.error);
        }),
    }),
    defineRoute({
      method: 'POST',
      path: '/agencies/{agencyId}/machine-access',
      params: AgencyParams,
      body: CreateMachineAccessRequest,
      handle: async ({ principal, params, body }) =>
        fromResult(
          201,
          await services.machineAccess.create(actorOf(principal), params.agencyId, body),
        ),
    }),
    defineRoute({
      method: 'DELETE',
      path: '/agencies/{agencyId}/machine-access/{keyId}',
      params: MachineAccessParams,
      query: DryRunQuery,
      handle: async ({ principal, params, query }) =>
        query.dryRun
          ? previewRevoke(services, principal, params.agencyId, params.keyId)
          : fromResult(
              200,
              await services.machineAccess.revoke(
                actorOf(principal),
                params.agencyId,
                params.keyId,
              ),
            ),
    }),
  ];
}

/** Route group; `options` lets tests replace the Identity_Provider. */
export function createIdentityRoutes(options: IdentityServiceOptions = {}): RouteGroup {
  return {
    name: 'identity',
    create: (context) => createIdentityRouteList(createIdentityServices(context, options)),
  };
}

export const identityRoutes: RouteGroup = createIdentityRoutes();
