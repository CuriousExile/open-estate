// Feature: real-estate-platform, Property 38: Validierung von Rate-Limit-Änderungen
import fc from 'fast-check';
import { createAdminHandler, InMemoryAuditLog, type AdminRequest } from '@open-estate/admin';
import {
  ACCESS_MODES,
  hashApiKey,
  InMemoryApiKeyStore,
  RATE_LIMIT_REQUESTS_MAX,
  RATE_LIMIT_REQUESTS_MIN,
  RATE_LIMIT_WINDOW_SECONDS_MAX,
  RATE_LIMIT_WINDOW_SECONDS_MIN,
  StaticAccessConfigSource,
  type AccessConfig,
  type ApiKeyRecord,
  type RateLimit,
} from '@open-estate/core';
import type { ApiError } from '@open-estate/shared';
import { createDeletionHarness } from './support/deletion-harness';

/** **Validates: Requirements 17.8** */

const RUNS = { numRuns: 100 };
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const ADMIN = 'arn:aws:iam::123456789012:user/admin';
const NEW_KEY = { keyId: 'new-key', apiKey: 'new-plain-key' };

const RANGES = {
  requests: [RATE_LIMIT_REQUESTS_MIN, RATE_LIMIT_REQUESTS_MAX],
  windowSeconds: [RATE_LIMIT_WINDOW_SECONDS_MIN, RATE_LIMIT_WINDOW_SECONDS_MAX],
} as const;
type LimitField = keyof typeof RANGES;
const FIELDS = Object.keys(RANGES) as LimitField[];

// --- Arbitraries ------------------------------------------------------------------------------

/** Valid integer in `[min, max]`, with the bounds (1, 10000, 3600) drawn frequently. */
const arbValidInt = ([min, max]: readonly [number, number]) =>
  fc.oneof(fc.constantFrom(min, max), fc.integer({ min, max }));

/** Out of range, non-integer or not a number at all. */
const arbInvalidValue = ([min, max]: readonly [number, number]): fc.Arbitrary<unknown> =>
  fc.oneof(
    fc.constantFrom(min - 1, max + 1, -1),
    fc.integer({ max: min - 1 }),
    fc.integer({ min: max + 1 }),
    fc
      .double({ min: -2 * max, max: 2 * max, noNaN: true, noDefaultInfinity: true })
      .filter((n) => !Number.isInteger(n)),
    fc.string(),
    fc.integer({ min, max }).map(String),
    fc.constant(null),
    fc.boolean(),
    fc.array(fc.integer({ min, max }), { maxLength: 2 }),
    fc.constant({}),
  );

const arbRateLimit: fc.Arbitrary<RateLimit> = fc.record({
  requests: arbValidInt(RANGES.requests),
  windowSeconds: arbValidInt(RANGES.windowSeconds),
});

/** Field value of a change: valid, invalid or missing (`undefined` = key absent). */
const arbFieldValue = (field: LimitField): fc.Arbitrary<unknown> =>
  fc.oneof(
    { weight: 4, arbitrary: arbValidInt(RANGES[field]) },
    { weight: 3, arbitrary: arbInvalidValue(RANGES[field]) },
    { weight: 1, arbitrary: fc.constant(undefined) },
  );

const EXTRA_KEYS = ['limit', 'window', 'Requests', 'requestsPerWindow', 'burst'] as const;

/** Rate-limit object as sent by the admin, optionally with unknown fields. */
const arbChangeObject: fc.Arbitrary<Record<string, unknown>> = fc
  .tuple(
    arbFieldValue('requests'),
    arbFieldValue('windowSeconds'),
    fc.oneof(
      { weight: 4, arbitrary: fc.constant({}) },
      {
        weight: 1,
        arbitrary: fc.dictionary(fc.constantFrom(...EXTRA_KEYS), fc.jsonValue(), {
          minKeys: 1,
          maxKeys: 2,
        }),
      },
    ),
  )
  .map(([requests, windowSeconds, extra]) => ({
    ...extra,
    ...(requests !== undefined && { requests }),
    ...(windowSeconds !== undefined && { windowSeconds }),
  }));

