// Feature: real-estate-platform, Property 21: Einhaltung der Abrufrate
import fc from 'fast-check';
import {
  MAX_RATE_PER_SECOND,
  MIN_RATE_PER_SECOND,
  createOriginRateLimiter,
} from '@open-estate/ingestion';
import { createFakeClock } from './support/fake-clock';

/**
 * Property 21: for any rate r ∈ [0.1; 100] and any sequence of requests to
 * the same origin (virtual time), two consecutive requests are at least 1/r s
 * apart. Additionally: concurrent acquires for one origin are granted in call
 * order, and origins do not influence each other (no unnecessary waiting).
 *
 * Floating point: slots accumulate `start + 1000 / r` with arbitrary doubles,
 * so spacings are compared with a tolerance of EPSILON_MS = 1e-6 ms — many
 * orders of magnitude above the rounding error at the reachable time scale
 * (< 10^6 ms, ulp ≈ 1e-10 ms) and far below any meaningful spacing (≥ 10 ms).
 *
 * **Validates: Requirements 6.5**
 */

const EPSILON_MS = 1e-6;

/** Origins with equivalent spellings; all spellings of one key share one rate slot. */
const ORIGINS: Readonly<Record<string, readonly string[]>> = {
  'https://a.example': [
    'https://a.example/listings',
    'HTTPS://A.EXAMPLE/expose/1',
    'https://a.example:443/?page=2',
    'https://user@a.example/x#frag',
  ],
  'http://a.example': ['http://a.example/', 'http://A.example:80/list'],
  'http://b.example:8080': ['http://b.example:8080/a', 'HTTP://B.EXAMPLE:8080/b?q=1'],
  'https://c.example': ['https://c.example', 'https://C.example/'],
};
const ORIGIN_KEYS = Object.keys(ORIGINS);

const rateArb = fc.oneof(
  fc.constantFrom(MIN_RATE_PER_SECOND, MAX_RATE_PER_SECOND, 0.5, 1, 2, 4, 10),
  fc.double({ min: MIN_RATE_PER_SECOND, max: MAX_RATE_PER_SECOND, noNaN: true }),
);

const callArb = fc.record({
  origin: fc.constantFrom(...ORIGIN_KEYS),
  spelling: fc.nat(),
});

type Step =
  { kind: 'batch'; calls: { origin: string; spelling: number }[] } | { kind: 'pause'; ms: number };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant('batch' as const),
    calls: fc.array(callArb, { minLength: 1, maxLength: 6 }),
  }),
  fc.record({ kind: fc.constant('pause' as const), ms: fc.integer({ min: 0, max: 20_000 }) }),
);

const scenarioArb = fc.record({
  /** Rate per origin; origins without an entry use the default rate. */
  rates: fc.dictionary(fc.constantFrom(...ORIGIN_KEYS), rateArb),
  defaultRate: rateArb,
  steps: fc.array(stepArb, { minLength: 1, maxLength: 8 }),
});

interface Grant {
  readonly origin: string;
  readonly calledAt: number;
  readonly grantedAt: number;
}

describe('Property 21: Einhaltung der Abrufrate', () => {
  it('spaces requests per origin by ≥ 1/r, in call order, without cross-origin waiting', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ rates, defaultRate, steps }) => {
        const clock = createFakeClock();
        // Key the static rates by a non-canonical spelling to exercise normalization.
        const rateConfig = Object.fromEntries(
          Object.entries(rates).map(([origin, rate]) => [origin.toUpperCase() + '/', rate]),
        );
        const limiter = createOriginRateLimiter({
          rates: rateConfig,
          defaultRatePerSecond: defaultRate,
          clock,
        });
        const rateOf = (origin: string): number => rates[origin] ?? defaultRate;

        // Grants per origin in call order.
        const grants = new Map<string, Grant[]>();
        for (const step of steps) {
          if (step.kind === 'pause') {
            await clock.sleep(step.ms);
            continue;
          }
          const pending = step.calls.map(({ origin, spelling }) => {
            const spellings = ORIGINS[origin] ?? [];
            const url = spellings[spelling % spellings.length] ?? origin;
            const calledAt = clock.now();
            const list = grants.get(origin) ?? [];
            grants.set(origin, list);
            const index = list.length;
            list.push({ origin, calledAt, grantedAt: Number.NaN });
            return limiter.acquire(url).then(() => {
              list[index] = { origin, calledAt, grantedAt: clock.now() };
            });
          });
          await Promise.all(pending);
        }

        for (const [origin, list] of grants) {
          const spacing = 1000 / rateOf(origin);
          list.forEach((grant, i) => {
            const previous = list[i - 1];
            if (previous === undefined) {
              // First request to an origin is never delayed, whatever other origins do.
              expect(grant.grantedAt).toBe(grant.calledAt);
              return;
            }
            // Minimum spacing (Req 6.5) — also implies call order is preserved.
            expect(grant.grantedAt - previous.grantedAt).toBeGreaterThanOrEqual(
              spacing - EPSILON_MS,
            );
            // No unnecessary waiting: granted as soon as both the call and the slot allow.
            const earliest = Math.max(grant.calledAt, previous.grantedAt + spacing);
            expect(Math.abs(grant.grantedAt - earliest)).toBeLessThanOrEqual(EPSILON_MS);
          });
        }
      }),
      { numRuns: 100 },
    );
  });
});
