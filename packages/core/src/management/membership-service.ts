import {
  authorize,
  err,
  ok,
  type AddMemberRequest,
  type AddPlatformAdminRequest,
  type AgencyRole,
  type ApiError,
  type MemberView,
  type Result,
  type UpdateMemberRequest,
} from '@open-estate/shared';
import type { Clock } from '../access/ttl-cache';
import {
  AgencyAuditTrail,
  agencyTarget,
  apiError,
  decisionError,
  memberTarget,
  notFound,
  platformAdminTarget,
  type AgencyActor,
  type AgencyAudit,
  type AgencyAuditAction,
  type DryRunOption,
  type DryRunOr,
} from './agency-audit';
import type { AgencyStore } from './agency-store';
import type { DirectoryUser, IdentityDirectory } from './identity-directory';
import type { KeyPage, KeyPageRequest } from './key-page';
import type { MembershipRecord, MembershipStore } from './membership-store';
import type { PlatformCounterStore } from './platform-counter-store';
import type { TransactionConflict, Transactor } from './transaction';

// Use cases of `/agencies/{agencyId}/members[/{userId}]` and `/platform-admins[/{userId}]`
// (design: "Management_API", "Data Models"; Req 1.2, 1.5–1.7, 10.8, 10.9). Every membership
// write changes the admin counter (`Agencies.agencyAdmins` / `PlatformCounters.platformAdmins`)
// in the same transaction; the store conditions enforce "exactly one assignment" and "at least
// one admin", so concurrent calls cannot break the invariants. The Authenticator caches
// memberships for at most 60 s (Req 1.6).

export interface MembershipServiceDeps<Op> {
  memberships: MembershipStore<Op>;
  agencies: AgencyStore<Op>;
  platformCounters: PlatformCounterStore<Op>;
  identity: IdentityDirectory;
  transactor: Transactor<Op>;
  audit: AgencyAudit;
  clock: Clock;
}

export type MembershipResult<T> = Result<T, ApiError[]>;

const MEMBER_MANAGE = 'member:manage';
const AGENCY_MANAGE = 'agency:manage';
/** A membership condition fails only on a concurrent change of the same user; re-plan then. */
const MAX_ATTEMPTS = 3;

const lastAgencyAdmin = () =>
  apiError('LAST_AGENCY_ADMIN', 'The agency must keep at least one AGENCY_ADMIN');
const lastPlatformAdmin = () =>
  apiError('LAST_PLATFORM_ADMIN', 'The platform must keep at least one PLATFORM_ADMIN');
const alreadyAssigned = () =>
  apiError('USER_ALREADY_ASSIGNED', 'The user already belongs to an agency or is PLATFORM_ADMIN');

/** One planned attempt: a result, or `retry` after a concurrent change of the membership. */
type Attempt<T> = { done: MembershipResult<T> } | 'retry';

export class MembershipService<Op> {
  private readonly deps: MembershipServiceDeps<Op>;
  private readonly trail: AgencyAuditTrail;

  constructor(deps: MembershipServiceDeps<Op>) {
    this.deps = deps;
    this.trail = new AgencyAuditTrail(deps.audit);
  }

  /** Members of an agency, ordered by user id. */
  async listMembers(
    actor: AgencyActor,
    agencyId: string,
    page: KeyPageRequest,
  ): Promise<MembershipResult<KeyPage<MemberView>>> {
    const denied = await this.checkAgency(actor, agencyId);
    if (denied !== null) {
      return this.trail.reject(actor, 'member.list', agencyTarget(agencyId), agencyId, denied);
    }
    const result = await this.deps.memberships.listByAgency(agencyId, page);
    return ok({ ...result, items: result.items.map(toMemberView) });
  }

