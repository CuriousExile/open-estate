import {
  REASON_ALLOWED,
  REASON_ROBOTS_UNAVAILABLE,
  ROBOTS_TIMEOUT_MS,
  createRunLogger,
  createWebCrawlerModule,
  type Clock,
  type CrawlerFetch,
} from '@open-estate/ingestion';

/*
 * Req 6.2 at crawler level with the real default deadline (no `robotsTimeoutMs`
 * override): a robots.txt fetch that is too slow or fails means the page is not
 * fetched and the failure is logged with its cause. Virtual time via Jest fake timers.
 */

const PARTNER = 'https://partner.example';
const ROBOTS_URL = `${PARTNER}/robots.txt`;
const PAGES = [`${PARTNER}/listings/1`, `${PARTNER}/listings/2`];
const NOW = new Date('2026-11-05T10:00:00.000Z');
const TIMEOUT_REASON = `${REASON_ROBOTS_UNAVAILABLE}: Zeitüberschreitung nach ${ROBOTS_TIMEOUT_MS} ms`;

/** Rate limiting is not under test: virtual clock whose sleep advances time without timers. */
function instantClock(): Clock {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
  };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ok = (body: string) => ({ ok: true, status: 200, text: async () => body });

type RobotsBehaviour =
  { readonly delayMs: number } | { readonly hang: true } | { readonly error: Error };

/** robots.txt per behaviour; every other URL answers 200 immediately. Records all requests. */
function fakeWeb(robots: RobotsBehaviour) {
  const requests: string[] = [];
  const fetch: CrawlerFetch = (url, init) => {
    requests.push(url);
    if (url !== ROBOTS_URL) return Promise.resolve(ok('<html></html>'));
    if ('error' in robots) return Promise.reject(robots.error);
    if ('hang' in robots) {
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    }
    return new Promise((resolve) => setTimeout(() => resolve(ok('')), robots.delayMs));
  };
  return { fetch, requests };
}

/** Starts a crawl run over {@link PAGES}; the caller drives virtual time. */
function startCrawl(fetch: CrawlerFetch) {
  const module = createWebCrawlerModule({
    fetch,
    clock: instantClock(),
    now: () => NOW,
    loadAllowlist: async () => ({
      targets: [{ origin: PARTNER, legalBasis: 'Lizenzvertrag LV-2025-07' }],
    }),
  });
  const lines: string[] = [];
  const ctx = {
    config: module.settingsSchema.parse({ startUrls: PAGES }),
    runId: 'run-1',
    logger: createRunLogger({
      runId: 'run-1',
      source: 'partner-crawler',
      sink: (line) => lines.push(line),
      now: () => NOW,
    }),
    emit: async () => undefined,
  };
  const connector = module.create();
  const done = (async () => {
    await connector.initialize(ctx);
    await connector.run(ctx);
    return {
      checks: lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((e) => e['event'] === 'crawl.checked'),
      status: connector.reportStatus(),
    };
  })();
  return done;
}

/** Lets the run reach the pending robots.txt request without advancing virtual time. */
async function untilRequested(requests: readonly string[]): Promise<void> {
  for (let i = 0; i < 20 && requests.length === 0; i++) await jest.advanceTimersByTimeAsync(0);
  expect(requests).toEqual([ROBOTS_URL]);
}

function expectDeniedWithoutPageFetch(
  result: Awaited<ReturnType<typeof startCrawl>>,
  requests: readonly string[],
  reason: unknown,
) {
  // One robots.txt request for both URLs of the origin (failure cached), no page request.
  expect(requests).toEqual([ROBOTS_URL]);
  expect(result.checks).toEqual(
    PAGES.map((url) => expect.objectContaining({ level: 'warn', url, result: 'DENIED', reason })),
  );
  expect(result.status.state).toBe('succeeded');
}

describe('web-crawler robots.txt timeout and errors (Req 6.2)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('uses a 10 s default deadline', () => {
    expect(ROBOTS_TIMEOUT_MS).toBe(10_000);
  });

  it('denies when robots.txt arrives only after 10 001 ms', async () => {
    const web = fakeWeb({ delayMs: ROBOTS_TIMEOUT_MS + 1 });
    const done = startCrawl(web.fetch);
    await untilRequested(web.requests);
    await jest.advanceTimersByTimeAsync(ROBOTS_TIMEOUT_MS + 1);
    expectDeniedWithoutPageFetch(await done, web.requests, TIMEOUT_REASON);
  });

  it('denies when robots.txt never answers', async () => {
    const web = fakeWeb({ hang: true });
    const done = startCrawl(web.fetch);
    await untilRequested(web.requests);
    await jest.advanceTimersByTimeAsync(ROBOTS_TIMEOUT_MS - 1);
    expect(web.requests).toEqual([ROBOTS_URL]);
    await jest.advanceTimersByTimeAsync(1);
    expectDeniedWithoutPageFetch(await done, web.requests, TIMEOUT_REASON);
  });

  it('still allows robots.txt arriving just before the deadline', async () => {
    const web = fakeWeb({ delayMs: ROBOTS_TIMEOUT_MS - 1 });
    const done = startCrawl(web.fetch);
    await untilRequested(web.requests);
    await jest.advanceTimersByTimeAsync(ROBOTS_TIMEOUT_MS - 1);
    const { checks } = await done;
    expect(web.requests).toEqual([ROBOTS_URL, ...PAGES]);
    expect(checks).toEqual(
      PAGES.map((url) =>
        expect.objectContaining({ url, result: 'ALLOWED', reason: REASON_ALLOWED }),
      ),
    );
  });

  it.each([
    ['a thrown network error', new TypeError('fetch failed: ECONNRESET')],
    ['an aborted request', new DOMException('This operation was aborted', 'AbortError')],
  ])('denies on %s and logs the cause', async (_, error) => {
    const web = fakeWeb({ error });
    const result = await startCrawl(web.fetch);
    expectDeniedWithoutPageFetch(
      result,
      web.requests,
      // Cause after the prefix; a cross-realm DOMException is stringified with its name.
      expect.stringMatching(
        new RegExp(
          `^${escapeRegExp(REASON_ROBOTS_UNAVAILABLE)}: .*${escapeRegExp(error.message)}$`,
        ),
      ),
    );
  });
});
