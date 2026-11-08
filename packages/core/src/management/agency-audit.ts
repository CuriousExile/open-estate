import {
  err,
  type ActorRef,
  type ApiError,
  type Channel,
  type Decision,
  type DryRunResponse,
  type FlagAuditDetails,
  type Principal,
  type Result,
} from '@open-estate/shared';
import type { AuditService } from './audit-service';

// Audit trail and shared helpers of AgencyService and MembershipService (Req 2.8, 11.1). Entries
// hold identifiers and codes only, never e-mail addresses (Req 9.4).

export type AgencyAuditAction =
  | 'agency.get'
  | 'agency.create'
  | 'agency.update'
  | 'agency.suspend'
  | 'agency.reactivate'
  | 'member.list'
  | 'member.add'
  | 'member.role'
  | 'member.remove'
  | 'platform-admin.list'
  | 'platform-admin.add'
  | 'platform-admin.remove';

/**
 * Audit sink: the `AuditService`. One entry per rejected call (reads included, Req 2.8; category
 * `access-denied` for 403) and per executed or failed write (Req 11.1). Not audited: successful
 * reads and `dryRun` previews (unless denied by `authorize`).
 */
export type AgencyAudit = Pick<AuditService, 'append'>;

/** Caller of a use case: authenticated principal and the channel it came through. */
export interface AgencyActor {
  principal: Principal;
  channel: Channel;
}

/** `?dryRun=true` (Req 10.8): count affected listings/users, change nothing. */
export interface DryRunOption {
  dryRun?: boolean;
}

/** Outcome of a destructive operation: the preview counts, or the executed change. */
export type DryRunOr<T> = DryRunResponse | { dryRun: false; value: T };

export const agencyTarget = (agencyId: string) => `agency/${agencyId}`;
export const memberTarget = (userId: string) => `member/${userId}`;
export const platformAdminTarget = (userId: string) => `platform-admin/${userId}`;

export function actorRef(principal: Principal): ActorRef {
  return principal.kind === 'user'
    ? { kind: 'user', userId: principal.userId, displayName: principal.displayName }
    : { kind: 'machine', keyId: principal.keyId, label: principal.label };
}

export const apiError = (code: ApiError['code'], message: string): ApiError => ({ code, message });

export const notFound = (): ApiError => apiError('NOT_FOUND', 'Resource not found');

export function decisionError(decision: Decision, permission: string): ApiError | null {
  switch (decision) {
    case 'ALLOW':
      return null;
    case 'FORBIDDEN':
      return apiError('FORBIDDEN', `Missing permission ${permission}`);
    case 'NOT_FOUND':
      return notFound();
  }
}

/** Writes the audit entries of one service; `A` = the service's audit actions. */
export class AgencyAuditTrail<A extends string = AgencyAuditAction> {
  private readonly audit: AgencyAudit;

  constructor(audit: AgencyAudit) {
    this.audit = audit;
  }

  success(actor: AgencyActor, action: A, target: string, agencyId?: string): Promise<void> {
    return this.append(actor, action, target, agencyId, 'SUCCESS');
  }

  /** Audits a call that succeeded with another outcome code than `SUCCESS` (e.g. `UNCHANGED`). */
  outcome(
    actor: AgencyActor,
    action: A,
    target: string,
    agencyId: string | undefined,
    result: string,
  ): Promise<void> {
    return this.append(actor, action, target, agencyId, result);
  }

  /**
   * Audits a change of a Markierung (duplicate-detection Req 7.7) with its codes; `details` holds
   * codes and listing ids only.
   */
  flagChange(
    actor: AgencyActor,
    action: A,
    target: string,
    agencyId: string | undefined,
    details: FlagAuditDetails,
  ): Promise<void> {
    return this.append(actor, action, target, agencyId, 'SUCCESS', details);
  }

  /** Audits the first error code and returns the errors as failed result. */
  async reject<T>(
    actor: AgencyActor,
    action: A,
    target: string,
    agencyId: string | undefined,
    error: ApiError,
  ): Promise<Result<T, ApiError[]>> {
    await this.append(actor, action, target, agencyId, error.code);
    return err([error]);
  }

  private async append(
    { principal, channel }: AgencyActor,
    action: A,
    target: string,
    agencyId: string | undefined,
    result: string,
    details?: FlagAuditDetails,
  ): Promise<void> {
    await this.audit.append({
      category: result === 'FORBIDDEN' ? 'access-denied' : 'management',
      actor: actorRef(principal),
      channel,
      action,
      target,
      ...(agencyId !== undefined && { agencyId }),
      result,
      ...(details !== undefined && { details }),
    });
  }
}

/** Number of items over all pages of a key-paged listing. */
export async function countPages(
  fetch: (cursor: string | undefined) => Promise<{ items: unknown[]; nextCursor?: string }>,
): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await fetch(cursor);
    total += page.items.length;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return total;
}
