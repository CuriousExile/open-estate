import { createHash, timingSafeEqual } from 'node:crypto';
import {
  err,
  ok,
  type ApiError,
  type ErrorCode,
  type Principal,
  type Result,
} from '@open-estate/shared';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import {
  FailedAssertionError,
  JwtInvalidSignatureError,
  JwtParseError,
  JwtWithoutValidKidError,
  KidNotFoundInJwksError,
  WaitPeriodNotYetEndedJwkError,
} from 'aws-jwt-verify/error';
import { ACCESS_CACHE_TTL_MS, TtlCache, systemClock, type Clock } from '../access/ttl-cache';
import type { AgencyRecord, AgencyStore } from './agency-store';
import {
  LAST_USED_WRITE_INTERVAL_MS,
  type MachineAccessRecord,
  type MachineAccessStore,
} from './machine-access-store';
import type { MembershipRecord, MembershipStore } from './membership-store';

// Design: "Authenticator und Principal" (Req 1.3, 1.6, 1.8, 2.4, 3.4–3.6). One code path for
// users (Cognito access token) and machine accesses (`oem_<keyId>_<secret>`), so every
// rejection is an `ApiError` the handler can audit (Req 2.8).

/** Prefix of a machine-access credential: `oem_<keyId>_<secret>`. */
export const MACHINE_CREDENTIAL_PREFIX = 'oem_';

/** Only `SHA-256(secret)` (hex) is stored as `keyHash` (Req 3.2). */
export function hashMachineSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Verifies a Cognito access token (signature, `exp`, issuer, `token_use`, `client_id`).
 * Returns the `sub` claim, or `null` if the token is invalid or expired. Infrastructure failures
 * (e.g. JWKS not fetchable) throw, so they surface as 5xx instead of 401.
 */
export interface AccessTokenVerifier {
  verify(token: string): Promise<string | null>;
}

export interface CognitoAccessTokenVerifierOptions {
  userPoolId: string;
  /** App client of the Agentur_Portal. */
  clientId: string;
}

/** Errors that mean "this token is not acceptable" rather than "verification is broken". */
function isInvalidTokenError(error: unknown): boolean {
  return (
    error instanceof FailedAssertionError || // claims (exp, iss, client_id, token_use, ...)
    error instanceof JwtParseError ||
    error instanceof JwtInvalidSignatureError ||
    error instanceof JwtWithoutValidKidError ||
    error instanceof KidNotFoundInJwksError ||
    error instanceof WaitPeriodNotYetEndedJwkError // unknown kid, JWKS refetch throttled
  );
}

/** {@link AccessTokenVerifier} backed by `aws-jwt-verify` (JWKS cached per instance). */
export function cognitoAccessTokenVerifier({
  userPoolId,
  clientId,
}: CognitoAccessTokenVerifierOptions): AccessTokenVerifier {
  const verifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: 'access', clientId });
  return {
    async verify(token) {
      try {
        const payload = await verifier.verify(token);
        return payload.sub;
      } catch (error) {
        if (isInvalidTokenError(error)) return null;
        throw error;
      }
    },
  };
}

export interface Authenticator {
  /** Errors: `AUTH_MISSING` | `AUTH_INVALID` | `MACHINE_ACCESS_EXPIRED` (401), `AGENCY_SUSPENDED` (403). */
  authenticate(authorization: string | undefined): Promise<Result<Principal, ApiError>>;
}

export interface AuthenticatorOptions {
  tokenVerifier: AccessTokenVerifier;
  memberships: Pick<MembershipStore<unknown>, 'get'>;
  agencies: Pick<AgencyStore<unknown>, 'get'>;
  machineAccesses: Pick<MachineAccessStore, 'get' | 'touchLastUsed'>;
  clock?: Clock;
  /** Cache TTL for memberships, agency states and machine accesses (Req 1.6, 1.8, 3.5). */
  cacheTtlMs?: number;
}

type AuthErrorCode = Extract<
  ErrorCode,
  'AUTH_MISSING' | 'AUTH_INVALID' | 'MACHINE_ACCESS_EXPIRED' | 'AGENCY_SUSPENDED'
>;

const MESSAGES: Readonly<Record<AuthErrorCode, string>> = {
  AUTH_MISSING: 'Authentication required',
  AUTH_INVALID: 'Authentication invalid',
  MACHINE_ACCESS_EXPIRED: 'Machine access expired',
  AGENCY_SUSPENDED: 'Agency suspended',
};

function fail(code: AuthErrorCode): Result<never, ApiError> {
  return err({ code, message: MESSAGES[code] });
}

const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Splits `oem_<keyId>_<secret>` at the first `_` after the prefix; `null` if malformed. */
function parseMachineCredential(credential: string): { keyId: string; secret: string } | null {
  const rest = credential.slice(MACHINE_CREDENTIAL_PREFIX.length);
  const separator = rest.indexOf('_');
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { keyId: rest.slice(0, separator), secret: rest.slice(separator + 1) };
}