/** `rateLimit` of `POST /admin/api-keys`: object, non-object, or omitted. */
const arbCreateRateLimit: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 6, arbitrary: arbChangeObject },
  {
    weight: 1,
    arbitrary: fc.oneof(
      fc.constant(null),
      fc.integer(),
      fc.string(),
      fc.boolean(),
      fc.array(fc.integer()),
    ),
  },
  { weight: 1, arbitrary: fc.constant(undefined) },
);

const arbInitial = fc.record({
  config: fc.record({ mode: fc.constantFrom(...ACCESS_MODES), rateLimit: arbRateLimit }),
  keys: fc
    .uniqueArray(fc.stringMatching(/^[A-Za-z0-9_-]{1,16}$/), { minLength: 1, maxLength: 4 })
    .filter((ids) => !ids.includes(NEW_KEY.keyId))
    .chain((ids) =>
      fc.tuple(
        ...ids.map((keyId) =>
          fc.record(
            {
              keyId: fc.constant(keyId),
              keyHash: fc.constant(hashApiKey(`plain-${keyId}`)),
              status: fc.constantFrom('active' as const, 'revoked' as const),
              rateLimit: arbRateLimit,
            },
            { requiredKeys: ['keyId', 'keyHash', 'status'] },
          ),
        ),
      ),
    ),
});

type Change =
  | { endpoint: 'global'; body: Record<string, unknown> }
  | { endpoint: 'key'; keyIndex: number; body: Record<string, unknown> }
  | { endpoint: 'create'; rateLimit: unknown };

const arbChange: fc.Arbitrary<Change> = fc.oneof(
  arbChangeObject.map((body) => ({ endpoint: 'global' as const, body })),
  fc
    .tuple(fc.nat(), arbChangeObject)
    .map(([keyIndex, body]) => ({ endpoint: 'key' as const, keyIndex, body })),
  arbCreateRateLimit.map((rateLimit) => ({ endpoint: 'create' as const, rateLimit })),
);

// --- Oracle -----------------------------------------------------------------------------------

const describeValue = (value: unknown) => (value === undefined ? 'missing' : JSON.stringify(value));

const isValidInt = (value: unknown, [min, max]: readonly [number, number]) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Errors the change must be rejected with; empty if it is valid. */
function expectedErrors(input: unknown, prefix: string): ApiError[] {
  const fieldOf = (name: string) => (prefix === '' ? name : `${prefix}.${name}`);
  if (!isObject(input)) {
    return [
      {
        code: 'INVALID_RATE_LIMIT',
        message: expect.stringContaining(describeValue(input)) as string,
        field: prefix,
        details: { value: input },
      },
    ];
  }
  const errors: ApiError[] = [];
  for (const field of FIELDS) {
    const value = input[field];
    if (isValidInt(value, RANGES[field])) continue;
    errors.push({
      code: 'INVALID_RATE_LIMIT',
      message: expect.stringContaining(`; got ${describeValue(value)}`) as string,
      field: fieldOf(field),
      ...(value !== undefined && { details: { value } }),
    });
  }
  for (const key of Object.keys(input).filter((k) => !(FIELDS as string[]).includes(k))) {
    errors.push({
      code: 'INVALID_PARAMETER',
      message: expect.any(String) as string,
      field: fieldOf(key),
    });
  }
  return errors;
}

const byField = (a: ApiError, b: ApiError) => (a.field ?? '').localeCompare(b.field ?? '');
const byKeyId = (a: ApiKeyRecord, b: ApiKeyRecord) => a.keyId.localeCompare(b.keyId);

// --- Setup ------------------------------------------------------------------------------------

function setup(config: AccessConfig, keys: readonly ApiKeyRecord[]) {
  const apiKeys = new InMemoryApiKeyStore(structuredClone(keys));
  const accessConfig = new StaticAccessConfigSource(structuredClone(config));
  const audit = new InMemoryAuditLog();
  const handler = createAdminHandler({
    apiKeys,
    accessConfig,
    audit,
    deletions: createDeletionHarness({ audit }).deletions,
    clock: () => T0,
    generateKey: () => NEW_KEY,
  });
  return { handler, apiKeys, accessConfig, audit };
}

/** Existing key addressed by `PUT /admin/api-keys/{keyId}/rate-limit` (`keys` is non-empty). */
const targetKeyId = (keys: readonly ApiKeyRecord[], index: number): string =>
  keys[index % keys.length]?.keyId ?? '';

