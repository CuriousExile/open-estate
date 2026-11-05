import {
  authorize,
  err,
  ok,
  ungrantableMachinePermissions,
  type ActorRef,
  type ApiError,
  type Channel,
  type CreatedMachineAccess,
  type CreateMachineAccessRequest,
  type MachineAccessView,
  type Principal,
  type Result,
} from '@open-estate/shared';
import { randomBytes } from 'node:crypto';
import type { Clock } from '../access/ttl-cache';
import type { AgencyStore } from './agency-store';
import { hashMachineSecret, MACHINE_CREDENTIAL_PREFIX } from './authenticator';
import type { KeyPage, KeyPageRequest } from './key-page';
import type { MachineAccessRecord, MachineAccessStore } from './machine-access-store';

// Use cases of `/agencies/{agencyId}/machine-access` (design: "Management_API", Req 3.1–3.3, 3.5,
// 3.7). The secret leaves the service exactly once, in the creation response; only its hash is
// stored, and neither views nor audit entries contain it.

/** Audit entry written per use-case outcome; identifiers and codes only (Req 11.1). */
export interface MachineAccessAuditEntry {
  actor: ActorRef;
  channel: Channel;
  action: 'machine-access.create' | 'machine-access.revoke' | 'machine-access.list';
  target: string;
  agencyId: string;
  /** `SUCCESS` or the first error code. */
  result: string;
}

/** Random bytes of a machine-access secret (Req 3.1). */
export const MACHINE_SECRET_BYTES = 32;

/** Key id and secret of a new machine access; the credential is `oem_<keyId>_<secret>`. */
export interface MachineToken {
  /** Must not contain `_`: the Authenticator splits at the first `_` after the prefix. */
  keyId: string;
  secret: string;
}

/** 128-bit hex key id and 32 random bytes as base64url secret. */
export function generateMachineToken(): MachineToken {
  return {
    keyId: randomBytes(16).toString('hex'),
    secret: randomBytes(MACHINE_SECRET_BYTES).toString('base64url'),
  };
}

/** `oem_<keyId>_<secret>`, the format parsed by the Authenticator. */
export function formatMachineCredential({ keyId, secret }: MachineToken): string {
  if (keyId.length === 0 || keyId.includes('_') || secret.length === 0) {
    throw new Error('Invalid machine-access key id or secret');
  }
  return `${MACHINE_CREDENTIAL_PREFIX}${keyId}_${secret}`;
}

/** Minimal sink, implemented by the `AuditService`. */
export interface MachineAccessAudit {
  append(entry: MachineAccessAuditEntry): Promise<void>;
}

/** Caller of a use case: authenticated principal and the channel it came through. */
export interface MachineAccessActor {
  principal: Principal;
  channel: Channel;
}

export interface MachineAccessServiceDeps {
  store: MachineAccessStore;
  agencies: Pick<AgencyStore<unknown>, 'get'>;
  audit: MachineAccessAudit;
  clock: Clock;
  /** Injectable for tests; defaults to 128-bit key id and 32-byte random secret. */
  generateToken?: () => MachineToken;
}

export type MachineAccessResult<T> = Result<T, ApiError[]>;

const MANAGE = 'machine-access:manage';

export class MachineAccessService {
  private readonly deps: MachineAccessServiceDeps;
  private readonly generateToken: () => MachineToken;

  constructor(deps: MachineAccessServiceDeps) {
    this.deps = deps;
    this.generateToken = deps.generateToken ?? generateMachineToken;
  }

  /** Req 3.1–3.3: creates the access and returns `secret` = `oem_<keyId>_<secret>` once. */
  async create(
    actor: MachineAccessActor,
    agencyId: string,
    request: CreateMachineAccessRequest,
  ): Promise<MachineAccessResult<CreatedMachineAccess>> {
    const denied = await this.checkAgency(actor.principal, agencyId);
    if (denied !== null) {
      return this.reject(actor, 'machine-access.create', agencyTarget(agencyId), agencyId, [
        denied,
      ]);
    }
    const ungrantable = ungrantableMachinePermissions(request.permissions);
    if (ungrantable.length > 0) {
      const errors = ungrantable.map((permission): ApiError => ({
        code: 'INVALID_PERMISSION',
        message: `Permission "${permission}" cannot be granted to a machine access`,
        field: 'permissions',
        details: { permission },
      }));
      return this.reject(actor, 'machine-access.create', agencyTarget(agencyId), agencyId, errors);
    }

    const token = this.generateToken();
    const record: MachineAccessRecord = {
      keyId: token.keyId,
      agencyId,
      label: request.label,
      keyHash: hashMachineSecret(token.secret),
      permissions: [...request.permissions],
      createdBy: actorId(actor.principal),
      createdAt: new Date(this.deps.clock()).toISOString(),
      ...(request.expiresAt !== undefined && { expiresAt: request.expiresAt }),
    };
    await this.deps.store.create(record);
    await this.audit(actor, 'machine-access.create', accessTarget(record.keyId), agencyId);
    return ok({ ...toMachineAccessView(record), secret: formatMachineCredential(token) });
  }

