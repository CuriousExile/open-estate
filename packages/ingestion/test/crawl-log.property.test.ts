// Feature: real-estate-platform, Property 22: Vollständiges Crawl-Protokoll
import fc from 'fast-check';
import {
  ROBOTS_TIMEOUT_MS,
  createRunLogger,
  createWebCrawlerModule,
  type Clock,
  type CrawlerFetch,
} from '@open-estate/ingestion';

/**
 * Property 22: for any crawl run, every considered target URL has exactly one
 * crawl log entry with URL, result (ALLOWED, or DENIED with a reason), source and
 * an ISO-8601 timestamp with explicit offset. Runs mix every compliance outcome
 * (unlisted origin, blank legal basis, robots.txt allow/disallow, non-2xx, network
 * error, timeout) with failing page fetches. Real 10 s deadlines, virtual time via
 * Jest fake timers.
 *
 * **Validates: Requirements 6.6**
 */

const SOURCE = 'partner-crawler';
const RUN_ID = 'run-p22';
/** ISO-8601 with mandatory offset (`Z` or `±hh:mm`). */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const ORIGINS = ['https://a.example', 'https://b.example', 'http://c.example:8080'] as const;
const UNLISTED = ['https://evil.example', 'https://www.a.example'] as const;
const PATHS = ['/', '/listings/1', '/listings/2', '/private/x', '/public'] as const;

type RobotsBehavior =
  | { readonly kind: 'content'; readonly status: number; readonly body: string }
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'error' }
  | { readonly kind: 'hang' }
  | { readonly kind: 'delay'; readonly ms: number };
type PageBehavior =
  | { readonly kind: 'ok' }
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'error' }
  | { readonly kind: 'hang' };

interface OriginSetup {
  readonly listed: boolean;
  readonly legalBasis: string | null;
  readonly robots: RobotsBehavior;
}
interface Scenario {
  readonly origins: readonly OriginSetup[];
  readonly urls: readonly string[];
  readonly pages: Readonly<Record<string, PageBehavior>>;
  /** Decision clock; `undefined` uses the (faked) system clock. */
  readonly startMs: number | undefined;
}

const arbRobots: fc.Arbitrary<RobotsBehavior> = fc.oneof(
  fc.record({
    kind: fc.constant('content' as const),
    status: fc.constantFrom(200, 203),
    body: fc.constantFrom(
      '',
      'User-agent: *\nAllow: /',
      'User-agent: *\nDisallow: /private',
      'User-agent: *\nDisallow: /',
    ),
  }),
  fc.record({ kind: fc.constant('status' as const), status: fc.constantFrom(301, 403, 404, 500) }),
  fc.constant({ kind: 'error' as const }),
  fc.constant({ kind: 'hang' as const }),
  fc.record({
    kind: fc.constant('delay' as const),
    ms: fc.constantFrom(0, ROBOTS_TIMEOUT_MS - 1, ROBOTS_TIMEOUT_MS + 1),
  }),
);

const arbPage: fc.Arbitrary<PageBehavior> = fc.oneof(
  fc.constant({ kind: 'ok' as const }),
  fc.record({ kind: fc.constant('status' as const), status: fc.constantFrom(404, 500) }),
  fc.constant({ kind: 'error' as const }),
  fc.constant({ kind: 'hang' as const }),
);

const ALL_URLS = [...ORIGINS, ...UNLISTED].flatMap((o) => PATHS.map((p) => `${o}${p}`));

const arbScenario: fc.Arbitrary<Scenario> = fc.record({
  origins: fc.tuple(
    ...ORIGINS.map(() =>
      fc.record({
        listed: fc.boolean(),
        legalBasis: fc.constantFrom('Lizenzvertrag LV-2025-07', '', '   ', null),
        robots: arbRobots,
      }),
    ),
  ),
  // Duplicates allowed: the crawler considers each distinct URL once.
  urls: fc.array(fc.constantFrom(...ALL_URLS), { minLength: 1, maxLength: 15 }),
  pages: fc.record(Object.fromEntries(ALL_URLS.map((u) => [u, arbPage]))),
  startMs: fc.option(fc.integer({ min: Date.UTC(1970, 0, 1), max: Date.UTC(9999, 11, 31) }), {
    nil: undefined,
  }),
});

