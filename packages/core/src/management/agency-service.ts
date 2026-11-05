import { randomUUID } from 'node:crypto';
import {
  authorize,
  err,
  LISTING_STATUSES,
  ok,
  type AgencyView,
  type CreateAgencyRequest,
  type Result,
  type UpdateAgencyRequest,
  type ApiError,
} from '@open-estate/shared';
import type { Clock } from '../access/ttl-cache';
import {
  AgencyAuditTrail,
  agencyTarget,
  countPages,
  decisionError,
  notFound,
  type AgencyActor,
  type AgencyAudit,
  type AgencyAuditAction,
  type DryRunOption,
  type DryRunOr,
} from './agency-audit';
import type { AgencyRecord, AgencyStore } from './agency-store';
import type { MembershipStore } from './membership-store';
import { agencyScope, type MetricCounterStore } from './metric-counter-store';
import { LISTING_COUNTER_CODES } from './versioned-listing-writer';

// Use cases of `/agencies[/{agencyId}]` (design: "Management_API", Req 1.1, 1.4, 1.8, 1.9, 10.8).
// Suspension only flips `Agencies.state`; the Authenticator (403 `AGENCY_SUSPENDED`) and the
// public visibility filter read it with a 60 s cache, stored Listing_Status stays untouched.

export interface AgencyServiceDeps {
  agencies: Pick<AgencyStore<unknown>, 'get' | 'create' | 'update'>;
  memberships: Pick<MembershipStore<unknown>, 'listByAgency'>;
  counters: Pick<MetricCounterStore<unknown>, 'get'>;
  audit: AgencyAudit;
  clock: Clock;
  /** Agency id generator; defaults to a random UUID. */
  newId?: () => string;
}

export type AgencyResult<T> = Result<T, ApiError[]>;

const MANAGE = 'agency:manage';
const COUNT_PAGE_SIZE = 100;

export class AgencyService {
  private readonly deps: AgencyServiceDeps;
  private readonly trail: AgencyAuditTrail;
  private readonly newId: () => string;

  constructor(deps: AgencyServiceDeps) {
    this.deps = deps;
    this.trail = new AgencyAuditTrail(deps.audit);
    this.newId = deps.newId ?? randomUUID;
  }

  /** Req 1.4: new agency in state `ACTIVE` without members. */
  async create(
    actor: AgencyActor,
    request: CreateAgencyRequest,
  ): Promise<AgencyResult<AgencyView>> {
    const denied = decisionError(authorize(actor.principal, MANAGE, undefined), MANAGE);
    if (denied !== null) {
      return this.trail.reject(actor, 'agency.create', 'agency', undefined, denied);
    }
    const record: AgencyRecord = {
      agencyId: this.newId(),
      displayName: request.displayName,
      state: 'ACTIVE',
      createdAt: new Date(this.deps.clock()).toISOString(),
      agencyAdmins: 0,
    };
    await this.deps.agencies.create(record);
    await this.trail.success(
      actor,
      'agency.create',
      agencyTarget(record.agencyId),
      record.agencyId,
    );
    return ok(toAgencyView(record));
  }

  /** Readable by Plattform_Admins and by every actor of the agency itself. */
  async get(actor: AgencyActor, agencyId: string): Promise<AgencyResult<AgencyView>> {
    const { principal } = actor;
    const ownAgency =
      !(principal.kind === 'user' && principal.role === 'PLATFORM_ADMIN') &&
      principal.agencyId === agencyId;
    const denied = ownAgency ? null : decisionError(authorize(principal, MANAGE, agencyId), MANAGE);
    const record = denied === null ? await this.deps.agencies.get(agencyId) : null;
    if (record === null) {
      return this.trail.reject(
        actor,
        'agency.get',
        agencyTarget(agencyId),
        agencyId,
        denied ?? notFound(),
      );
    }
    return ok(toAgencyView(record));
  }

  /**
   * Req 1.8, 1.9: rename and/or suspend/reactivate. With `dryRun`, a suspension reports the
   * agency's listings (all Listing_Status values) and members without changing anything
   * (Req 10.8); other changes report zero.
   */
  async update(
    actor: AgencyActor,
    agencyId: string,
    request: UpdateAgencyRequest,
    { dryRun = false }: DryRunOption = {},
  ): Promise<AgencyResult<DryRunOr<AgencyView>>> {
    const target = agencyTarget(agencyId);
    const denied = decisionError(authorize(actor.principal, MANAGE, agencyId), MANAGE);
    const current = denied === null ? await this.deps.agencies.get(agencyId) : null;
    if (current === null) {
      const error = denied ?? notFound();
      if (dryRun && denied === null) return err([error]);
      return this.trail.reject(actor, 'agency.update', target, agencyId, error);
    }
    const action = updateAction(current, request);
    if (dryRun) {
      return ok(
        action === 'agency.suspend'
          ? { dryRun: true, ...(await this.affected(agencyId)) }
          : { dryRun: true, affectedListings: 0, affectedUsers: 0 },
      );
    }
    const updated = await this.deps.agencies.update(agencyId, {
      ...(request.displayName !== undefined && { displayName: request.displayName }),
      ...(request.state !== undefined && { state: request.state }),
    });
    if (updated === null) return this.trail.reject(actor, action, target, agencyId, notFound());
    await this.trail.success(actor, action, target, agencyId);
    return ok({ dryRun: false, value: toAgencyView(updated) });
  }

  /** Listings from the `listing.status.*` counters, users from the memberships. */
  private async affected(agencyId: string) {
    const scope = agencyScope(agencyId);
    const counts = await Promise.all(
      LISTING_STATUSES.map((status) =>
        this.deps.counters.get(scope, LISTING_COUNTER_CODES.status(status)),
      ),
    );
    const affectedUsers = await countPages((cursor) =>
      this.deps.memberships.listByAgency(agencyId, {
        limit: COUNT_PAGE_SIZE,
        ...(cursor !== undefined && { cursor }),
      }),
    );
    return {
      affectedListings: counts.reduce((sum, count) => sum + Math.max(0, count), 0),
      affectedUsers,
    };
  }
}

function updateAction(current: AgencyRecord, request: UpdateAgencyRequest): AgencyAuditAction {
  if (request.state !== undefined && request.state !== current.state) {
    return request.state === 'SUSPENDED' ? 'agency.suspend' : 'agency.reactivate';
  }
  return 'agency.update';
}

/** Stored record → API view: drops the internal admin counter. */
export function toAgencyView(record: AgencyRecord): AgencyView {
  return {
    agencyId: record.agencyId,
    displayName: record.displayName,
    state: record.state,
    createdAt: record.createdAt,
  };
}