  /** Req 3.5: sets `revokedAt` (idempotent); unknown or foreign accesses → `NOT_FOUND`. */
  async revoke(
    actor: MachineAccessActor,
    agencyId: string,
    keyId: string,
  ): Promise<MachineAccessResult<MachineAccessView>> {
    const target = accessTarget(keyId);
    const current = await this.deps.store.get(keyId);
    const denied =
      current === null || current.agencyId !== agencyId
        ? (decisionError(authorize(actor.principal, MANAGE, agencyId)) ?? notFound())
        : decisionError(authorize(actor.principal, MANAGE, current.agencyId));
    if (denied !== null) {
      return this.reject(actor, 'machine-access.revoke', target, agencyId, [denied]);
    }
    const revoked = await this.deps.store.revoke(keyId, new Date(this.deps.clock()).toISOString());
    if (revoked === null) {
      return this.reject(actor, 'machine-access.revoke', target, agencyId, [notFound()]);
    }
    await this.audit(actor, 'machine-access.revoke', target, agencyId);
    return ok(toMachineAccessView(revoked));
  }

  /** Req 3.7: the agency's accesses (revoked ones included), without secret or hash. */
  async list(
    actor: MachineAccessActor,
    agencyId: string,
    page: KeyPageRequest,
  ): Promise<MachineAccessResult<KeyPage<MachineAccessView>>> {
    const denied = await this.checkAgency(actor.principal, agencyId);
    if (denied !== null) {
      return this.reject(actor, 'machine-access.list', agencyTarget(agencyId), agencyId, [denied]);
    }
    const result = await this.deps.store.listByAgency(agencyId, page);
    return ok({ ...result, items: result.items.map(toMachineAccessView) });
  }

  /** `authorize`, then (for Plattform_Admins) the agency must exist. */
  private async checkAgency(principal: Principal, agencyId: string): Promise<ApiError | null> {
    const denied = decisionError(authorize(principal, MANAGE, agencyId));
    if (denied !== null) return denied;
    return (await this.deps.agencies.get(agencyId)) === null ? notFound() : null;
  }

  private async reject<T>(
    actor: MachineAccessActor,
    action: MachineAccessAuditEntry['action'],
    target: string,
    agencyId: string,
    errors: ApiError[],
  ): Promise<MachineAccessResult<T>> {
    await this.audit(actor, action, target, agencyId, errors[0]?.code ?? 'ERROR');
    return err(errors);
  }

  private audit(
    { principal, channel }: MachineAccessActor,
    action: MachineAccessAuditEntry['action'],
    target: string,
    agencyId: string,
    result = 'SUCCESS',
  ): Promise<void> {
    return this.deps.audit.append({
      actor: actorRef(principal),
      channel,
      action,
      target,
      agencyId,
      result,
    });
  }
}

/** Stored record → API view: drops `keyHash` (Req 3.7). */
export function toMachineAccessView(record: MachineAccessRecord): MachineAccessView {
  return {
    keyId: record.keyId,
    agencyId: record.agencyId,
    label: record.label,
    permissions: [...record.permissions],
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    ...(record.expiresAt !== undefined && { expiresAt: record.expiresAt }),
    ...(record.revokedAt !== undefined && { revokedAt: record.revokedAt }),
    ...(record.lastUsedAt !== undefined && { lastUsedAt: record.lastUsedAt }),
  };
}

const agencyTarget = (agencyId: string) => `agency/${agencyId}`;
const accessTarget = (keyId: string) => `machine-access/${keyId}`;

const actorId = (principal: Principal) =>
  principal.kind === 'user' ? principal.userId : principal.keyId;

function actorRef(principal: Principal): ActorRef {
  return principal.kind === 'user'
    ? { kind: 'user', userId: principal.userId, displayName: principal.displayName }
    : { kind: 'machine', keyId: principal.keyId, label: principal.label };
}

const notFound = (): ApiError => ({ code: 'NOT_FOUND', message: 'Resource not found' });

function decisionError(decision: ReturnType<typeof authorize>): ApiError | null {
  switch (decision) {
    case 'ALLOW':
      return null;
    case 'FORBIDDEN':
      return { code: 'FORBIDDEN', message: 'Missing permission machine-access:manage' };
    case 'NOT_FOUND':
      return notFound();
  }
}
