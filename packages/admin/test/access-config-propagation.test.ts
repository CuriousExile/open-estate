// Req 17.9: admin changes reach the AccessGuard of API/MCP within 60 s, without a restart.
import { GetParametersCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { createAdminHandler, InMemoryAuditLog, type AdminRequest } from '@open-estate/admin';
import {
  ACCESS_CACHE_TTL_MS,
  createAccessGuard,
  hashApiKey,
  InMemoryApiKeyStore,
  InMemoryRateLimitCounterStore,
  SsmAccessConfigSource,
  SsmAccessConfigWriter,
  type AccessMode,
  type RateLimit,
} from '@open-estate/core';
import { createDeletionHarness } from './support/deletion-harness';

/** **Validates: Requirements 17.9** */

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0); // start of an hour: one 3600-s window for the whole test
const ADMIN = 'arn:aws:iam::123456789012:user/admin';
const KEY = 'plain-secret-key';
const HOUR: RateLimit = { requests: 1, windowSeconds: 3600 };
const PARAMETERS = {
  accessModeParameter: '/open-estate/test/access-mode',
  rateLimitParameter: '/open-estate/test/rate-limit',
};

/** SSM client whose `send` serves Put/GetParameters from one map, like the real parameter store. */
function fakeSsm(initial: Record<string, string>) {
  const client = new SSMClient({ region: 'eu-central-1' });
  const stored = new Map(Object.entries(initial));
  jest.spyOn(client, 'send').mockImplementation(async (command: unknown) => {
    if (command instanceof PutParameterCommand) {
      stored.set(command.input.Name ?? '', command.input.Value ?? '');
      return {};
    }
    if (command instanceof GetParametersCommand) {
      const names = command.input.Names ?? [];
      return {
        Parameters: names.flatMap((Name) =>
          stored.has(Name) ? [{ Name, Value: stored.get(Name) }] : [],
        ),
      };
    }
    throw new Error(`unexpected SSM command ${String(command)}`);
  });
  return { client, stored };
}

/**
 * Production pairing: the admin handler writes through `SsmAccessConfigWriter`, the guard reads
 * through `SsmAccessConfigSource` (both on the same fake SSM); API keys share one store.
 * The guard uses the default 60-s cache.
 */
function setup(mode: AccessMode, rateLimit: RateLimit, keyLimit?: RateLimit) {
  let now = T0;
  const clock = () => now;
  const ssm = fakeSsm({
    [PARAMETERS.accessModeParameter]: mode,
    [PARAMETERS.rateLimitParameter]: JSON.stringify(rateLimit),
  });
  const apiKeys = new InMemoryApiKeyStore([
    {
      keyId: 'k-1',
      keyHash: hashApiKey(KEY),
      status: 'active',
      ...(keyLimit !== undefined && { rateLimit: keyLimit }),
    },
  ]);
  const audit = new InMemoryAuditLog();
  const handler = createAdminHandler({
    apiKeys,
    accessConfig: new SsmAccessConfigWriter({ client: ssm.client, ...PARAMETERS }),
    audit,
    deletions: createDeletionHarness({ audit, clock }).deletions,
    clock,
  });
  const guard = createAccessGuard({
    config: new SsmAccessConfigSource({ client: ssm.client, ...PARAMETERS }),
    apiKeys,
    counters: new InMemoryRateLimitCounterStore(),
    clock,
  });
  const put = (path: string, body: unknown): AdminRequest => ({
    httpMethod: 'PUT',
    path,
    body: JSON.stringify(body),
    requestContext: { identity: { userArn: ADMIN } },
  });
  return { handler, guard, put, ssm, at: (offsetMs: number) => (now = T0 + offsetMs) };
}

const JUST_BEFORE = ACCESS_CACHE_TTL_MS - 1; // 59.999 s

