import { GetParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';
import {
  ACCESS_CACHE_TTL_MS,
  ConfigError,
  DEFAULT_RATE_LIMIT,
  rateLimitSchema,
  retryAfterSeconds,
  systemClock,
  TtlCache,
  type Authenticator,
  type Clock,
  type RateLimit,
  type RateLimitCounterStore,
} from '@open-estate/core';
import { err, ok, type ApiError, type Principal, type Result } from '@open-estate/shared';

// Zugangsschutz of the Management_API (design: "Request-Pfade", "Rate_Limit", Req 2.4, 2.9).
// Order per request: per-IP limit (before any token check, so floods never reach Cognito/JWKS or
// DynamoDB) → Authenticator → per-actor limit (`user:{userId}` / `mk:{keyId}`). Same fixed-window
// counters as the AccessGuard of Search_API and MCP_Server, own limit from SSM
// `/open-estate/{env}/management-rate-limit` with the value ranges of Req 17.1.

/** Source of the Management_API's rate limit; cached by the guard for 60 s. */
export interface RateLimitSource {
  load(): Promise<RateLimit>;
}

export class StaticRateLimitSource implements RateLimitSource {
  constructor(private rateLimit: RateLimit) {}

  set(rateLimit: RateLimit): void {
    this.rateLimit = rateLimit;
  }

  async load(): Promise<RateLimit> {
    return this.rateLimit;
  }
}

export interface SsmRateLimitSourceOptions {
  client: SSMClient;
  /** `/open-estate/{env}/management-rate-limit`, value `{"requests":N,"windowSeconds":W}`. */
  parameterName: string;
}

/**
 * Reads the limit from SSM. A missing parameter falls back to the documented default (60 per
 * 60 s, as for the Search_API); an invalid value throws `ConfigError{CONFIG_INVALID}` naming the
 * parameter instead of guessing.
 */
export class SsmRateLimitSource implements RateLimitSource {
  constructor(private readonly options: SsmRateLimitSourceOptions) {}

  async load(): Promise<RateLimit> {
    const { client, parameterName } = this.options;
    let raw: string | undefined;
    try {
      const out = await client.send(new GetParameterCommand({ Name: parameterName }));
      raw = out.Parameter?.Value;
    } catch (error) {
      if (error instanceof Error && error.name === 'ParameterNotFound') return DEFAULT_RATE_LIMIT;
      throw error;
    }
    if (raw === undefined || raw.trim() === '') return DEFAULT_RATE_LIMIT;
    return parseRateLimit(parameterName, raw);
  }
}

function parseRateLimit(parameter: string, raw: string): RateLimit {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError('CONFIG_INVALID', [parameter], [{ path: '', message }]);
  }
  const result = rateLimitSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      'CONFIG_INVALID',
      [parameter],
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/** Rate-limit client identity of an authenticated actor (design: "Rate_Limit"). */
export function actorClientId(principal: Principal): string {
  return principal.kind === 'user' ? `user:${principal.userId}` : `mk:${principal.keyId}`;
}

/**
 * Rate-limit client identity of a source IP. Prefixed with `mgmt-` so the Management_API never
 * shares a window with the Search_API's `ip:` counters, even on a shared counter table.
 */
export const ipClientId = (sourceIp: string) => `mgmt-ip:${sourceIp}`;

export interface AccessRequest {
  sourceIp: string;
  /** Raw `Authorization` header. */
  authorization?: string | undefined;
}

export interface ManagementAccessGuard {
  /** Per-IP limit only; used for public routes and before authentication. */
  admitIp(sourceIp: string): Promise<Result<null, ApiError>>;
  /**
   * Per-IP limit → authentication → per-actor limit. Errors: `RATE_LIMITED` (429, with
   * `details.retryAfterSeconds`), the Authenticator's 401/403 codes.
   */
  admit(request: AccessRequest): Promise<Result<Principal, ApiError>>;
}

export interface ManagementAccessGuardOptions {
  authenticator: Authenticator;
  rateLimit: RateLimitSource;
  counters: RateLimitCounterStore;
  clock?: Clock;
  /** Cache TTL of the rate limit; default 60 s, so admin changes apply within 60 s. */
  cacheTtlMs?: number;
}

export function createManagementAccessGuard(
  options: ManagementAccessGuardOptions,
): ManagementAccessGuard {
  const clock = options.clock ?? systemClock;
  const limitCache = new TtlCache<'limit', RateLimit>(
    clock,
    options.cacheTtlMs ?? ACCESS_CACHE_TTL_MS,
    1,
  );

  async function consume(clientId: string): Promise<Result<null, ApiError>> {
    const rateLimit = await limitCache.get('limit', () => options.rateLimit.load());
    const now = clock();
    const windowMs = rateLimit.windowSeconds * 1000;
    const windowStartMs = Math.floor(now / windowMs) * windowMs;
    const windowEndMs = windowStartMs + windowMs;
    const admitted = await options.counters.tryIncrement({
      counterKey: `${clientId}#${windowStartMs / 1000}`,
      limit: rateLimit.requests,
      expiresAtEpochSeconds: windowEndMs / 1000,
    });
    if (admitted) return ok(null);
    return err({
      code: 'RATE_LIMITED',
      message: `Rate limit of ${rateLimit.requests} requests per ${rateLimit.windowSeconds} s exceeded`,
      details: { retryAfterSeconds: retryAfterSeconds(windowEndMs, now) },
    });
  }

  const admitIp = (sourceIp: string) => consume(ipClientId(sourceIp));

  return {
    admitIp,
    async admit({ sourceIp, authorization }) {
      const ip = await admitIp(sourceIp);
      if (!ip.ok) return ip;
      const authenticated = await options.authenticator.authenticate(authorization);
      if (!authenticated.ok) return authenticated;
      const actor = await consume(actorClientId(authenticated.value));
      return actor.ok ? authenticated : actor;
    },
  };
}
