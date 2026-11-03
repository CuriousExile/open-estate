// Feature: real-estate-platform, Property 37: API-Key-Prüfung
import {
  createAccessGuard,
  hashApiKey,
  InMemoryApiKeyStore,
  InMemoryRateLimitCounterStore,
  StaticAccessConfigSource,
  type ApiKeyRecord,
} from '@open-estate/core';
import fc from 'fast-check';

/**
 * Property 37: with key-based access enabled, a request is admitted iff it carries an
 * active, non-expired key (expired from `now >= expiresAt` on), with clientId `key:<keyId>`;
 * otherwise the code is `API_KEY_MISSING` (no/blank header) or `API_KEY_INVALID` (anything
 * else). Search_API and MCP_Server share the guard, so two guard instances over the same
 * stores must return identical results.
 *
 * **Validates: Requirements 17.4, 17.5, 17.7**
 */

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const DAY_MS = 86_400_000;
// High enough that rate limiting never interferes (≤ 2 × 40 requests per run).
const RATE_LIMIT = { requests: 10_000, windowSeconds: 3_600 };

type Expiry = 'none' | 'past' | 'now' | 'future';

interface KeySpec {
  keyId: string;
  token: string;
  status: ApiKeyRecord['status'];
  expiry: Expiry;
  offsetMs: number;
}

type RequestSpec =
  | { kind: 'missing' }
  | { kind: 'blank'; header: string }
  | { kind: 'nonBearer'; header: string }
  | { kind: 'bearerNoToken'; header: string }
  | { kind: 'unknown'; header: string }
  | { kind: 'known'; key: KeySpec; header: string };

const tokenArb = fc.stringMatching(/^[A-Za-z0-9._~+/-]{1,32}$/);
const wsArb = fc.stringMatching(/^[ \t]{1,3}$/);
const optWsArb = fc.stringMatching(/^[ \t]{0,2}$/);
/** `Bearer` in random letter case (the scheme is case-insensitive). */
const schemeArb = fc
  .array(fc.boolean(), { minLength: 6, maxLength: 6 })
  .map((upper) => [...'bearer'].map((c, i) => (upper[i] ? c.toUpperCase() : c)).join(''));

const keySpecArb: fc.Arbitrary<Omit<KeySpec, 'keyId'>> = fc.record({
  // `k` prefix keeps known tokens disjoint from the `u`-prefixed unknown ones.
  token: tokenArb.map((t) => `k${t}`),
  status: fc.constantFrom('active' as const, 'revoked' as const),
  expiry: fc.constantFrom<Expiry>('none', 'past', 'now', 'future'),
  offsetMs: fc.integer({ min: 1, max: 365 * DAY_MS }),
});

const bearerHeader = (token: string) =>
  fc
    .tuple(schemeArb, wsArb, optWsArb)
    .map(([scheme, sep, trail]) => `${scheme}${sep}${token}${trail}`);

function requestArb(keys: readonly KeySpec[]): fc.Arbitrary<RequestSpec> {
  const options: fc.Arbitrary<RequestSpec>[] = [
    fc.constant({ kind: 'missing' }),
    fc.constantFrom('', ' ', '\t', '  \t ').map((header) => ({ kind: 'blank', header })),
    fc
      .tuple(fc.constantFrom('Basic', 'Token', 'ApiKey', 'Bearer:', 'Bearerx'), wsArb, tokenArb)
      .map(([scheme, sep, token]) => ({ kind: 'nonBearer', header: `${scheme}${sep}${token}` })),
    tokenArb.map((token) => ({ kind: 'nonBearer', header: `k${token}` })),
    fc
      .tuple(schemeArb, optWsArb)
      .map(([scheme, trail]) => ({ kind: 'bearerNoToken', header: `${scheme}${trail}` })),
    tokenArb.chain((token) =>
      bearerHeader(`u${token}`).map((header) => ({ kind: 'unknown', header })),
    ),
  ];
  if (keys.length > 0) {
    options.push(
      fc
        .constantFrom(...keys)
        .chain((key) => bearerHeader(key.token).map((header) => ({ kind: 'known', key, header }))),
    );
  }
  return fc.oneof(...options);
}

function expiresAt(spec: KeySpec): string | undefined {
  switch (spec.expiry) {
    case 'none':
      return undefined;
    case 'past':
      return new Date(T0 - spec.offsetMs).toISOString();
    case 'now':
      return new Date(T0).toISOString(); // boundary: `now >= expiresAt` is expired
    case 'future':
      return new Date(T0 + spec.offsetMs).toISOString();
  }
}

type Expected = { admitted: string } | { code: 'API_KEY_MISSING' | 'API_KEY_INVALID' };

/** Reference model, derived from the generated request kind and key state only. */
function expected(req: RequestSpec): Expected {
  switch (req.kind) {
    case 'missing':
    case 'blank':
      return { code: 'API_KEY_MISSING' };
    case 'known': {
      const { keyId, status, expiry } = req.key;
      const valid = status === 'active' && (expiry === 'none' || expiry === 'future');
      return valid ? { admitted: `key:${keyId}` } : { code: 'API_KEY_INVALID' };
    }
    default:
      return { code: 'API_KEY_INVALID' };
  }
}

const scenarioArb = fc
  .uniqueArray(keySpecArb, { maxLength: 8, selector: (k) => k.token })
  .map((specs) => specs.map((spec, i) => ({ ...spec, keyId: `k${i}` })))
  .chain((keys) =>
    fc.record({
      keys: fc.constant(keys),
      requests: fc.array(requestArb(keys), { minLength: 1, maxLength: 40 }),
    }),
  );

describe('Property 37: API-Key-Prüfung', () => {
  it('admits exactly requests with an active, non-expired key, identically for API and MCP', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ keys, requests }) => {
        const config = new StaticAccessConfigSource({ mode: 'api-keys', rateLimit: RATE_LIMIT });
        const apiKeys = new InMemoryApiKeyStore();
        for (const key of keys) {
          const exp = expiresAt(key);
          apiKeys.put({
            keyId: key.keyId,
            keyHash: hashApiKey(key.token),
            status: key.status,
            ...(exp === undefined ? {} : { expiresAt: exp }),
          });
        }
        const counters = new InMemoryRateLimitCounterStore();
        const clock = () => T0;
        const searchApi = createAccessGuard({ config, apiKeys, counters, clock });
        const mcpServer = createAccessGuard({ config, apiKeys, counters, clock });

        for (const req of requests) {
          const authorization = req.kind === 'missing' ? undefined : req.header;
          const input = { sourceIp: '203.0.113.7', authorization };
          const fromApi = await searchApi.admit(input);
          const fromMcp = await mcpServer.admit(input);
          expect(fromMcp).toEqual(fromApi);

          const want = expected(req);
          if ('admitted' in want) {
            expect(fromApi.ok).toBe(true);
            if (fromApi.ok) {
              expect(fromApi.value.clientId).toBe(want.admitted);
              expect(fromApi.value.keyId).toBe(want.admitted.slice('key:'.length));
            }
          } else {
            expect(fromApi.ok).toBe(false);
            if (!fromApi.ok) expect(fromApi.error.code).toBe(want.code);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
