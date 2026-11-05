import { z } from 'zod';
import {
  createComplianceChecker,
  type ComplianceChecker,
  type RobotsFetch,
} from '../compliance/compliance-checker';
import { crawlerAllowlistSchema } from '../compliance/crawler-allowlist';
import type { Connector, ConnectorContext, ConnectorStatus } from '../connector';
import type { ConnectorModule } from '../registry';
import { jsonLdExtractor, type ListingExtractor } from './json-ld-extractor';
import {
  createOriginRateLimiter,
  systemClock,
  type Clock,
  type OriginRateLimiter,
} from './rate-limiter';

export const WEB_CRAWLER_MODULE_NAME = 'web-crawler';
export const DEFAULT_EXTRACTOR = 'json-ld';

/** Upper bound for fetching one page, including the body. */
export const PAGE_TIMEOUT_MS = 10_000;
/** Pages above this size (characters) are skipped instead of scanned. */
export const MAX_PAGE_CHARS = 5_000_000;
export const MAX_START_URLS = 1000;
/** Longest stored URL (Req 16.1); also bounds crawl targets. */
const MAX_URL_LENGTH = 2048;

/** fetch subset used for robots.txt and pages; injectable for tests. */
export type CrawlerFetch = RobotsFetch;

export interface WebCrawlerModuleOptions {
  /**
   * Content of `crawler-allowlist.json` from the private config bucket, loaded once per
   * run in `initialize` and validated with `crawlerAllowlistSchema`. Kept out of
   * `connectors.json` so the allowlist has a single source maintained by the admin.
   */
  readonly loadAllowlist: () => Promise<unknown>;
  /** Additional extractors by name, selectable via `settings.extractor`; `json-ld` is built in. */
  readonly extractors?: Readonly<Record<string, ListingExtractor>>;
  readonly fetch?: CrawlerFetch;
  /** Rate limiter time source. */
  readonly clock?: Clock;
  /** Compliance decision timestamps. */
  readonly now?: () => Date;
  readonly pageTimeoutMs?: number;
  readonly robotsTimeoutMs?: number;
}

const crawlTargetUrl = z
  .url({ protocol: /^https?$/, normalize: true })
  .max(MAX_URL_LENGTH)
  .refine(
    (url) => {
      const { username, password } = new URL(url);
      return username === '' && password === '';
    },
    { message: 'must not contain credentials' },
  );

function settingsSchemaFor(extractorNames: readonly [string, ...string[]]) {
  /*
   * No link following: only the configured start URLs are crawled. Every fetched page
   * is thus an explicit admin decision (default-deny); unknown keys such as
   * `followLinks` are rejected by the strict object.
   */
  return z.strictObject({
    startUrls: z.array(crawlTargetUrl).min(1).max(MAX_START_URLS),
    /** Full User-Agent header, e.g. `AcmeBot/1.0 (+https://acme.example/bot)`. */
    userAgent: z.string().trim().min(1).max(256).optional(),
    extractor: z.enum(extractorNames).default(DEFAULT_EXTRACTOR),
  });
}

