import { randomBytes, randomUUID } from 'node:crypto';
import { err, ok, toApiErrors, type ApiError, type Result } from '@open-estate/shared';
import { z } from 'zod';
import {
  ACCESS_MODES,
  RATE_LIMIT_REQUESTS_MAX,
  RATE_LIMIT_REQUESTS_MIN,
  RATE_LIMIT_WINDOW_SECONDS_MAX,
  RATE_LIMIT_WINDOW_SECONDS_MIN,
  rateLimitSchema,
  type AccessConfigWriter,
  type AccessMode,
  type RateLimit,
} from '../access/access-config';
import { hashApiKey, type ApiKeyAdminStore, type ApiKeyRecord } from '../access/api-key-store';
import type { Clock } from '../access/ttl-cache';
import type { AdminAuditLog } from './admin-audit-log';
import {
  adminActorId,
  invalidInput,
  notFoundError,
  type AdminActor,
  type AdminResult,
} from './admin-operation';

export interface GeneratedApiKey {
  keyId: string;
  /** Plain key; returned exactly once in the create response and never stored. */
  apiKey: string;
}

/** Bytes of entropy per API key (256 bit). */
export const API_KEY_BYTES = 32;

/** Cryptographically secure key (base64url, 43 chars) with a random UUID as id. */
export function generateApiKey(): GeneratedApiKey {
  return { keyId: randomUUID(), apiKey: randomBytes(API_KEY_BYTES).toString('base64url') };
}

/** `action` values of `access-config` audit entries. */
export type AccessConfigAction =
  | 'api-key.created'
  | 'api-key.revoked'
  | 'api-key.rate-limit-set'
  | 'rate-limit.set'
  | 'access-mode.set';

/** Key record as returned to administrators: never the hash. */
export type PublicApiKey = Omit<ApiKeyRecord, 'keyHash'>;

/** A created key with its plain value (shown exactly once). */
export type CreatedApiKey = PublicApiKey & { apiKey: string };

const RATE_LIMIT_RANGES = {
  requests: [RATE_LIMIT_REQUESTS_MIN, RATE_LIMIT_REQUESTS_MAX],
  windowSeconds: [RATE_LIMIT_WINDOW_SECONDS_MIN, RATE_LIMIT_WINDOW_SECONDS_MAX],
} as const;

const strictRateLimitSchema = z.strictObject(rateLimitSchema.shape);
/** Request body of "create API key". */
export const createApiKeyInputSchema = z.strictObject({
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  rateLimit: z.unknown().optional(),
});
/** Request body of "set access mode". */
export const accessModeInputSchema = z.strictObject({ mode: z.enum(ACCESS_MODES) });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const describeValue = (value: unknown): string =>
  value === undefined ? 'missing' : JSON.stringify(value);

/**
 * Validates a rate limit with `rateLimitSchema` (Req 17.1, 17.6). Every invalid value yields
 * `INVALID_RATE_LIMIT` naming the field and the rejected value (Req 17.8); unknown fields yield
 * `INVALID_PARAMETER`.
 */
export function validateRateLimit(input: unknown, fieldPrefix = ''): Result<RateLimit, ApiError[]> {
  const result = strictRateLimitSchema.safeParse(input);
  if (result.success) return ok(result.data);

  const fieldOf = (name: string) => (fieldPrefix === '' ? name : `${fieldPrefix}.${name}`);
  const errors = new Map<string, ApiError>();
  for (const issue of result.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const field = fieldOf(key);
        errors.set(field, { code: 'INVALID_PARAMETER', message: `Unknown field ${field}`, field });
      }
      continue;
    }
    const name = issue.path[0];
    if ((name === 'requests' || name === 'windowSeconds') && isObject(input)) {
      const [min, max] = RATE_LIMIT_RANGES[name];
      const field = fieldOf(name);
      const value = input[name];
      errors.set(field, {
        code: 'INVALID_RATE_LIMIT',
        message: `${field} must be an integer between ${min} and ${max}; got ${describeValue(value)}`,
        field,
        ...(value !== undefined && { details: { value } }),
      });
    } else {
      errors.set(fieldPrefix, {
        code: 'INVALID_RATE_LIMIT',
        message: `${fieldPrefix || 'Rate limit'} must be an object {requests, windowSeconds}; got ${describeValue(input)}`,
        ...(fieldPrefix !== '' && { field: fieldPrefix }),
        details: { value: input },
      });
    }
  }
  return err([...errors.values()]);
}

function toPublicKey(record: ApiKeyRecord): PublicApiKey {
  const { keyId, status, expiresAt, rateLimit } = record;
  return {
    keyId,
    status,
    ...(expiresAt !== undefined && { expiresAt }),
    ...(rateLimit !== undefined && { rateLimit }),
  };
}

