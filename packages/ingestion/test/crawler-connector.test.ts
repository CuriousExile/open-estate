import {
  ConnectorFramework,
  REASON_ALLOWED,
  REASON_MISSING_LEGAL_BASIS,
  REASON_NOT_ALLOWLISTED,
  REASON_ROBOTS_DISALLOWED,
  connectorsFileSchema,
  createDefaultRegistry,
  createRunLogger,
  createWebCrawlerModule,
  jsonLdExtractor,
  type CrawlerFetch,
  type RawRecord,
  type RecordProcessor,
  type WebCrawlerModuleOptions,
} from '@open-estate/ingestion';
import { createFakeClock } from './support/fake-clock';

const PARTNER = 'https://partner.example';
const NOW = new Date('2026-11-05T10:00:00.000Z');
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const listingPage = (id: string) =>
  `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'RealEstateListing',
    id,
    title: `Listing ${id}`,
  })}</script></head><body></body></html>`;

/** Fake web: robots.txt and pages per URL; records every request with its virtual time. */
function fakeWeb(pages: Record<string, string>, clock?: { now(): number }) {
  const requests: { url: string; at: number }[] = [];
  const fetch: CrawlerFetch = async (url) => {
    requests.push({ url, at: clock?.now() ?? 0 });
    const body = pages[url];
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      text: async () => body ?? '',
    };
  };
  return { fetch, requests };
}

async function crawl(startUrls: string[], options: Omit<WebCrawlerModuleOptions, 'now'>) {
  const module = createWebCrawlerModule({ ...options, now: () => NOW });
  const lines: string[] = [];
  const logger = createRunLogger({
    runId: 'run-1',
    source: 'partner-crawler',
    sink: (line) => lines.push(line),
    now: () => NOW,
  });
  const emitted: RawRecord[] = [];
  const ctx = {
    config: module.settingsSchema.parse({ startUrls }),
    runId: 'run-1',
    logger,
    emit: async (raw: RawRecord) => {
      emitted.push(raw);
    },
  };
  const connector = module.create();
  await connector.initialize(ctx);
  await connector.run(ctx);
  const log = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { emitted, log, status: connector.reportStatus() };
}

const allowlist = (legalBasis = 'Lizenzvertrag LV-2025-07', ratePerSecond?: number) => ({
  targets: [{ origin: PARTNER, legalBasis, ...(ratePerSecond ? { ratePerSecond } : {}) }],
});