export type WebCrawlerSettings = z.infer<ReturnType<typeof settingsSchemaFor>>;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** GET with a hard deadline; the race also bounds fetch implementations that ignore the signal. */
async function fetchPage(
  fetchFn: CrawlerFetch,
  url: string,
  userAgent: string | undefined,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Zeitüberschreitung nach ${timeoutMs} ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchFn(url, {
          signal: controller.signal,
          headers: userAgent === undefined ? {} : { 'User-Agent': userAgent },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (text.length > MAX_PAGE_CHARS)
          throw new Error(`Seite größer als ${MAX_PAGE_CHARS} Zeichen`);
        return text;
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Web crawler connector (design „Crawler_Connector und Compliance_Checker“, sequence
 * „Crawl-Lauf mit Compliance-Gate“; Req 6.6, 6.7, 11.5–11.7). Per start URL:
 *
 * 1. `ComplianceChecker.check(url)`;
 * 2. crawl log entry with URL, result, reason, timestamp with offset and source;
 * 3. only if `allowed === true`: rate-limiter slot for the origin, GET, extraction,
 *    `ctx.emit` per record into the same import pipeline as every other connector.
 *
 * Checker and rate limiter are created per run, so robots.txt is re-read every run.
 * A failing page is logged and skipped; it does not fail the run.
 */
class WebCrawlerConnector implements Connector<WebCrawlerSettings> {
  readonly type = 'web-crawler' as const;
  private status: ConnectorStatus = { state: 'idle', imported: 0, updated: 0, rejected: 0 };
  private checker: ComplianceChecker | undefined;
  private limiter: OriginRateLimiter | undefined;

  constructor(
    private readonly options: WebCrawlerModuleOptions,
    private readonly extractors: Readonly<Record<string, ListingExtractor>>,
  ) {}

  async initialize(ctx: ConnectorContext<WebCrawlerSettings>): Promise<void> {
    const parsed = crawlerAllowlistSchema.safeParse(await this.options.loadAllowlist());
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)');
      throw new Error(`invalid crawler allowlist: ${fields.join(', ')}`);
    }
    const { targets } = parsed.data;
    const fetchFn = this.options.fetch;
    this.checker = createComplianceChecker({
      allowlist: parsed.data,
      ...(ctx.config.userAgent === undefined ? {} : { userAgent: ctx.config.userAgent }),
      ...(fetchFn === undefined ? {} : { fetch: fetchFn }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      ...(this.options.robotsTimeoutMs === undefined
        ? {}
        : { timeoutMs: this.options.robotsTimeoutMs }),
    });
    const rates: Record<string, number> = {};
    for (const target of targets) {
      if (target.ratePerSecond !== undefined) rates[target.origin] = target.ratePerSecond;
    }
    this.limiter = createOriginRateLimiter({ rates, clock: this.options.clock ?? systemClock });
    this.status = { ...this.status, state: 'initialized' };
  }

  async run(ctx: ConnectorContext<WebCrawlerSettings>): Promise<void> {
    const { checker, limiter } = this;
    if (checker === undefined || limiter === undefined) throw new Error('not initialized');
    this.status = { ...this.status, state: 'running' };
    const { startUrls, userAgent, extractor } = ctx.config;
    const extract = this.extractors[extractor];
    if (extract === undefined) throw new Error(`unknown extractor "${extractor}"`);
    const fetchFn: CrawlerFetch = this.options.fetch ?? ((url, init) => fetch(url, init));
    const timeoutMs = this.options.pageTimeoutMs ?? PAGE_TIMEOUT_MS;

    try {
      for (const url of new Set(startUrls)) {
        const decision = await checker.check(url);
        ctx.logger.crawlChecked({ url, ...decision });
        if (decision.allowed !== true) continue;

        await limiter.acquire(url);
        let records;
        try {
          records = extract(await fetchPage(fetchFn, url, userAgent, timeoutMs), url);
        } catch (error) {
          ctx.logger.crawlPageFailed(url, describeError(error));
          continue;
        }
        for (const record of records) await ctx.emit(record);
      }
    } catch (error) {
      this.status = { ...this.status, state: 'failed' };
      throw error;
    }
    this.status = { ...this.status, state: 'succeeded' };
  }

  reportStatus(): ConnectorStatus {
    return this.status;
  }
}

/**
 * Connector module `web-crawler`. Dependencies that do not belong into `connectors.json`
 * (allowlist source, fetch, clock, operator-provided extractors) are injected here.
 */
export function createWebCrawlerModule(
  options: WebCrawlerModuleOptions,
): ConnectorModule<WebCrawlerSettings> {
  const extractors: Record<string, ListingExtractor> = {
    [DEFAULT_EXTRACTOR]: jsonLdExtractor,
    ...options.extractors,
  };
  const names = Object.keys(extractors).sort() as [string, ...string[]];
  return {
    name: WEB_CRAWLER_MODULE_NAME,
    type: 'web-crawler',
    settingsSchema: settingsSchemaFor(names),
    /** Full record per listing: a field dropped at the source must disappear (Req 12.17). */
    defaultImportMode: 'REPLACE',
    create: () => new WebCrawlerConnector(options, extractors),
  };
}