  /**
   * Req 1.2, 1.5: grants `role` in the agency; an unknown e-mail address gets an account with
   * invitation. The first member of an agency must be an `AGENCY_ADMIN`, so every agency with
   * members has an admin (Property 6). This pre-check is race-free: the admin counter never
   * drops from 1 to 0.
   */
  async addMember(
    actor: AgencyActor,
    agencyId: string,
    request: AddMemberRequest,
  ): Promise<MembershipResult<MemberView>> {
    const target = agencyTarget(agencyId);
    const denied = decisionError(
      authorize(actor.principal, MEMBER_MANAGE, agencyId),
      MEMBER_MANAGE,
    );
    const agency = denied === null ? await this.deps.agencies.get(agencyId) : null;
    if (agency === null) {
      return this.trail.reject(actor, 'member.add', target, agencyId, denied ?? notFound());
    }
    if (request.role === 'AGENCY_MEMBER' && agency.agencyAdmins === 0) {
      return this.trail.reject(actor, 'member.add', target, agencyId, lastAgencyAdmin());
    }
    const user = await this.resolveUser(request.email);
    if (user === null) {
      return this.trail.reject(actor, 'member.add', target, agencyId, alreadyAssigned());
    }
    const record = this.newRecord(user, { role: request.role, agencyId });
    const conflict = await this.transact([
      this.deps.memberships.createOp(record),
      request.role === 'AGENCY_ADMIN'
        ? this.deps.agencies.adjustAdminsOp(agencyId, 1)
        : this.deps.agencies.existsOp(agencyId),
    ]);
    const userTarget = memberTarget(user.userId);
    if (conflict !== null) {
      const error = conflict.failed.includes('membership.create') ? alreadyAssigned() : notFound();
      return this.trail.reject(actor, 'member.add', userTarget, agencyId, error);
    }
    await this.trail.success(actor, 'member.add', userTarget, agencyId);
    return ok(toMemberView(record));
  }

  /** Req 1.6, 1.7: demoting the last `AGENCY_ADMIN` → 409 `LAST_AGENCY_ADMIN`. */
  async changeRole(
    actor: AgencyActor,
    agencyId: string,
    userId: string,
    request: UpdateMemberRequest,
  ): Promise<MembershipResult<MemberView>> {
    const target = memberTarget(userId);
    const denied = decisionError(
      authorize(actor.principal, MEMBER_MANAGE, agencyId),
      MEMBER_MANAGE,
    );
    if (denied !== null) return this.trail.reject(actor, 'member.role', target, agencyId, denied);

    return this.withRetry(target, async () => {
      const current = await this.agencyMember(userId, agencyId);
      if (current === null) return this.reject(actor, 'member.role', target, agencyId, notFound());
      const from = current.role;
      const to = request.role;
      if (from === to) return this.succeed(actor, 'member.role', target, agencyId, current);
      const conflict = await this.transact([
        this.deps.memberships.changeRoleOp(userId, agencyId, from, to),
        this.deps.agencies.adjustAdminsOp(agencyId, to === 'AGENCY_ADMIN' ? 1 : -1),
      ]);
      if (conflict === null) {
        return this.succeed(actor, 'member.role', target, agencyId, { ...current, role: to });
      }
      if (conflict.failed.includes('membership.role')) return 'retry';
      const error = to === 'AGENCY_ADMIN' ? notFound() : lastAgencyAdmin();
      return this.reject(actor, 'member.role', target, agencyId, error);
    });
  }

  /**
   * Req 1.6, 1.7: removes the user from the agency (the Cognito account stays). `dryRun` reports
   * one affected user, or the 409 the removal would fail with (Req 10.8).
   */
  async removeMember(
    actor: AgencyActor,
    agencyId: string,
    userId: string,
    { dryRun = false }: DryRunOption = {},
  ): Promise<MembershipResult<DryRunOr<MemberView>>> {
    const target = memberTarget(userId);
    const denied = decisionError(
      authorize(actor.principal, MEMBER_MANAGE, agencyId),
      MEMBER_MANAGE,
    );
    if (denied !== null) return this.trail.reject(actor, 'member.remove', target, agencyId, denied);

    return this.withRetry(target, async () => {
      const current = await this.agencyMember(userId, agencyId);
      if (current === null) {
        return this.reject(actor, 'member.remove', target, agencyId, notFound(), dryRun);
      }
      const isAdmin = current.role === 'AGENCY_ADMIN';
      if (dryRun) {
        const lastAdmin =
          isAdmin && ((await this.deps.agencies.get(agencyId))?.agencyAdmins ?? 0) <= 1;
        return {
          done: lastAdmin ? err([lastAgencyAdmin()]) : ok({ dryRun: true, affectedUsers: 1 }),
        };
      }
      const conflict = await this.transact([
        this.deps.memberships.deleteOp(userId, { role: current.role, agencyId }),
        ...(isAdmin ? [this.deps.agencies.adjustAdminsOp(agencyId, -1)] : []),
      ]);
      if (conflict === null) {
        await this.trail.success(actor, 'member.remove', target, agencyId);
        return { done: ok({ dryRun: false, value: toMemberView(current) }) };
      }
      if (conflict.failed.includes('membership.delete')) return 'retry';
      return this.reject(actor, 'member.remove', target, agencyId, lastAgencyAdmin());
    });
  }

