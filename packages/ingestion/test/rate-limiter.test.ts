import {
  DEFAULT_CRAWL_RATE_PER_SECOND,
  MAX_RATE_PER_SECOND,
  MIN_RATE_PER_SECOND,
  createOriginRateLimiter,
  systemClock,
  type OriginRateLimiterOptions,
} from '@open-estate/ingestion';
import { createFakeClock } from './support/fake-clock';

/** Runs all acquires concurrently and returns the virtual time each one was granted. */
async function grantTimes(
  options: Omit<OriginRateLimiterOptions, 'clock'>,
  urls: readonly string[],
): Promise<number[]> {
  const clock = createFakeClock();
  const limiter = createOriginRateLimiter({ ...options, clock });
  return Promise.all(urls.map((url) => limiter.acquire(url).then(() => clock.now())));
}

describe('createOriginRateLimiter', () => {
  it('grants the first request to an origin immediately', async () => {
    const clock = createFakeClock(1_000);
    const limiter = createOriginRateLimiter({ clock });
    await limiter.acquire('https://a.example/listings');
    expect(clock.now()).toBe(1_000);
    expect(clock.sleeps).toEqual([]);
  });

  it('delays the next request to the same origin by at least 1/r seconds', async () => {
    const clock = createFakeClock();
    const limiter = createOriginRateLimiter({ defaultRatePerSecond: 2, clock });
    await limiter.acquire('https://a.example/1');
    await limiter.acquire('https://a.example/2');
    expect(clock.now()).toBe(500);
  });

  it('does not wait when the minimum spacing has already elapsed', async () => {
    const clock = createFakeClock();
    const limiter = createOriginRateLimiter({ clock });
    await limiter.acquire('https://a.example/1');
    await clock.sleep(5_000);
    await limiter.acquire('https://a.example/2');
    expect(clock.now()).toBe(5_000);
    expect(clock.sleeps).toEqual([5_000]);
  });

  it('serializes concurrent acquires for one origin in call order', async () => {
    const times = await grantTimes({}, [
      'https://a.example/1',
      'https://a.example/2',
      'https://a.example/3',
    ]);
    expect(DEFAULT_CRAWL_RATE_PER_SECOND).toBe(1);
    expect(times).toEqual([0, 1_000, 2_000]);
  });

  it('treats URLs with the same normalized origin as one origin', async () => {
    const times = await grantTimes({}, ['HTTPS://A.Example:443/x', 'https://a.example/y']);
    expect(times).toEqual([0, 1_000]);
  });

  it('does not let different origins block each other', async () => {
    const times = await grantTimes({}, [
      'https://a.example/1',
      'https://b.example/1',
      'https://a.example/2',
      'http://a.example/1',
    ]);
    expect(times).toEqual([0, 0, 1_000, 0]);
  });

  it.each([
    [MIN_RATE_PER_SECOND, 10_000],
    [MAX_RATE_PER_SECOND, 10],
  ])('accepts the boundary rate %p req/s with a spacing of %p ms', async (rate, spacing) => {
    const times = await grantTimes({ defaultRatePerSecond: rate }, [
      'https://a.example/1',
      'https://a.example/2',
      'https://a.example/3',
    ]);
    expect(times).toEqual([0, spacing, 2 * spacing]);
  });

  it('applies per-origin rates and falls back to the default', async () => {
    const urls = ['https://a.example/1', 'https://a.example/2', 'https://b.example/1'];
    const second = (times: number[]): number[] => [times[1] ?? NaN, times[2] ?? NaN];
    await expect(
      grantTimes({ rates: { 'https://A.example:443': 4 }, defaultRatePerSecond: 0.5 }, urls).then(
        second,
      ),
    ).resolves.toEqual([250, 0]);
    await expect(
      grantTimes({ rateFor: (o) => (o === 'https://a.example' ? 20 : undefined) }, urls).then(
        second,
      ),
    ).resolves.toEqual([50, 0]);
  });

  it.each([0.09, 0, -1, 100.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects the invalid rate %p on creation',
    (rate) => {
      expect(() => createOriginRateLimiter({ defaultRatePerSecond: rate })).toThrow(RangeError);
      expect(() => createOriginRateLimiter({ rates: { 'https://a.example': rate } })).toThrow(
        RangeError,
      );
    },
  );

  it('rejects an invalid rateFor result on acquire without reserving a slot', async () => {
    const clock = createFakeClock();
    let rate = 101;
    const limiter = createOriginRateLimiter({ rateFor: () => rate, clock });
    await expect(limiter.acquire('https://a.example/1')).rejects.toThrow(RangeError);
    rate = 1;
    await limiter.acquire('https://a.example/1');
    expect(clock.now()).toBe(0);
  });

  it('rejects invalid configuration and non-http(s) URLs', async () => {
    expect(() => createOriginRateLimiter({ rates: {}, rateFor: () => 1 })).toThrow(
      /mutually exclusive/,
    );
    expect(() => createOriginRateLimiter({ rates: { 'ftp://a.example': 1 } })).toThrow(/origin/);
    expect(() =>
      createOriginRateLimiter({ rates: { 'https://a.example': 1, 'HTTPS://A.EXAMPLE:443': 2 } }),
    ).toThrow(/duplicate/);
    const limiter = createOriginRateLimiter({ clock: createFakeClock() });
    await expect(limiter.acquire('not a url')).rejects.toThrow(TypeError);
    await expect(limiter.acquire('file:///etc/passwd')).rejects.toThrow(TypeError);
  });

  it('enforces the spacing with the default system clock', async () => {
    const limiter = createOriginRateLimiter({ defaultRatePerSecond: MAX_RATE_PER_SECOND });
    const before = systemClock.now();
    await limiter.acquire('https://a.example/1');
    await limiter.acquire('https://a.example/2');
    expect(systemClock.now() - before).toBeGreaterThanOrEqual(10);
  });
});
