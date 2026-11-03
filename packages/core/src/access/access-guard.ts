import { err, ok, type ApiError, type Result } from '@open-estate/shared';
import type { AccessConfig, AccessConfigSource, RateLimit } from './access-config';
import { hashApiKey, isApiKeyValid, type ApiKeyRecord, type ApiKeyStore } from './api-key-store';
import type { RateLimitCounterStore } from './rate-limit-counter-store';
import { ACCESS_CACHE_TTL_MS, systemClock, TtlCache, type Clock } from './ttl-cache';

export interface AccessRequest {
  sourceIp: string;
  /** Raw `Authorization` header value; the key is expected as `Bearer <key>`. */
  authorization?: string | undefined;
}

export interface Admitted {
  /** `ip:<sourceIp>` (access mode `open`) or `key:<keyId>` (access mode `api-keys`). */
  clientId: string;
  keyId?: string;
  /** Limit that was applied: the key's own limit or the global one. */
  rateLimit: RateLimit;
}

/**
 * Shared by API and MCP Lambda (Req 17.1–17.7). Order: access mode → key check → rate limit.
 * Errors: `API_KEY_MISSING` / `API_KEY_INVALID` (401) and `RATE_LIMITED` (429) with
 * `details.retryAfterSeconds`; adapters copy that into `ErrorResponse.retryAfterSeconds`
 * and the `Retry-After` header.
 */
export interface AccessGuard {
  admit(req: AccessRequest): Promise<Result<Admitted, ApiError>>;
}

export interface AccessGuardOptions {
  config: AccessConfigSource;
  apiKeys: ApiKeyStore;
  counters: RateLimitCounterStore;
  clock?: Clock;
  /** Cache TTL for access config and key records; default 60 s (Req 17.9). */
  cacheTtlMs?: number;
}

/** Retry-After value: whole seconds until the window ends, at least 1 (Req 17.2). */
export function retryAfterSeconds(windowEndMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((windowEndMs - nowMs) / 1000));
}

const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;

export function createAccessGuard(options: AccessGuardOptions): AccessGuard {
  const clock = options.clock ?? systemClock;
  const ttl = options.cacheTtlMs ?? ACCESS_CACHE_TTL_MS;
  const configCache = new TtlCache<'config', AccessConfig>(clock, ttl, 1);
  const keyCache = new TtlCache<string, ApiKeyRecord | null>(clock, ttl);

  return {
    async admit({ sourceIp, authorization }) {
      const config = await configCache.get('config', () => options.config.load());

      let clientId = `ip:${sourceIp}`;
      let keyId: string | undefined;
      let rateLimit = config.rateLimit;

      if (config.mode === 'api-keys') {
        if (authorization === undefined || authorization.trim() === '') {
          return err({ code: 'API_KEY_MISSING', message: 'API key is required' });
        }
        const token = BEARER.exec(authorization)?.[1];
        const keyHash = token === undefined ? undefined : hashApiKey(token);
        const record =
          keyHash === undefined
            ? null
            : await keyCache.get(keyHash, () => options.apiKeys.findByHash(keyHash));
        if (record === null || !isApiKeyValid(record, clock())) {
          return err({ code: 'API_KEY_INVALID', message: 'API key is invalid' });
        }
        clientId = `key:${record.keyId}`;
        keyId = record.keyId;
        rateLimit = record.rateLimit ?? config.rateLimit;
      }

      const now = clock();
      const windowMs = rateLimit.windowSeconds * 1000;
      const windowStartMs = Math.floor(now / windowMs) * windowMs;
      const windowEndMs = windowStartMs + windowMs;
      const admitted = await options.counters.tryIncrement({
        counterKey: `${clientId}#${windowStartMs / 1000}`,
        limit: rateLimit.requests,
        expiresAtEpochSeconds: windowEndMs / 1000,
      });
      if (!admitted) {
        return err({
          code: 'RATE_LIMITED',
          message: `Rate limit of ${rateLimit.requests} requests per ${rateLimit.windowSeconds} s exceeded`,
          details: { retryAfterSeconds: retryAfterSeconds(windowEndMs, now) },
        });
      }
      return ok(keyId === undefined ? { clientId, rateLimit } : { clientId, keyId, rateLimit });
    },
  };
}
