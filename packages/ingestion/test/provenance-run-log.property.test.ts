// Feature: real-estate-platform, Property 15: Herkunft, Lauf-Zuordnung und Lauf-Protokoll
import {
  connectorConfigSchema,
  ConnectorFramework,
  ConnectorRegistry,
  createWebCrawlerModule,
  ImportPipeline,
  InMemoryDeletionBlocklist,
  InMemoryListingWriter,
  WEB_CRAWLER_MODULE_NAME,
  type Clock,
  type Connector,
  type ConnectorModule,
  type CrawlerFetch,
  type ListingWriter,
} from '@open-estate/ingestion';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  TourProvidersConfig,
  type Listing,
} from '@open-estate/shared';
import fc from 'fast-check';
import { z } from 'zod';
import { arbListing } from '../../shared/test/arbitraries';
import { toInput, type Input } from './support/import-harness';

/**
 * Property 15: for any connector or crawl run there is exactly one run log with start, end
 * (start ≤ end), source and status, and every listing stored in that run carries `source`,
 * `lastImportedAt` ∈ [start, end] and `lastRunId` of that run.
 *
 * Strategy: 1–4 sequential runs with distinct run ids on one `InMemoryListingWriter`. A run is
 * either an `external-api` style dummy connector or the real `web-crawler` module with a fake web.
 * Records are drawn from a small pool of listings (ids recur across runs) and are valid or made
 * invalid (`title = ''`). The dummy connector may throw in `initialize` or after k records; crawl
 * pages may be missing (404) or lie on an origin outside the allowlist. Framework and pipeline
 * share one clock that advances by a random step (possibly 0) on every reading, so the window
 * [startedAt, endedAt] is narrow and `lastImportedAt` must really be taken during the run.
 *
 * A model of the store (id → run id) tracks which listings each run must write; listings not
 * written by a run must be unchanged, i.e. keep the provenance of their earlier run.
 *
 * **Validates: Requirements 4.12, 11.5**
 */

const API_MODULE = 'dummy-api';
const API_SOURCES = ['api-a', 'api-b'] as const;
const CRAWL_SOURCES = ['crawl-c', 'api-a'] as const;
const STATUSES = ['SUCCESS', 'FAILURE'];
/** ISO-8601 with mandatory offset (`Z` or `±hh:mm`). */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ALLOWED_ORIGIN = 'https://partner.example';
const DENIED_ORIGIN = 'https://unlisted.example';
const START_MS = Date.UTC(2026, 10, 5, 10);

const listingSchema = buildSchemas(assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG), {
  defaultLocale: 'de',
  enabled: [{ locale: 'de', label: 'Deutsch' }],
}).listing;
const tourProviders = TourProvidersConfig.parse({ providers: [] });

interface EmittedRecord {
  /** Index into the listing pool. */
  readonly listing: number;
  readonly valid: boolean;
}

/** Throw in `initialize`, after `k` records in `run`, or never. */
type Failure = { readonly at: 'initialize' } | { readonly at: 'run'; readonly after: number };

interface ApiRun {
  readonly kind: 'api';
  readonly source: string;
  readonly records: readonly EmittedRecord[];
  readonly failure: Failure | undefined;
}

interface CrawlPage {
  readonly allowed: boolean;
  /** `false` → HTTP 404. */
  readonly found: boolean;
  readonly records: readonly EmittedRecord[];
}

interface CrawlRun {
  readonly kind: 'crawl';
  readonly source: string;
  readonly pages: readonly CrawlPage[];
}

type Run = ApiRun | CrawlRun;

interface Scenario {
  readonly pool: readonly Listing[];
  readonly runs: readonly Run[];
  /** Clock steps in ms, used cyclically. */
  readonly steps: readonly number[];
}

// ---------------------------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------------------------

const arbRecords = (poolSize: number) =>
  fc.array(
    fc.record({
      listing: fc.nat({ max: poolSize - 1 }),
      valid: fc.oneof({ arbitrary: fc.constant(true), weight: 3 }, fc.constant(false)),
    }),
    { maxLength: 4 },
  );

const arbApiRun = (poolSize: number): fc.Arbitrary<ApiRun> =>
  fc.record({
    kind: fc.constant('api' as const),
    source: fc.constantFrom(...API_SOURCES),
    records: arbRecords(poolSize),
    failure: fc.option(
      fc.oneof(
        fc.constant({ at: 'initialize' as const }),
        fc.record({ at: fc.constant('run' as const), after: fc.nat({ max: 4 }) }),
      ),
      { nil: undefined, freq: 2 },
    ),
  });