describe('Admin changes take effect after the 60-s cache (Req 17.9)', () => {
  // In every case the guard loads its cache at T0 and the admin change lands at the same
  // instant — the worst case, in which the old value is served longest.

  it('PUT /admin/rate-limit: old global limit below 60 s, new one from 60 s', async () => {
    const { handler, guard, put, ssm, at } = setup('open', HOUR);
    await expect(guard.admit({ sourceIp: 'a' })).resolves.toMatchObject({ ok: true });

    const res = await handler(put('/admin/rate-limit', { requests: 3, windowSeconds: 3600 }));
    expect(res.statusCode).toBe(200);
    expect(ssm.stored.get(PARAMETERS.rateLimitParameter)).toBe(
      '{"requests":3,"windowSeconds":3600}',
    );

    at(JUST_BEFORE);
    await expect(guard.admit({ sourceIp: 'a' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED', message: 'Rate limit of 1 requests per 3600 s exceeded' },
    });

    at(ACCESS_CACHE_TTL_MS);
    const admitted = [];
    for (let i = 0; i < 3; i += 1) admitted.push(await guard.admit({ sourceIp: 'a' }));
    // Same window, so the request from T0 still counts: 1 + 2 = 3.
    expect(admitted.map((r) => r.ok)).toEqual([true, true, false]);
    expect(admitted[0]).toMatchObject({
      value: { rateLimit: { requests: 3, windowSeconds: 3600 } },
    });
  });

  it('PUT /admin/access-mode open → api-keys: no key needed below 60 s, required from 60 s', async () => {
    const { handler, guard, put, ssm, at } = setup('open', { requests: 100, windowSeconds: 3600 });
    await expect(guard.admit({ sourceIp: 'a' })).resolves.toMatchObject({
      ok: true,
      value: { clientId: 'ip:a' },
    });

    const res = await handler(put('/admin/access-mode', { mode: 'api-keys' }));
    expect(res.statusCode).toBe(200);
    expect(ssm.stored.get(PARAMETERS.accessModeParameter)).toBe('api-keys');

    at(JUST_BEFORE);
    await expect(guard.admit({ sourceIp: 'a' })).resolves.toMatchObject({
      ok: true,
      value: { clientId: 'ip:a' },
    });

    at(ACCESS_CACHE_TTL_MS);
    await expect(guard.admit({ sourceIp: 'a' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'API_KEY_MISSING' },
    });
    await expect(
      guard.admit({ sourceIp: 'a', authorization: `Bearer ${KEY}` }),
    ).resolves.toMatchObject({ ok: true, value: { clientId: 'key:k-1', keyId: 'k-1' } });
  });

  it('PUT /admin/access-mode api-keys → open: key required below 60 s, not from 60 s', async () => {
    const { handler, guard, put, at } = setup('api-keys', { requests: 100, windowSeconds: 3600 });
    await expect(guard.admit({ sourceIp: 'a' })).resolves.toMatchObject({
      error: { code: 'API_KEY_MISSING' },
    });

    expect((await handler(put('/admin/access-mode', { mode: 'open' }))).statusCode).toBe(200);

    at(JUST_BEFORE);
    await expect(guard.admit({ sourceIp: 'a' })).resolves.toMatchObject({
      error: { code: 'API_KEY_MISSING' },
    });

    at(ACCESS_CACHE_TTL_MS);
    await expect(guard.admit({ sourceIp: 'a' })).resolves.toMatchObject({
      ok: true,
      value: { clientId: 'ip:a' },
    });
  });

  it('PUT /admin/api-keys/{keyId}/rate-limit: old key limit below 60 s, new one from 60 s', async () => {
    const { handler, guard, put, at } = setup(
      'api-keys',
      { requests: 100, windowSeconds: 3600 },
      HOUR,
    );
    const auth = { sourceIp: 'a', authorization: `Bearer ${KEY}` };
    await expect(guard.admit(auth)).resolves.toMatchObject({
      ok: true,
      value: { rateLimit: HOUR },
    });

    const res = await handler(
      put('/admin/api-keys/k-1/rate-limit', { requests: 3, windowSeconds: 3600 }),
    );
    expect(res.statusCode).toBe(200);

    at(JUST_BEFORE);
    await expect(guard.admit(auth)).resolves.toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED', message: 'Rate limit of 1 requests per 3600 s exceeded' },
    });

    at(ACCESS_CACHE_TTL_MS);
    const admitted = [];
    for (let i = 0; i < 3; i += 1) admitted.push(await guard.admit(auth));
    expect(admitted.map((r) => r.ok)).toEqual([true, true, false]);
    expect(admitted[0]).toMatchObject({
      value: { rateLimit: { requests: 3, windowSeconds: 3600 } },
    });
  });
});