  /** Plattform_Admins (Req 1.2). */
  async listPlatformAdmins(
    actor: AgencyActor,
    page: KeyPageRequest,
  ): Promise<MembershipResult<KeyPage<MemberView>>> {
    const denied = decisionError(
      authorize(actor.principal, AGENCY_MANAGE, undefined),
      AGENCY_MANAGE,
    );
    if (denied !== null) {
      return this.trail.reject(actor, 'platform-admin.list', 'platform-admin', undefined, denied);
    }
    const result = await this.deps.memberships.listPlatformAdmins(page);
    return ok({ ...result, items: result.items.map(toMemberView) });
  }

  /** Req 1.2: Plattform_Admin without agency; users of an agency are rejected. */
  async addPlatformAdmin(
    actor: AgencyActor,
    request: AddPlatformAdminRequest,
  ): Promise<MembershipResult<MemberView>> {
    const denied = decisionError(
      authorize(actor.principal, AGENCY_MANAGE, undefined),
      AGENCY_MANAGE,
    );
    if (denied !== null) {
      return this.trail.reject(actor, 'platform-admin.add', 'platform-admin', undefined, denied);
    }
    const user = await this.resolveUser(request.email);
    if (user === null) {
      return this.trail.reject(
        actor,
        'platform-admin.add',
        'platform-admin',
        undefined,
        alreadyAssigned(),
      );
    }
    const record = this.newRecord(user, { role: 'PLATFORM_ADMIN' });
    const target = platformAdminTarget(user.userId);
    const conflict = await this.transact([
      this.deps.memberships.createOp(record),
      this.deps.platformCounters.adjustPlatformAdminsOp(1),
    ]);
    if (conflict !== null) {
      return this.trail.reject(actor, 'platform-admin.add', target, undefined, alreadyAssigned());
    }
    await this.trail.success(actor, 'platform-admin.add', target);
    return ok(toMemberView(record));
  }

  /** Req 10.8, 10.9: revoking the last Plattform_Admin → 409 `LAST_PLATFORM_ADMIN`. */
  async removePlatformAdmin(
    actor: AgencyActor,
    userId: string,
    { dryRun = false }: DryRunOption = {},
  ): Promise<MembershipResult<DryRunOr<MemberView>>> {
    const target = platformAdminTarget(userId);
    const denied = decisionError(
      authorize(actor.principal, AGENCY_MANAGE, undefined),
      AGENCY_MANAGE,
    );
    if (denied !== null) {
      return this.trail.reject(actor, 'platform-admin.remove', target, undefined, denied);
    }

    return this.withRetry(target, async () => {
      const current = await this.deps.memberships.get(userId);
      if (current === null || current.role !== 'PLATFORM_ADMIN') {
        return this.reject(actor, 'platform-admin.remove', target, undefined, notFound(), dryRun);
      }
      if (dryRun) {
        const admins = await this.deps.platformCounters.platformAdmins();
        // Membership and counter are two reads. Re-read the membership: if it is unchanged, both
        // values held when the counter was read; if a concurrent removal took it, retry (→ 404).
        // Without this a dry run racing a real removal could answer LAST_PLATFORM_ADMIN for an
        // admin that is already gone (fast-check seed 713905340).
        const again = await this.deps.memberships.get(userId);
        if (again === null || again.role !== 'PLATFORM_ADMIN') return 'retry';
        const lastAdmin = admins <= 1;
        return {
          done: lastAdmin ? err([lastPlatformAdmin()]) : ok({ dryRun: true, affectedUsers: 1 }),
        };
      }
      const conflict = await this.transact([
        this.deps.memberships.deleteOp(userId, { role: 'PLATFORM_ADMIN' }),
        this.deps.platformCounters.adjustPlatformAdminsOp(-1),
      ]);
      if (conflict === null) {
        await this.trail.success(actor, 'platform-admin.remove', target);
        return { done: ok({ dryRun: false, value: toMemberView(current) }) };
      }
      if (conflict.failed.includes('membership.delete')) return 'retry';
      return this.reject(actor, 'platform-admin.remove', target, undefined, lastPlatformAdmin());
    });
  }

