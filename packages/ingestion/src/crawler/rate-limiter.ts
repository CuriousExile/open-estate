import {
  MAX_RATE_PER_SECOND,
  MIN_RATE_PER_SECOND,
  normalizeOrigin,
} from '../compliance/crawler-allowlist';

/** Time source of the rate limiter; injectable so tests can use virtual time. */
export interface Clock {
  /** Current time in milliseconds. */
  now(): number;
  /** Resolves after (at least) `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Rate for allowlist targets without `ratePerSecond`: one request per second,
 * a conservative crawl-delay that stays well inside [0.1; 100] (Req 6.5).
 */
export const DEFAULT_CRAWL_RATE_PER_SECOND = 1;

export interface OriginRateLimiterOptions {
  /**
   * Rate lookup per normalized origin; `undefined` falls back to the default.
   * Evaluated on every `acquire`, so its result is validated there.
   * Mutually exclusive with `rates`.
   */
  readonly rateFor?: (origin: string) => number | undefined;
  /** Static rates keyed by origin (normalized on creation). Mutually exclusive with `rateFor`. */
  readonly rates?: Readonly<Record<string, number>>;
  readonly defaultRatePerSecond?: number;
  readonly clock?: Clock;
}

export interface OriginRateLimiter {
  /**
   * Resolves once at least `1000 / r` ms have passed since the previously
   * reserved request to the same origin, and reserves that slot. Rejects for
   * a non-http(s) URL or an invalid rate without reserving a slot.
   */
  acquire(url: string): Promise<void>;
}

function assertValidRate(rate: number, label: string): void {
  if (!Number.isFinite(rate) || rate < MIN_RATE_PER_SECOND || rate > MAX_RATE_PER_SECOND) {
    throw new RangeError(
      `${label}: rate ${rate} req/s outside [${MIN_RATE_PER_SECOND}; ${MAX_RATE_PER_SECOND}]`,
    );
  }
}

/**
 * Per-origin rate limiter enforcing a minimum spacing of `1/r` s between
 * consecutive requests to the same origin (Req 6.5).
 *
 * The next free slot of an origin is reserved synchronously before waiting,
 * so concurrent `acquire` calls for one origin are serialized in call order;
 * different origins never block each other.
 *
 * Validation: the default and static `rates` are known up front and rejected
 * on creation (fail fast on misconfiguration); `rateFor` results can only be
 * checked when looked up, so an invalid one rejects that `acquire`.
 */
export function createOriginRateLimiter(options: OriginRateLimiterOptions = {}): OriginRateLimiter {
  if (options.rateFor !== undefined && options.rates !== undefined) {
    throw new Error('rateFor and rates are mutually exclusive');
  }
  const clock = options.clock ?? systemClock;
  const defaultRate = options.defaultRatePerSecond ?? DEFAULT_CRAWL_RATE_PER_SECOND;
  assertValidRate(defaultRate, 'defaultRatePerSecond');

  let rateFor = options.rateFor;
  if (options.rates !== undefined) {
    const rates = new Map<string, number>();
    for (const [key, rate] of Object.entries(options.rates)) {
      const origin = normalizeOrigin(key);
      if (origin === undefined) throw new Error(`rates: "${key}" is not an http(s) origin`);
      if (rates.has(origin)) throw new Error(`rates: duplicate origin "${origin}"`);
      assertValidRate(rate, `rates["${key}"]`);
      rates.set(origin, rate);
    }
    rateFor = (origin) => rates.get(origin);
  }

  /** Earliest start time (ms) of the next request per origin. */
  const nextSlotAt = new Map<string, number>();

  return {
    async acquire(url) {
      const origin = normalizeOrigin(url);
      if (origin === undefined) throw new TypeError(`"${url}" is not an http(s) URL`);
      const rate = rateFor?.(origin) ?? defaultRate;
      assertValidRate(rate, origin);

      // Reserve before the first await so concurrent calls queue up.
      const start = Math.max(clock.now(), nextSlotAt.get(origin) ?? -Infinity);
      nextSlotAt.set(origin, start + 1000 / rate);

      // Loop guards against timers firing early or coarse clock resolution.
      for (let now = clock.now(); now < start; now = clock.now()) {
        await clock.sleep(start - now);
      }
    },
  };
}