function toRequest(change: Change, keys: readonly ApiKeyRecord[]): AdminRequest {
  const base = { requestContext: { identity: { userArn: ADMIN } } };
  switch (change.endpoint) {
    case 'global':
      return {
        ...base,
        httpMethod: 'PUT',
        path: '/admin/rate-limit',
        body: JSON.stringify(change.body),
      };
    case 'key': {
      const keyId = targetKeyId(keys, change.keyIndex);
      return {
        ...base,
        httpMethod: 'PUT',
        path: `/admin/api-keys/${keyId}/rate-limit`,
        body: JSON.stringify(change.body),
      };
    }
    case 'create':
      return {
        ...base,
        httpMethod: 'POST',
        path: '/admin/api-keys',
        body: JSON.stringify(change.rateLimit === undefined ? {} : { rateLimit: change.rateLimit }),
      };
  }
}

/** The input `validateRateLimit` sees, after the JSON round trip of the request body. */
function sentLimit(
  request: AdminRequest,
  change: Change,
): { input: unknown; prefix: string; present: boolean } {
  const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
  return change.endpoint === 'create'
    ? { input: body.rateLimit, prefix: 'rateLimit', present: 'rateLimit' in body }
    : { input: body, prefix: '', present: true };
}

// --- Property ---------------------------------------------------------------------------------

describe('Property 38: Validierung von Rate-Limit-Änderungen', () => {
  it('rejects invalid changes naming each invalid value and keeps the configuration; applies valid ones', async () => {
    await fc.assert(
      fc.asyncProperty(arbInitial, arbChange, async ({ config, keys }, change) => {
        const { handler, apiKeys, accessConfig, audit } = setup(config, keys);
        const request = toRequest(change, keys);
        const { input, prefix, present } = sentLimit(request, change);
        const errors = present ? expectedErrors(input, prefix) : [];

        const res = await handler(request);
        const body = JSON.parse(res.body) as { errors?: ApiError[] } & Record<string, unknown>;
        const storedKeys = apiKeys.records().sort(byKeyId);
        const initialKeys = [...keys].sort(byKeyId);

        if (errors.length > 0) {
          expect(res.statusCode).toBe(400);
          expect([...(body.errors ?? [])].sort(byField)).toEqual(errors.sort(byField));
          expect(await accessConfig.load()).toEqual(config);
          expect(storedKeys).toEqual(initialKeys);
          expect(audit.entries).toEqual([]);
          return;
        }

        const limit = (present ? input : undefined) as RateLimit | undefined;
        expect(audit.entries).toHaveLength(1);
        const [entry] = audit.entries;
        switch (change.endpoint) {
          case 'global':
            expect(res.statusCode).toBe(200);
            expect(await accessConfig.load()).toEqual({ ...config, rateLimit: limit });
            expect(storedKeys).toEqual(initialKeys);
            expect(entry).toMatchObject({
              action: 'rate-limit.set',
              details: { rateLimit: limit },
            });
            break;
          case 'key': {
            const keyId = targetKeyId(keys, change.keyIndex);
            expect(res.statusCode).toBe(200);
            expect(await accessConfig.load()).toEqual(config);
            expect(storedKeys).toEqual(
              initialKeys.map((k) => (k.keyId === keyId ? { ...k, rateLimit: limit } : k)),
            );
            expect(entry).toMatchObject({
              action: 'api-key.rate-limit-set',
              details: { keyId, rateLimit: limit },
            });
            break;
          }
          case 'create': {
            expect(res.statusCode).toBe(201);
            expect(await accessConfig.load()).toEqual(config);
            const created: ApiKeyRecord = {
              keyId: NEW_KEY.keyId,
              keyHash: hashApiKey(NEW_KEY.apiKey),
              status: 'active',
              ...(limit !== undefined && { rateLimit: limit }),
            };
            expect(storedKeys).toEqual([...initialKeys, created].sort(byKeyId));
            expect(entry).toMatchObject({
              action: 'api-key.created',
              details: { keyId: NEW_KEY.keyId },
            });
            expect(entry?.details.rateLimit).toEqual(limit);
            break;
          }
        }
      }),
      RUNS,
    );
  });
});