  /** `authorize`, then (for Plattform_Admins) the agency must exist. */
  private async checkAgency(actor: AgencyActor, agencyId: string): Promise<ApiError | null> {
    const denied = decisionError(
      authorize(actor.principal, MEMBER_MANAGE, agencyId),
      MEMBER_MANAGE,
    );
    if (denied !== null) return denied;
    return (await this.deps.agencies.get(agencyId)) === null ? notFound() : null;
  }

  /** Membership of `userId` with an agency role in `agencyId`, else `null` (→ 404). */
  private async agencyMember(
    userId: string,
    agencyId: string,
  ): Promise<(MembershipRecord & { role: AgencyRole }) | null> {
    const current = await this.deps.memberships.get(userId);
    if (current === null || current.agencyId !== agencyId || current.role === 'PLATFORM_ADMIN') {
      return null;
    }
    return { ...current, role: current.role };
  }

  /**
   * Directory user for the address, invited if unknown; `null` if the user already has a
   * membership (checked before inviting; the transaction condition covers races).
   */
  private async resolveUser(email: string): Promise<DirectoryUser | null> {
    const known = await this.deps.identity.findByEmail(email);
    if (known !== null && (await this.deps.memberships.get(known.userId)) !== null) return null;
    return known ?? this.deps.identity.invite(email);
  }

  private newRecord(
    user: DirectoryUser,
    assignment: { role: AgencyRole; agencyId: string } | { role: 'PLATFORM_ADMIN' },
  ): MembershipRecord {
    return {
      userId: user.userId,
      email: user.email,
      displayName: user.displayName,
      ...assignment,
      createdAt: new Date(this.deps.clock()).toISOString(),
    };
  }

  private async transact(ops: Op[]): Promise<TransactionConflict | null> {
    const result = await this.deps.transactor.transact(ops);
    return result.ok ? null : result.error;
  }

  /** Re-plans after a concurrent change of the same membership; throws after the last attempt. */
  private async withRetry<T>(
    target: string,
    attempt: () => Promise<Attempt<T>>,
  ): Promise<MembershipResult<T>> {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const outcome = await attempt();
      if (outcome !== 'retry') return outcome.done;
    }
    throw new Error(`Membership ${target} changed concurrently ${MAX_ATTEMPTS} times`);
  }

  private async succeed(
    actor: AgencyActor,
    action: AgencyAuditAction,
    target: string,
    agencyId: string,
    record: MembershipRecord,
  ): Promise<Attempt<MemberView>> {
    await this.trail.success(actor, action, target, agencyId);
    return { done: ok(toMemberView(record)) };
  }

  /** Failed attempt; `dryRun` previews are not audited. */
  private async reject<T>(
    actor: AgencyActor,
    action: AgencyAuditAction,
    target: string,
    agencyId: string | undefined,
    error: ApiError,
    dryRun = false,
  ): Promise<Attempt<T>> {
    if (dryRun) return { done: err([error]) };
    return { done: await this.trail.reject<T>(actor, action, target, agencyId, error) };
  }
}

/** Stored record → API view. */
export function toMemberView(record: MembershipRecord): MemberView {
  return {
    userId: record.userId,
    email: record.email,
    displayName: record.displayName,
    role: record.role,
    ...(record.agencyId !== undefined && { agencyId: record.agencyId }),
    createdAt: record.createdAt,
  };
}