const arbCrawlRun = (poolSize: number): fc.Arbitrary<CrawlRun> =>
  fc.record({
    kind: fc.constant('crawl' as const),
    source: fc.constantFrom(...CRAWL_SOURCES),
    pages: fc.array(
      fc.record({
        allowed: fc.oneof({ arbitrary: fc.constant(true), weight: 4 }, fc.constant(false)),
        found: fc.oneof({ arbitrary: fc.constant(true), weight: 4 }, fc.constant(false)),
        records: arbRecords(poolSize),
      }),
      { minLength: 1, maxLength: 3 },
    ),
  });

const arbScenario: fc.Arbitrary<Scenario> = fc
  .uniqueArray(arbListing(), { minLength: 1, maxLength: 4, selector: (l) => l.id })
  .chain((pool) =>
    fc.record({
      pool: fc.constant(pool),
      runs: fc.array(fc.oneof(arbApiRun(pool.length), arbCrawlRun(pool.length)), {
        minLength: 1,
        maxLength: 4,
      }),
      steps: fc.array(fc.integer({ min: 0, max: 5_000 }), { minLength: 1, maxLength: 8 }),
    }),
  );

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

/** Clock advancing by the next step on every reading; shared by framework, pipeline, crawler. */
function steppingClock(steps: readonly number[]): () => Date {
  let current = START_MS;
  let i = 0;
  return () => {
    const date = new Date(current);
    current += steps[i++ % steps.length] ?? 0;
    return date;
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

function rawRecord(pool: readonly Listing[], record: EmittedRecord): Input {
  const listing = pool[record.listing];
  if (listing === undefined) throw new Error('pool index out of range');
  const input = toInput(listing);
  return record.valid ? input : { ...input, title: '' };
}

/** `<` escaped, so no generated string can close the script element. */
function pageHtml(records: readonly Input[]): string {
  const json = JSON.stringify(
    records.map((r) => ({ '@type': 'RealEstateListing', ...r })),
  ).replaceAll('<', '\\u003c');
  return `<html><head><script type="application/ld+json">${json}</script></head></html>`;
}

const pageUrl = (page: CrawlPage, index: number): string =>
  `${page.allowed ? ALLOWED_ORIGIN : DENIED_ORIGIN}/listings/${index}`;

function crawlerModule(run: CrawlRun, pool: readonly Listing[], now: () => Date) {
  const bodies = new Map(
    run.pages.map((page, i) => [
      pageUrl(page, i),
      page.found ? pageHtml(page.records.map((r) => rawRecord(pool, r))) : undefined,
    ]),
  );
  const fetch: CrawlerFetch = async (url) => {
    if (url === `${ALLOWED_ORIGIN}/robots.txt`) {
      return { ok: true, status: 200, text: async () => 'User-agent: *\nAllow: /' };
    }
    const body = bodies.get(url);
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      text: async () => body ?? '',
    };
  };
  return createWebCrawlerModule({
    fetch,
    clock: instantClock(),
    now,
    loadAllowlist: async () => ({
      targets: [{ origin: ALLOWED_ORIGIN, legalBasis: 'Partnervertrag PV-15' }],
    }),
  });
}

/** Dummy connector of the current run; reads the run from a mutable slot. */
function apiModule(current: {
  run: ApiRun | undefined;
  pool: readonly Listing[];
}): ConnectorModule {
  return {
    name: API_MODULE,
    type: 'external-api',
    settingsSchema: z.strictObject({}),
    create: (): Connector => ({
      type: 'external-api',
      initialize: async () => {
        if (current.run?.failure?.at === 'initialize') throw new Error('initialize failed');
      },
      run: async (ctx) => {
        const run = current.run;
        if (run === undefined) throw new Error('no run');
        for (const [i, record] of run.records.entries()) {
          if (run.failure?.at === 'run' && run.failure.after === i) throw new Error('source down');
          await ctx.emit(rawRecord(current.pool, record));
        }
        if (run.failure?.at === 'run' && run.failure.after >= run.records.length) {
          throw new Error('source down');
        }
      },
      reportStatus: () => ({ state: 'idle', imported: 0, updated: 0, rejected: 0 }),
    }),
  };
}

/** Pool indices the run must store, in emission order; and whether the run must fail. */
function expectedRun(run: Run): { written: number[]; fails: boolean } {
  const valid = (records: readonly EmittedRecord[]) =>
    records.filter((r) => r.valid).map((r) => r.listing);
  if (run.kind === 'crawl') {
    return {
      written: run.pages.filter((p) => p.allowed && p.found).flatMap((p) => valid(p.records)),
      fails: false,
    };
  }
  if (run.failure?.at === 'initialize') return { written: [], fails: true };
  if (run.failure?.at === 'run') {
    return { written: valid(run.records.slice(0, run.failure.after)), fails: true };
  }
  return { written: valid(run.records), fails: false };
}

type LogEntry = Record<string, unknown>;

async function runScenario({ pool, runs, steps }: Scenario) {
  const now = steppingClock(steps);
  const store = new InMemoryListingWriter();
  let writes: string[] = [];
  const writer: ListingWriter = {
    write: (listing) => {
      writes.push(listing.id);
      return store.write(listing);
    },
  };
  const pipeline = new ImportPipeline({
    listingSchema,
    blocklist: new InMemoryDeletionBlocklist(),
    writer,
    tourProviders,
    now,
  });
  const ids = pool.map((l) => l.id);
  const snapshot = () => Object.fromEntries(ids.map((id) => [id, store.get(id)]));
  const current: { run: ApiRun | undefined; pool: readonly Listing[] } = { run: undefined, pool };

  const results = [];
  for (const [i, run] of runs.entries()) {
    const runId = `run-${i}`;
    const lines: string[] = [];
    const module = run.kind === 'api' ? apiModule(current) : crawlerModule(run, pool, now);
    current.run = run.kind === 'api' ? run : undefined;
    const framework = new ConnectorFramework({
      registry: new ConnectorRegistry([module]),
      processor: pipeline,
      sink: (line) => lines.push(line),
      now,
    });
    const config = connectorConfigSchema.parse({
      id: run.source,
      type: run.kind === 'api' ? 'external-api' : 'web-crawler',
      module: run.kind === 'api' ? API_MODULE : WEB_CRAWLER_MODULE_NAME,
      enabled: true,
      schedule: 'rate(1 hour)',
      settings:
        run.kind === 'api' ? {} : { startUrls: run.pages.map((page, j) => pageUrl(page, j)) },
    });
    const before = snapshot();
    writes = [];
    const summary = await framework.runConnector(config, { runId });
    results.push({
      run,
      runId,
      summary,
      before,
      after: snapshot(),
      writes,
      log: lines.map((line) => JSON.parse(line) as LogEntry),
    });
  }
  return results;
}

describe('Property 15: Herkunft, Lauf-Zuordnung und Lauf-Protokoll', () => {
  it('writes exactly one run log per run and stamps every stored listing with that run', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        const results = await runScenario(scenario);
        const { pool } = scenario;

        for (const { run, runId, summary, before, after, writes, log } of results) {
          // Every line of the run carries its run id and source.
          for (const entry of log) {
            expect(entry).toEqual(expect.objectContaining({ runId, source: run.source }));
          }

          // Exactly one run log with start ≤ end, source and status (Req 11.5).
          const finished = log.filter((e) => e['event'] === 'run.finished');
          expect(finished).toHaveLength(1);
          const runLog = finished[0] ?? {};
          expect(runLog).toEqual(
            expect.objectContaining({
              source: run.source,
              status: expect.stringMatching(new RegExp(`^(${STATUSES.join('|')})$`)),
              startedAt: expect.stringMatching(ISO_WITH_OFFSET),
              endedAt: expect.stringMatching(ISO_WITH_OFFSET),
            }),
          );
          const startedAt = Date.parse(runLog['startedAt'] as string);
          const endedAt = Date.parse(runLog['endedAt'] as string);
          expect(startedAt).toBeLessThanOrEqual(endedAt);
          expect({ startedAt, endedAt, status: runLog['status'] }).toEqual({
            startedAt: summary.startedAt.getTime(),
            endedAt: summary.endedAt.getTime(),
            status: summary.status,
          });
          expect({ runId: summary.runId, source: summary.source }).toEqual({
            runId,
            source: run.source,
          });

          const expected = expectedRun(run);
          expect(runLog['status']).toBe(expected.fails ? 'FAILURE' : 'SUCCESS');
          expect(writes).toEqual(expected.written.map((i) => pool[i]?.id));

          // Stored in this run → provenance of this run (Req 4.12); otherwise unchanged.
          const written = new Set(writes);
          for (const listing of pool) {
            const stored = after[listing.id];
            if (!written.has(listing.id)) {
              expect(stored).toEqual(before[listing.id]);
              continue;
            }
            expect(stored).toBeDefined();
            expect(stored?.source).toBe(run.source);
            expect(stored?.lastRunId).toBe(runId);
            expect(stored?.lastImportedAt).toMatch(ISO_WITH_OFFSET);
            const importedAt = Date.parse(stored?.lastImportedAt ?? '');
            expect(importedAt).toBeGreaterThanOrEqual(startedAt);
            expect(importedAt).toBeLessThanOrEqual(endedAt);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