const ok = (status: number, body: string) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
});

/** Never settles unless aborted via the signal. */
const hang = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  });

function fakeFetch(scenario: Scenario): CrawlerFetch {
  const robotsByUrl = new Map(
    ORIGINS.map((origin, i) => [`${origin}/robots.txt`, scenario.origins[i]?.robots]),
  );
  return (url, init) => {
    const robots = robotsByUrl.get(url);
    if (robots !== undefined) {
      switch (robots.kind) {
        case 'content':
          return Promise.resolve(ok(robots.status, robots.body));
        case 'status':
          return Promise.resolve(ok(robots.status, ''));
        case 'error':
          return Promise.reject(new TypeError('fetch failed: ECONNRESET'));
        case 'hang':
          return hang(init.signal);
        case 'delay':
          return new Promise((resolve) => setTimeout(() => resolve(ok(200, '')), robots.ms));
      }
    }
    const page = scenario.pages[url] ?? { kind: 'status', status: 404 };
    switch (page.kind) {
      case 'ok':
        return Promise.resolve(ok(200, '<html></html>'));
      case 'status':
        return Promise.resolve(ok(page.status, ''));
      case 'error':
        return Promise.reject(new TypeError('fetch failed: ENOTFOUND'));
      case 'hang':
        return hang(init.signal);
    }
  };
}

/** Rate limiting is not under test: sleep advances virtual time without timers. */
function instantClock(): Clock {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
  };
}

/** Decision clock advancing 1 ms per call, or the faked system clock. */
function decisionClock(startMs: number | undefined): (() => Date) | undefined {
  if (startMs === undefined) return undefined;
  let current = startMs;
  return () => new Date(current++);
}

async function runCrawl(scenario: Scenario) {
  const now = decisionClock(scenario.startMs);
  const module = createWebCrawlerModule({
    fetch: fakeFetch(scenario),
    clock: instantClock(),
    ...(now === undefined ? {} : { now }),
    loadAllowlist: async () => ({
      targets: ORIGINS.flatMap((origin, i) => {
        const setup = scenario.origins[i];
        return setup?.listed === true ? [{ origin, legalBasis: setup.legalBasis }] : [];
      }),
    }),
  });
  const lines: string[] = [];
  const ctx = {
    config: module.settingsSchema.parse({ startUrls: scenario.urls }),
    runId: RUN_ID,
    logger: createRunLogger({ runId: RUN_ID, source: SOURCE, sink: (line) => lines.push(line) }),
    emit: async () => undefined,
  };
  const connector = module.create();

  let settled = false;
  const done = (async () => {
    await connector.initialize(ctx);
    await connector.run(ctx);
  })().finally(() => {
    settled = true;
  });
  // Drive virtual time until the run ends (each hang is cut off after 10 s).
  for (let i = 0; i < 1000 && !settled; i++) await jest.advanceTimersByTimeAsync(1_000);
  await done;

  return {
    startUrls: ctx.config.startUrls,
    checks: lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e['event'] === 'crawl.checked'),
    state: connector.reportStatus().state,
  };
}

describe('Property 22: Vollständiges Crawl-Protokoll', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('logs exactly one complete entry per considered target URL', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        const { startUrls, checks, state } = await runCrawl(scenario);
        // Generated URLs are canonical, so normalization does not change them.
        expect(startUrls).toEqual(scenario.urls);
        expect(state).toBe('succeeded');

        const considered = [...new Set(scenario.urls)];
        expect(checks.map((e) => e['url'])).toEqual(considered);

        for (const entry of checks) {
          expect(entry).toEqual(
            expect.objectContaining({
              source: SOURCE,
              runId: RUN_ID,
              result: expect.stringMatching(/^(ALLOWED|DENIED)$/),
              reason: expect.any(String),
              checkedAt: expect.stringMatching(ISO_WITH_OFFSET),
            }),
          );
          if (entry['result'] === 'DENIED') {
            expect((entry['reason'] as string).trim()).not.toBe('');
          }
          expect(Number.isNaN(Date.parse(entry['checkedAt'] as string))).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});