describe('web-crawler connector', () => {
  it('never fetches a non-allowlisted URL and logs the denial', async () => {
    const web = fakeWeb({ 'https://other.example/a': listingPage('X') });
    const { emitted, log } = await crawl(['https://other.example/a'], {
      fetch: web.fetch,
      loadAllowlist: async () => allowlist(),
    });
    expect(web.requests).toEqual([]);
    expect(emitted).toEqual([]);
    expect(log).toEqual([
      expect.objectContaining({
        event: 'crawl.checked',
        level: 'warn',
        source: 'partner-crawler',
        url: 'https://other.example/a',
        result: 'DENIED',
        reason: REASON_NOT_ALLOWLISTED,
        checkedAt: NOW.toISOString(),
      }),
    ]);
  });

  it('does not fetch pages denied by robots.txt or without legal basis', async () => {
    const web = fakeWeb({
      [`${PARTNER}/robots.txt`]: 'User-agent: *\nDisallow: /private',
      [`${PARTNER}/private/1`]: listingPage('P'),
    });
    const denied = await crawl([`${PARTNER}/private/1`], {
      fetch: web.fetch,
      loadAllowlist: async () => allowlist(),
    });
    expect(web.requests.map((r) => r.url)).toEqual([`${PARTNER}/robots.txt`]);
    expect(denied.log[0]).toMatchObject({ result: 'DENIED', reason: REASON_ROBOTS_DISALLOWED });

    const noBasis = await crawl([`${PARTNER}/private/1`], {
      fetch: fakeWeb({}).fetch,
      loadAllowlist: async () => allowlist('  '),
    });
    expect(noBasis.emitted).toEqual([]);
    expect(noBasis.log[0]).toMatchObject({ result: 'DENIED', reason: REASON_MISSING_LEGAL_BASIS });
  });

  it('fetches an allowed URL, extracts the listing and emits it', async () => {
    const url = `${PARTNER}/listings/1`;
    const web = fakeWeb({
      [`${PARTNER}/robots.txt`]: 'User-agent: *\nAllow: /',
      [url]: listingPage('L-1'),
    });
    const { emitted, log, status } = await crawl([url], {
      fetch: web.fetch,
      loadAllowlist: async () => allowlist(),
    });
    expect(web.requests.map((r) => r.url)).toEqual([`${PARTNER}/robots.txt`, url]);
    expect(emitted).toEqual([{ sourceUrl: url, id: 'L-1', title: 'Listing L-1' }]);
    expect(log).toEqual([
      {
        timestamp: NOW.toISOString(),
        level: 'info',
        event: 'crawl.checked',
        runId: 'run-1',
        source: 'partner-crawler',
        url,
        result: 'ALLOWED',
        reason: REASON_ALLOWED,
        checkedAt: NOW.toISOString(),
      },
    ]);
    expect(log[0]?.['checkedAt']).toMatch(ISO_WITH_OFFSET);
    expect(status.state).toBe('succeeded');
  });

  it('writes one complete crawl log entry per URL, allowed or not', async () => {
    const urls = [`${PARTNER}/a`, 'https://other.example/b', `${PARTNER}/c`];
    const web = fakeWeb({ [`${PARTNER}/robots.txt`]: '', [`${PARTNER}/a`]: listingPage('A') });
    const { log } = await crawl(urls, { fetch: web.fetch, loadAllowlist: async () => allowlist() });
    const checks = log.filter((e) => e['event'] === 'crawl.checked');
    expect(checks.map((e) => e['url'])).toEqual(urls);
    for (const entry of checks) {
      expect(entry).toEqual(
        expect.objectContaining({
          source: 'partner-crawler',
          result: expect.stringMatching(/^(ALLOWED|DENIED)$/),
          reason: expect.any(String),
          checkedAt: expect.stringMatching(ISO_WITH_OFFSET),
        }),
      );
    }
    // `/c` is allowed but answers 404: logged and skipped, the run goes on.
    expect(log).toContainEqual(
      expect.objectContaining({
        event: 'crawl.page_failed',
        url: `${PARTNER}/c`,
        reason: 'HTTP 404',
      }),
    );
  });

  it('spaces requests to the same origin according to the configured rate', async () => {
    const clock = createFakeClock();
    const urls = [`${PARTNER}/1`, `${PARTNER}/2`, `${PARTNER}/3`];
    const web = fakeWeb(
      {
        [`${PARTNER}/robots.txt`]: '',
        ...Object.fromEntries(urls.map((u, i) => [u, listingPage(`L-${i}`)])),
      },
      clock,
    );
    const { emitted } = await crawl(urls, {
      fetch: web.fetch,
      clock,
      loadAllowlist: async () => allowlist(undefined, 2),
    });
    const pageTimes = web.requests
      .filter((r) => r.url !== `${PARTNER}/robots.txt`)
      .map((r) => r.at);
    expect(pageTimes).toEqual([0, 500, 1000]);
    expect(emitted).toHaveLength(3);
  });

  it('rejects settings with link following, credentials or unknown extractors', () => {
    const { settingsSchema } = createWebCrawlerModule({ loadAllowlist: async () => allowlist() });
    expect(settingsSchema.safeParse({ startUrls: [] }).success).toBe(false);
    expect(settingsSchema.safeParse({ startUrls: ['ftp://partner.example/x'] }).success).toBe(
      false,
    );
    expect(settingsSchema.safeParse({ startUrls: ['https://u:p@partner.example/x'] }).success).toBe(
      false,
    );
    expect(
      settingsSchema.safeParse({ startUrls: [`${PARTNER}/x`], followLinks: true }).success,
    ).toBe(false);
    expect(
      settingsSchema.safeParse({ startUrls: [`${PARTNER}/x`], extractor: 'nope' }).success,
    ).toBe(false);
    expect(settingsSchema.parse({ startUrls: [`${PARTNER}/x`] })).toEqual({
      startUrls: [`${PARTNER}/x`],
      extractor: 'json-ld',
    });
  });

  it('uses an operator-provided extractor selected by name', async () => {
    const url = `${PARTNER}/feed`;
    const web = fakeWeb({ [`${PARTNER}/robots.txt`]: '', [url]: 'id=CUSTOM-1' });
    const module = createWebCrawlerModule({
      fetch: web.fetch,
      loadAllowlist: async () => allowlist(),
      extractors: { custom: (html, pageUrl) => [{ id: html.split('=')[1], sourceUrl: pageUrl }] },
    });
    const emitted: RawRecord[] = [];
    const ctx = {
      config: module.settingsSchema.parse({ startUrls: [url], extractor: 'custom' }),
      runId: 'run-1',
      logger: createRunLogger({ runId: 'run-1', source: 's', sink: () => undefined }),
      emit: async (raw: RawRecord) => {
        emitted.push(raw);
      },
    };
    const connector = module.create();
    await connector.initialize(ctx);
    await connector.run(ctx);
    expect(emitted).toEqual([{ id: 'CUSTOM-1', sourceUrl: url }]);
  });

  it('fails initialize on an invalid allowlist without fetching anything', async () => {
    const web = fakeWeb({});
    await expect(
      crawl([`${PARTNER}/x`], { fetch: web.fetch, loadAllowlist: async () => ({ targets: 'x' }) }),
    ).rejects.toThrow('invalid crawler allowlist: targets');
    expect(web.requests).toEqual([]);
  });

  it('is registered in the default registry and feeds the shared record processor', async () => {
    const url = `${PARTNER}/listings/1`;
    const web = fakeWeb({ [`${PARTNER}/robots.txt`]: '', [url]: listingPage('L-1') });
    const processed: RawRecord[] = [];
    const processor: RecordProcessor = {
      process: async (raw) => {
        processed.push(raw);
        return 'imported';
      },
    };
    const registry = createDefaultRegistry({
      webCrawler: { fetch: web.fetch, loadAllowlist: async () => allowlist() },
    });
    const [config] = connectorsFileSchema.parse([
      {
        id: 'partner-crawler',
        type: 'web-crawler',
        module: 'web-crawler',
        enabled: true,
        schedule: 'rate(1 day)',
        settings: { startUrls: [url] },
      },
    ]);
    if (!config) throw new Error('fixture');
    const summary = await new ConnectorFramework({
      registry,
      processor,
      sink: () => undefined,
    }).runConnector(config, { runId: 'run-1' });
    expect(summary).toMatchObject({ status: 'SUCCESS', imported: 1, source: 'partner-crawler' });
    expect(processed).toEqual([{ sourceUrl: url, id: 'L-1', title: 'Listing L-1' }]);
  });
});

describe('jsonLdExtractor', () => {
  it('takes listing-typed nodes from arrays and @graph, skipping malformed blocks', () => {
    const html = [
      '<script type="application/ld+json">{ not json }</script>',
      `<script type='application/ld+json'>${JSON.stringify([
        { '@type': 'Apartment', id: 'A' },
        { '@type': 'Organization', name: 'ignored' },
      ])}</script>`,
      `<script type="application/ld+json">${JSON.stringify({
        '@graph': [{ '@type': ['Offer', 'Thing'], id: 'B', sourceUrl: 'https://x.example/b' }],
      })}</script>`,
      `<script type="text/javascript">${JSON.stringify({ '@type': 'Apartment', id: 'C' })}</script>`,
    ].join('\n');
    expect(jsonLdExtractor(html, 'https://page.example/')).toEqual([
      { sourceUrl: 'https://page.example/', id: 'A' },
      { sourceUrl: 'https://x.example/b', id: 'B' },
    ]);
  });
});
