import {
  createAccessGuard,
  hashApiKey,
  InMemoryApiKeyStore,
  InMemoryRateLimitCounterStore,
  retryAfterSeconds,
  StaticAccessConfigSource,
  type AccessConfig,
  type ApiKeyRecord,
  type ApiKeyStore,
  type RateLimitCounterStore,
} from '@open-estate/core';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0); // multiple of every window length used below
const KEY = 'secret-key-1';

const activeKey = (overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord => ({
  keyId: 'k1',
  keyHash: hashApiKey(KEY),
  status: 'active',
  ...overrides,
});

function setup(config: AccessConfig, keys: ApiKeyRecord[] = []) {
  let now = T0;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  const source = new StaticAccessConfigSource(config);
  const apiKeys = new InMemoryApiKeyStore(keys);
  const counters = new InMemoryRateLimitCounterStore();
  const guard = createAccessGuard({ config: source, apiKeys, counters, clock: clock.now });
  return { guard, clock, source, apiKeys, counters };
}

const open = (requests = 60, windowSeconds = 60): AccessConfig => ({
  mode: 'open',
  rateLimit: { requests, windowSeconds },
});
const keyed = (requests = 60, windowSeconds = 60): AccessConfig => ({
  mode: 'api-keys',
  rateLimit: { requests, windowSeconds },
});
const bearer = (key: string) => `Bearer ${key}`;

describe('AccessGuard', () => {
  describe('client identity', () => {
    it('identifies clients by source IP in open mode and ignores Authorization', async () => {
      const { guard } = setup(open());
      await expect(
        guard.admit({ sourceIp: '203.0.113.7', authorization: 'garbage' }),
      ).resolves.toEqual({
        ok: true,
        value: { clientId: 'ip:203.0.113.7', rateLimit: { requests: 60, windowSeconds: 60 } },
      });
    });

    it('identifies clients by key id in api-keys mode', async () => {
      const { guard } = setup(keyed(), [activeKey()]);
      const result = await guard.admit({ sourceIp: '203.0.113.7', authorization: bearer(KEY) });
      expect(result).toEqual({
        ok: true,
        value: { clientId: 'key:k1', keyId: 'k1', rateLimit: { requests: 60, windowSeconds: 60 } },
      });
    });

    it('accepts the Bearer scheme case-insensitively', async () => {
      const { guard } = setup(keyed(), [activeKey()]);
      await expect(
        guard.admit({ sourceIp: 'x', authorization: `bearer ${KEY}` }),
      ).resolves.toMatchObject({ ok: true });
    });

    it('counts the same key from different IPs against one limit', async () => {
      const { guard } = setup(keyed(1), [activeKey()]);
      await guard.admit({ sourceIp: '1.1.1.1', authorization: bearer(KEY) });
      await expect(
        guard.admit({ sourceIp: '2.2.2.2', authorization: bearer(KEY) }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
    });
  });

  describe('key check', () => {
    it.each([undefined, '', '   '])(
      'rejects a missing key (%p) with API_KEY_MISSING',
      async (auth) => {
        const { guard } = setup(keyed(), [activeKey()]);
        await expect(guard.admit({ sourceIp: 'x', authorization: auth })).resolves.toMatchObject({
          ok: false,
          error: { code: 'API_KEY_MISSING' },
        });
      },
    );

    it.each([
      ['unknown key', [activeKey()], bearer('other')],
      ['revoked key', [activeKey({ status: 'revoked' })], bearer(KEY)],
      ['expired key', [activeKey({ expiresAt: new Date(T0).toISOString() })], bearer(KEY)],
      ['non-Bearer scheme', [activeKey()], `Basic ${KEY}`],
      ['Bearer without token', [activeKey()], 'Bearer'],
    ])('rejects %s with API_KEY_INVALID', async (_name, keys, authorization) => {
      const { guard } = setup(keyed(), keys);
      await expect(guard.admit({ sourceIp: 'x', authorization })).resolves.toMatchObject({
        ok: false,
        error: { code: 'API_KEY_INVALID' },
      });
    });

    it('accepts a key until its expiry instant', async () => {
      const { guard, clock } = setup(keyed(), [
        activeKey({ expiresAt: new Date(T0 + 1000).toISOString() }),
      ]);
      await expect(
        guard.admit({ sourceIp: 'x', authorization: bearer(KEY) }),
      ).resolves.toMatchObject({ ok: true });
      clock.advance(1000);
      await expect(
        guard.admit({ sourceIp: 'x', authorization: bearer(KEY) }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'API_KEY_INVALID' } });
    });

    it('looks keys up by SHA-256 hash only, never by plain key', async () => {
      const findByHash = jest.fn<ReturnType<ApiKeyStore['findByHash']>, [string]>(async () => null);
      const guard = createAccessGuard({
        config: new StaticAccessConfigSource(keyed()),
        apiKeys: { findByHash },
        counters: new InMemoryRateLimitCounterStore(),
        clock: () => T0,
      });
      await guard.admit({ sourceIp: 'x', authorization: bearer(KEY) });
      expect(findByHash).toHaveBeenCalledWith(
        // SHA-256("secret-key-1")
        hashApiKey(KEY),
      );
      expect(hashApiKey('abc')).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    });
  });

  describe('order: access mode → key check → rate limit', () => {
    it('does not touch counters when the key check fails', async () => {
      const tryIncrement = jest.fn<ReturnType<RateLimitCounterStore['tryIncrement']>, never>();
      const guard = createAccessGuard({
        config: new StaticAccessConfigSource(keyed()),
        apiKeys: new InMemoryApiKeyStore(),
        counters: { tryIncrement },
        clock: () => T0,
      });
      await guard.admit({ sourceIp: 'x' });
      await guard.admit({ sourceIp: 'x', authorization: bearer('unknown') });
      expect(tryIncrement).not.toHaveBeenCalled();
    });

    it('does not look up keys in open mode', async () => {
      const findByHash = jest.fn();
      const guard = createAccessGuard({
        config: new StaticAccessConfigSource(open()),
        apiKeys: { findByHash },
        counters: new InMemoryRateLimitCounterStore(),
        clock: () => T0,
      });
      await guard.admit({ sourceIp: 'x', authorization: bearer(KEY) });
      expect(findByHash).not.toHaveBeenCalled();
    });
  });

  describe('rate limit', () => {
    it('admits exactly N requests per window and rejects the rest', async () => {
      const { guard, counters } = setup(open(3, 60));
      const results = [];
      for (let i = 0; i < 5; i++) results.push(await guard.admit({ sourceIp: 'a' }));
      expect(results.map((r) => r.ok)).toEqual([true, true, true, false, false]);
      expect(counters.count(`ip:a#${T0 / 1000}`)).toBe(3); // rejected requests are not counted
    });

    it('keeps clients independent', async () => {
      const { guard } = setup(open(1, 60));
      await expect(guard.admit({ sourceIp: 'a' })).resolves.toMatchObject({ ok: true });
      await expect(guard.admit({ sourceIp: 'b' })).resolves.toMatchObject({ ok: true });
      await expect(guard.admit({ sourceIp: 'a' })).resolves.toMatchObject({ ok: false });
    });

    it('reports RATE_LIMITED with retryAfterSeconds until the window end', async () => {
      const { guard, clock } = setup(open(1, 60));
      await guard.admit({ sourceIp: 'a' });
      clock.advance(20_500);
      await expect(guard.admit({ sourceIp: 'a' })).resolves.toEqual({
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'Rate limit of 1 requests per 60 s exceeded',
          details: { retryAfterSeconds: 40 }, // ceil(39.5)
        },
      });
    });

    it('reports at least 1 second shortly before the window end', async () => {
      const { guard, clock } = setup(open(1, 60));
      await guard.admit({ sourceIp: 'a' });
      clock.advance(59_999);
      await expect(guard.admit({ sourceIp: 'a' })).resolves.toMatchObject({
        error: { details: { retryAfterSeconds: 1 } },
      });
      expect(retryAfterSeconds(1000, 1000)).toBe(1);
    });

    it('admits again in the next window', async () => {
      const { guard, clock } = setup(open(2, 10));
      await guard.admit({ sourceIp: 'a' });
      await guard.admit({ sourceIp: 'a' });
      clock.advance(9_999);
      await expect(guard.admit({ sourceIp: 'a' })).resolves.toMatchObject({ ok: false });
      clock.advance(1);
      await expect(guard.admit({ sourceIp: 'a' })).resolves.toMatchObject({ ok: true });
      await expect(guard.admit({ sourceIp: 'a' })).resolves.toMatchObject({ ok: true });
      await expect(guard.admit({ sourceIp: 'a' })).resolves.toMatchObject({ ok: false });
    });

    it('passes counter key, limit and window end (TTL) to the counter store', async () => {
      const tryIncrement = jest.fn(async () => true);
      const guard = createAccessGuard({
        config: new StaticAccessConfigSource(open(5, 30)),
        apiKeys: new InMemoryApiKeyStore(),
        counters: { tryIncrement },
        clock: () => T0 + 45_000,
      });
      await guard.admit({ sourceIp: 'a' });
      const windowStart = T0 / 1000 + 30;
      expect(tryIncrement).toHaveBeenCalledWith({
        counterKey: `ip:a#${windowStart}`,
        limit: 5,
        expiresAtEpochSeconds: windowStart + 30,
      });
    });

    it('applies the key limit instead of the global limit', async () => {
      const { guard } = setup(keyed(1, 60), [
        activeKey({ rateLimit: { requests: 3, windowSeconds: 10 } }),
      ]);
      const results = [];
      for (let i = 0; i < 4; i++) {
        results.push(await guard.admit({ sourceIp: 'x', authorization: bearer(KEY) }));
      }
      expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
      expect(results[0]).toMatchObject({
        value: { rateLimit: { requests: 3, windowSeconds: 10 } },
      });
      expect(results[3]).toMatchObject({ error: { details: { retryAfterSeconds: 10 } } });
    });

    it('applies the global limit to keys without own limit', async () => {
      const { guard } = setup(keyed(2, 60), [activeKey()]);
      const results = [];
      for (let i = 0; i < 3; i++) {
        results.push(await guard.admit({ sourceIp: 'x', authorization: bearer(KEY) }));
      }
      expect(results.map((r) => r.ok)).toEqual([true, true, false]);
    });
  });

  describe('60-second cache (Req 17.9)', () => {
    it('applies a changed global limit after the cache expires', async () => {
      const { guard, clock, source } = setup(open(1, 3600));
      await guard.admit({ sourceIp: 'a' });
      source.set(open(5, 3600));
      clock.advance(59_999);
      await expect(guard.admit({ sourceIp: 'a' })).resolves.toMatchObject({ ok: false });
      clock.advance(1);
      await expect(guard.admit({ sourceIp: 'a' })).resolves.toMatchObject({
        ok: true,
        value: { rateLimit: { requests: 5 } },
      });
    });

    it('applies a changed access mode after the cache expires', async () => {
      const { guard, clock, source } = setup(open());
      await expect(guard.admit({ sourceIp: 'a' })).resolves.toMatchObject({ ok: true });
      source.set(keyed());
      clock.advance(59_999);
      await expect(guard.admit({ sourceIp: 'a' })).resolves.toMatchObject({ ok: true });
      clock.advance(1);
      await expect(guard.admit({ sourceIp: 'a' })).resolves.toMatchObject({
        ok: false,
        error: { code: 'API_KEY_MISSING' },
      });
    });

    it('applies changed key records (limit, revocation) after the cache expires', async () => {
      const { guard, clock, apiKeys } = setup(keyed(100, 3600), [activeKey()]);
      const admit = () => guard.admit({ sourceIp: 'x', authorization: bearer(KEY) });
      await expect(admit()).resolves.toMatchObject({ value: { rateLimit: { requests: 100 } } });

      apiKeys.put(activeKey({ rateLimit: { requests: 7, windowSeconds: 3600 } }));
      clock.advance(59_999);
      await expect(admit()).resolves.toMatchObject({ value: { rateLimit: { requests: 100 } } });
      clock.advance(1);
      await expect(admit()).resolves.toMatchObject({ value: { rateLimit: { requests: 7 } } });

      apiKeys.put(activeKey({ status: 'revoked' }));
      clock.advance(60_000);
      await expect(admit()).resolves.toMatchObject({ error: { code: 'API_KEY_INVALID' } });
    });

    it('loads the config only once per cache period', async () => {
      const load = jest.fn(async () => open());
      let now = T0;
      const guard = createAccessGuard({
        config: { load },
        apiKeys: new InMemoryApiKeyStore(),
        counters: new InMemoryRateLimitCounterStore(),
        clock: () => now,
      });
      await guard.admit({ sourceIp: 'a' });
      now += 30_000;
      await guard.admit({ sourceIp: 'a' });
      expect(load).toHaveBeenCalledTimes(1);
      now += 30_000;
      await guard.admit({ sourceIp: 'a' });
      expect(load).toHaveBeenCalledTimes(2);
    });
  });
});