function secretMatches(secret: string, keyHash: string): boolean {
  if (!SHA256_HEX.test(keyHash)) return false;
  return timingSafeEqual(
    Buffer.from(hashMachineSecret(secret), 'hex'),
    Buffer.from(keyHash, 'hex'),
  );
}

/**
 * {@link Authenticator} with 60 s TTL caches for memberships, agency states and machine
 * accesses: role changes, suspensions and revocations take effect within 60 s. `lastUsedAt`
 * is written at most once per minute and key (best effort; failures do not reject the call).
 */
export class CachingAuthenticator implements Authenticator {
  private readonly tokenVerifier: AccessTokenVerifier;
  private readonly memberships: AuthenticatorOptions['memberships'];
  private readonly agencies: AuthenticatorOptions['agencies'];
  private readonly machineAccesses: AuthenticatorOptions['machineAccesses'];
  private readonly clock: Clock;
  private readonly membershipCache: TtlCache<string, MembershipRecord | null>;
  private readonly agencyCache: TtlCache<string, AgencyRecord | null>;
  private readonly machineAccessCache: TtlCache<string, MachineAccessRecord | null>;
  /** Local throttle so a warm instance does not attempt a conditional write per call. */
  private readonly lastUsedThrottle: TtlCache<string, true>;

  constructor(options: AuthenticatorOptions) {
    this.tokenVerifier = options.tokenVerifier;
    this.memberships = options.memberships;
    this.agencies = options.agencies;
    this.machineAccesses = options.machineAccesses;
    this.clock = options.clock ?? systemClock;
    const ttl = options.cacheTtlMs ?? ACCESS_CACHE_TTL_MS;
    this.membershipCache = new TtlCache(this.clock, ttl);
    this.agencyCache = new TtlCache(this.clock, ttl);
    this.machineAccessCache = new TtlCache(this.clock, ttl);
    this.lastUsedThrottle = new TtlCache(this.clock, LAST_USED_WRITE_INTERVAL_MS);
  }

  async authenticate(authorization: string | undefined): Promise<Result<Principal, ApiError>> {
    if (authorization === undefined || authorization.trim() === '') return fail('AUTH_MISSING');
    const credential = BEARER.exec(authorization)?.[1];
    if (credential === undefined) return fail('AUTH_INVALID');
    return credential.startsWith(MACHINE_CREDENTIAL_PREFIX)
      ? this.authenticateMachine(credential)
      : this.authenticateUser(credential);
  }

  private async authenticateUser(token: string): Promise<Result<Principal, ApiError>> {
    const userId = await this.tokenVerifier.verify(token);
    if (userId === null) return fail('AUTH_INVALID');
    const membership = await this.membershipCache.get(userId, () => this.memberships.get(userId));
    // No membership = Cognito account without Platform access.
    if (membership === null) return fail('AUTH_INVALID');
    const { displayName } = membership;
    if (membership.role === 'PLATFORM_ADMIN') {
      return ok({ kind: 'user', userId, displayName, role: 'PLATFORM_ADMIN' });
    }
    const agencyId = membership.agencyId;
    if (agencyId === undefined) return fail('AUTH_INVALID');
    const agencyCheck = await this.checkAgency(agencyId);
    if (!agencyCheck.ok) return agencyCheck;
    return ok({ kind: 'user', userId, displayName, role: membership.role, agencyId });
  }

  private async authenticateMachine(credential: string): Promise<Result<Principal, ApiError>> {
    const parsed = parseMachineCredential(credential);
    if (parsed === null) return fail('AUTH_INVALID');
    const { keyId, secret } = parsed;
    const access = await this.machineAccessCache.get(keyId, () => this.machineAccesses.get(keyId));
    if (access === null || access.revokedAt !== undefined) return fail('AUTH_INVALID');
    if (!secretMatches(secret, access.keyHash)) return fail('AUTH_INVALID');
    // Expiry is only revealed to holders of the correct secret.
    const now = this.clock();
    if (access.expiresAt !== undefined && Date.parse(access.expiresAt) <= now) {
      return fail('MACHINE_ACCESS_EXPIRED');
    }
    const agencyCheck = await this.checkAgency(access.agencyId);
    if (!agencyCheck.ok) return agencyCheck;
    await this.touchLastUsed(keyId, now);
    return ok({
      kind: 'machine',
      keyId,
      label: access.label,
      agencyId: access.agencyId,
      permissions: [...access.permissions],
    });
  }

  private async checkAgency(agencyId: string): Promise<Result<null, ApiError>> {
    const agency = await this.agencyCache.get(agencyId, () => this.agencies.get(agencyId));
    if (agency === null) return fail('AUTH_INVALID');
    if (agency.state === 'SUSPENDED') return fail('AGENCY_SUSPENDED');
    return ok(null);
  }

  private async touchLastUsed(keyId: string, now: number): Promise<void> {
    await this.lastUsedThrottle.get(keyId, async () => {
      try {
        await this.machineAccesses.touchLastUsed(keyId, now, LAST_USED_WRITE_INTERVAL_MS);
      } catch {
        // `lastUsedAt` is informational (Req 3.7); a failed write must not reject the call.
      }
      return true as const;
    });
  }
}