export interface AccessOperationsDeps {
  apiKeys: ApiKeyAdminStore;
  accessConfig: AccessConfigWriter;
  audit: AdminAuditLog;
  clock: Clock;
  generateKey?: () => GeneratedApiKey;
}

/**
 * API keys, rate limits and access mode (Req 17.4, 17.6, 17.8, 17.9). Invalid input is rejected
 * before anything is written, so the previous configuration stays; each successful change is
 * recorded as `access-config` audit entry without secrets.
 */
export interface AccessOperations {
  createApiKey(actor: AdminActor, input: unknown): Promise<AdminResult<CreatedApiKey>>;
  revokeApiKey(actor: AdminActor, keyId: string): Promise<AdminResult<PublicApiKey>>;
  setApiKeyRateLimit(
    actor: AdminActor,
    keyId: string,
    input: unknown,
  ): Promise<AdminResult<PublicApiKey>>;
  setRateLimit(actor: AdminActor, input: unknown): Promise<AdminResult<{ rateLimit: RateLimit }>>;
  setAccessMode(actor: AdminActor, input: unknown): Promise<AdminResult<{ mode: AccessMode }>>;
}

export function createAccessOperations(deps: AccessOperationsDeps): AccessOperations {
  const { clock } = deps;
  const generateKey = deps.generateKey ?? generateApiKey;

  const audit = (actor: AdminActor, action: AccessConfigAction, details: Record<string, unknown>) =>
    deps.audit.append({
      type: 'access-config',
      action,
      actor: adminActorId(actor),
      at: new Date(clock()).toISOString(),
      details,
    });

  return {
    async createApiKey(actor, input) {
      const parsed = createApiKeyInputSchema.safeParse(input);
      if (!parsed.success) return err(invalidInput(toApiErrors(parsed.error.issues)));
      const { expiresAt, rateLimit: rawLimit } = parsed.data;

      let rateLimit: RateLimit | undefined;
      if (rawLimit !== undefined) {
        const limit = validateRateLimit(rawLimit, 'rateLimit');
        if (!limit.ok) return err(invalidInput(limit.error));
        rateLimit = limit.value;
      }
      const expiry = expiresAt === undefined ? undefined : Date.parse(expiresAt);
      if (expiry !== undefined && expiry <= clock()) {
        return err(
          invalidInput([
            {
              code: 'INVALID_PARAMETER',
              message: 'expiresAt must be in the future',
              field: 'expiresAt',
            },
          ]),
        );
      }

      const { keyId, apiKey } = generateKey();
      const record: ApiKeyRecord = {
        keyId,
        keyHash: hashApiKey(apiKey),
        status: 'active',
        ...(expiry !== undefined && { expiresAt: new Date(expiry).toISOString() }),
        ...(rateLimit !== undefined && { rateLimit }),
      };
      await deps.apiKeys.create(record);
      const key = toPublicKey(record);
      await audit(actor, 'api-key.created', { ...key });
      return ok({ ...key, apiKey });
    },

    async revokeApiKey(actor, keyId) {
      const record = await deps.apiKeys.revoke(keyId);
      if (record === null) return err(notFoundError(`API key ${keyId} not found`));
      await audit(actor, 'api-key.revoked', { keyId });
      return ok(toPublicKey(record));
    },

    async setApiKeyRateLimit(actor, keyId, input) {
      const limit = validateRateLimit(input);
      if (!limit.ok) return err(invalidInput(limit.error));
      const record = await deps.apiKeys.setRateLimit(keyId, limit.value);
      if (record === null) return err(notFoundError(`API key ${keyId} not found`));
      await audit(actor, 'api-key.rate-limit-set', { keyId, rateLimit: limit.value });
      return ok(toPublicKey(record));
    },

    async setRateLimit(actor, input) {
      const limit = validateRateLimit(input);
      if (!limit.ok) return err(invalidInput(limit.error));
      await deps.accessConfig.setRateLimit(limit.value);
      await audit(actor, 'rate-limit.set', { rateLimit: limit.value });
      return ok({ rateLimit: limit.value });
    },

    async setAccessMode(actor, input) {
      const parsed = accessModeInputSchema.safeParse(input);
      if (!parsed.success) return err(invalidInput(toApiErrors(parsed.error.issues)));
      const mode: AccessMode = parsed.data.mode;
      await deps.accessConfig.setAccessMode(mode);
      await audit(actor, 'access-mode.set', { mode });
      return ok({ mode });
    },
  };
}
