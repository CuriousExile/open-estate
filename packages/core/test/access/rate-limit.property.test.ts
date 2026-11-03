// Feature: real-estate-platform, Property 36: Rate-Limit begrenzt zugelassene Anfragen
import {
  createAccessGuard,
  hashApiKey,
  InMemoryApiKeyStore,
  InMemoryRateLimitCounterStore,
  StaticAccessConfigSource,
  type AccessConfig,
  type AccessGuard,
  type AccessMode,
  type ApiKeyRecord,
  type RateLimit,
} from '@open-estate/core';
import fc from 'fast-check';

/**
 * Property 36: for any sequence of requests spread over Search_API and MCP_Server (two guard
 * instances sharing counter store, config source and simulated clock) and any limit (N, W),
 * global or per API key, at most N requests per client and window are admitted. Every further
 * request gets `RATE_LIMITED` with `retryAfterSeconds` ≥ 1 reaching exactly to the window end,
 * and rejections leave the counters unchanged. The config is not changed during a run, so the
 * 60 s config/key cache does not affect the outcome.
 *
 * **Validates: Requirements 17.1, 17.2, 17.3, 17.6**
 */

const IPS = ['198.51.100.1', '198.51.100.2', '203.0.113.9'];

interface KeyCase {
  keyId: string;
  plain: string;
  rateLimit?: RateLimit;
}

interface RequestCase {
  /** 0 = Search_API guard, 1 = MCP_Server guard. */
  adapter: 0 | 1;
  /** Index into IPS (open) or the keys (api-keys). */
  client: number;
  /** IP sent along in api-keys mode; must not influence the client identity. */
  ip: number;
  /** Clock advance before this request (monotonic). */
  stepMs: number;
}

interface Scenario {
  mode: AccessMode;
  global: RateLimit;
  keys: KeyCase[];
  startMs: number;
  requests: RequestCase[];
}

const arbLimit: fc.Arbitrary<RateLimit> = fc.record({
  requests: fc.integer({ min: 1, max: 20 }),
  windowSeconds: fc.integer({ min: 1, max: 120 }),
});

const arbKeys: fc.Arbitrary<KeyCase[]> = fc
  .array(fc.option(arbLimit, { nil: undefined }), { minLength: 1, maxLength: 3 })
  .map((limits) =>
    limits.map((rateLimit, i) => ({
      keyId: `k${i}`,
      plain: `plain-key-${i}`,
      ...(rateLimit === undefined ? {} : { rateLimit }),
    })),
  );

/** Mostly bursts inside one window, sometimes jumps across one or more windows. */
const arbStep = fc.oneof(
  { weight: 3, arbitrary: fc.constant(0) },
  { weight: 4, arbitrary: fc.integer({ min: 1, max: 2_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: 2_001, max: 150_000 }) },
);

const arbScenario: fc.Arbitrary<Scenario> = fc
  .record({
    mode: fc.constantFrom<AccessMode>('open', 'api-keys'),
    global: arbLimit,
    keys: arbKeys,
    // Arbitrary start, not aligned to any window.
    startMs: fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 0, 1) }),
  })
  .chain((base) => {
    const clients = base.mode === 'open' ? IPS.length : base.keys.length;
    const arbRequest: fc.Arbitrary<RequestCase> = fc.record({
      adapter: fc.constantFrom<0 | 1>(0, 1),
      client: fc.integer({ min: 0, max: clients - 1 }),
      ip: fc.integer({ min: 0, max: IPS.length - 1 }),
      stepMs: arbStep,
    });
    return fc
      .array(arbRequest, { minLength: 1, maxLength: 80 })
      .map((requests) => ({ ...base, requests }));
  });

function setup(s: Scenario) {
  let now = s.startMs;
  const clock = () => now;
  const config: AccessConfig = { mode: s.mode, rateLimit: s.global };
  const source = new StaticAccessConfigSource(config);
  const records: ApiKeyRecord[] = s.keys.map((k) => ({
    keyId: k.keyId,
    keyHash: hashApiKey(k.plain),
    status: 'active',
    ...(k.rateLimit === undefined ? {} : { rateLimit: k.rateLimit }),
  }));
  const apiKeys = new InMemoryApiKeyStore(records);
  const counters = new InMemoryRateLimitCounterStore();
  // One guard per adapter; everything else is shared, as in API and MCP Lambda.
  const guards: [AccessGuard, AccessGuard] = [
    createAccessGuard({ config: source, apiKeys, counters, clock }),
    createAccessGuard({ config: source, apiKeys, counters, clock }),
  ];
  return { guards, counters, advance: (ms: number) => (now += ms), clock };
}

describe('Property 36: Rate-Limit begrenzt zugelassene Anfragen', () => {
  it('admits at most N requests per client and window across API and MCP', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (s) => {
        const { guards, counters, advance, clock } = setup(s);
        // Reference model: admissions per counter key `clientId#windowStartSec`.
        const model = new Map<string, number>();

        for (const r of s.requests) {
          advance(r.stepMs);
          const now = clock();

          const key = s.mode === 'api-keys' ? s.keys[r.client] : undefined;
          const clientId = key === undefined ? `ip:${IPS[r.client]}` : `key:${key.keyId}`;
          const limit = key?.rateLimit ?? s.global;
          const windowMs = limit.windowSeconds * 1000;
          const windowStartMs = Math.floor(now / windowMs) * windowMs;
          const windowEndMs = windowStartMs + windowMs;
          const counterKey = `${clientId}#${windowStartMs / 1000}`;
          const before = model.get(counterKey) ?? 0;

          const result = await guards[r.adapter].admit({
            sourceIp: key === undefined ? (IPS[r.client] as string) : (IPS[r.ip] as string),
            authorization: key === undefined ? undefined : `Bearer ${key.plain}`,
          });

          if (before < limit.requests) {
            expect(result.ok).toBe(true);
            if (result.ok) {
              expect(result.value.clientId).toBe(clientId);
              expect(result.value.rateLimit).toEqual(limit);
            }
            model.set(counterKey, before + 1);
          } else {
            expect(result.ok).toBe(false);
            if (!result.ok) {
              expect(result.error.code).toBe('RATE_LIMITED');
              const retry = result.error.details?.['retryAfterSeconds'];
              expect(retry).toBe(Math.max(1, Math.ceil((windowEndMs - now) / 1000)));
              expect(retry).toBeGreaterThanOrEqual(1);
              // Waiting `retry` seconds reaches the window end, one second less does not.
              expect(now + (retry as number) * 1000).toBeGreaterThanOrEqual(windowEndMs);
              expect(now + ((retry as number) - 1) * 1000).toBeLessThan(windowEndMs);
            }
          }

          // The store matches the model exactly: admissions count, rejections change nothing,
          // and no window ever holds more than N.
          for (const [k, count] of model) {
            expect(counters.count(k)).toBe(count);
          }
          expect(counters.count(counterKey)).toBeLessThanOrEqual(limit.requests);
        }
      }),
      { numRuns: 100 },
    );
  });
});
