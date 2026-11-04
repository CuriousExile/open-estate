// Feature: real-estate-platform, Property 16: Lauf-Zähler
import {
  connectorConfigSchema,
  ConnectorFramework,
  ConnectorRegistry,
  ImportPipeline,
  InMemoryDeletionBlocklist,
  InMemoryListingWriter,
  type Connector,
  type ConnectorModule,
  type ConnectorRunSummary,
  type ListingWriter,
} from '@open-estate/ingestion';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  LISTING_BOUNDS as B,
  TourProvidersConfig,
  type Listing,
} from '@open-estate/shared';
import fc from 'fast-check';
import { z } from 'zod';
import { arbListing } from '../../shared/test/arbitraries';
import { NOW, SOURCE, toInput, type Input } from './support/import-harness';

/**
 * Property 16: for any sequence of raw records of a run, `imported + updated + rejected` equals
 * the number of processed records, and `updated` equals the number of stored records whose `id`
 * already existed before the run.
 *
 * Strategy: a pool of listings with unique ids; a random subset is stored before the run, another
 * (overlapping) subset is on the deletion blocklist. One connector run emits records drawn from
 * the pool, each of one kind:
 * - `valid`: the listing in the input format (stored unless blocklisted),
 * - `invalid`: the same with `title = ''` (validation rejects it),
 * - `no-id` / `long-id`: `id` missing or longer than allowed, so the record is unattributable.
 * The connector may throw in `initialize` (nothing processed) or before record k (only the first
 * k records are processed); the counters must match exactly the records that reached the pipeline.
 *
 * "Processed" is counted where the framework hands a record to the pipeline (an instrumented
 * processor), "stored" where the pipeline hands a listing to the writer (an instrumented writer),
 * so both sides of the equations are observed independently of the framework's counters.
 *
 * Ids of valid, attributable records are unique within the run in the main property: for a
 * listing emitted twice in one run, "existed before the run" (property text) and "existed at
 * write time" (writer outcome) differ. That case is pinned separately below.
 *
 * **Validates: Requirements 5.8**
 */

const MODULE = 'dummy-api';

const listingSchema = buildSchemas(assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG), {
  defaultLocale: 'de',
  enabled: [{ locale: 'de', label: 'Deutsch' }],
}).listing;
const tourProviders = TourProvidersConfig.parse({ providers: [] });

type Kind = 'valid' | 'invalid' | 'no-id' | 'long-id';

interface EmittedRecord {
  /** Index into the listing pool. */
  readonly listing: number;
  readonly kind: Kind;
}

/** Throw in `initialize`, before record `k` in `run`, or never. */
type Failure = { readonly at: 'initialize' } | { readonly at: 'run'; readonly before: number };

interface Scenario {
  readonly pool: readonly Listing[];
  /** Pool indices stored before the run. */
  readonly existing: ReadonlySet<number>;
  /** Pool indices on the deletion blocklist. */
  readonly blocked: ReadonlySet<number>;
  readonly records: readonly EmittedRecord[];
  readonly failure: Failure | undefined;
}

// ---------------------------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------------------------

const arbKind: fc.Arbitrary<Kind> = fc.oneof(
  { arbitrary: fc.constant('valid' as const), weight: 4 },
  { arbitrary: fc.constant('invalid' as const), weight: 1 },
  { arbitrary: fc.constant('no-id' as const), weight: 1 },
  { arbitrary: fc.constant('long-id' as const), weight: 1 },
);

const arbSubset = (size: number) =>
  fc.subarray([...Array(size).keys()]).map((indices) => new Set(indices));

const arbFailure = (maxBefore: number): fc.Arbitrary<Failure | undefined> =>
  fc.option(
    fc.oneof(
      { arbitrary: fc.constant({ at: 'initialize' as const }), weight: 1 },
      {
        arbitrary: fc.record({
          at: fc.constant('run' as const),
          before: fc.nat({ max: maxBefore }),
        }),
        weight: 3,
      },
    ),
    { nil: undefined, freq: 2 },
  );

/** Valid records have unique ids within the run; rejected ones may repeat any id. */
function uniqueValidIds(records: readonly EmittedRecord[]): EmittedRecord[] {
  const seen = new Set<number>();
  return records.map((r) => {
    if (r.kind !== 'valid') return r;
    if (seen.has(r.listing)) return { ...r, kind: 'invalid' };
    seen.add(r.listing);
    return r;
  });
}

const arbScenario = (records: (poolSize: number) => fc.Arbitrary<EmittedRecord[]>) =>
  fc
    .uniqueArray(arbListing(), { minLength: 1, maxLength: 6, selector: (l) => l.id })
    .chain((pool) =>
      fc.record({
        pool: fc.constant(pool),
        existing: arbSubset(pool.length),
        blocked: arbSubset(pool.length),
        records: records(pool.length),
        failure: arbFailure(8),
      }),
    );

const arbRecords = (poolSize: number) =>
  fc.array(fc.record({ listing: fc.nat({ max: poolSize - 1 }), kind: arbKind }), {
    maxLength: 8,
  });

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

function rawRecord(pool: readonly Listing[], record: EmittedRecord): Input {
  const listing = pool[record.listing];
  if (listing === undefined) throw new Error('pool index out of range');
  const input = toInput(listing);
  switch (record.kind) {
    case 'valid':
      return input;
    case 'invalid':
      return { ...input, title: '' };
    case 'no-id': {
      const rest = { ...input };
      delete rest['id'];
      return rest;
    }
    case 'long-id':
      return { ...input, id: 'x'.repeat(B.id.max + 1) };
  }
}

function connectorModule(scenario: Scenario): ConnectorModule {
  const { pool, records, failure } = scenario;
  return {
    name: MODULE,
    type: 'external-api',
    settingsSchema: z.strictObject({}),
    create: (): Connector => ({
      type: 'external-api',
      initialize: async () => {
        if (failure?.at === 'initialize') throw new Error('initialize failed');
      },
      run: async (ctx) => {
        for (const [i, record] of records.entries()) {
          if (failure?.at === 'run' && failure.before === i) throw new Error('source down');
          await ctx.emit(rawRecord(pool, record));
        }
        if (failure?.at === 'run' && failure.before >= records.length) {
          throw new Error('source down');
        }
      },
      reportStatus: () => ({ state: 'idle', imported: 0, updated: 0, rejected: 0 }),
    }),
  };
}

interface Observed {
  readonly summary: ConnectorRunSummary;
  /** `run.finished` log entry. */
  readonly runLog: Record<string, unknown> | undefined;
  /** Records the framework handed to the pipeline. */
  readonly processed: number;
  /** Ids the pipeline handed to the writer and that were stored. */
  readonly stored: readonly string[];
  /** Ids stored before the run. */
  readonly existedBefore: ReadonlySet<string>;
}

async function runScenario(scenario: Scenario): Promise<Observed> {
  const { pool, existing, blocked } = scenario;
  const store = new InMemoryListingWriter();
  for (const i of existing) {
    const listing = pool[i];
    if (listing !== undefined) await store.write(listing);
  }
  const existedBefore = new Set(pool.filter((_, i) => existing.has(i)).map((l) => l.id));

  const stored: string[] = [];
  const writer: ListingWriter = {
    write: async (listing) => {
      const outcome = await store.write(listing);
      stored.push(listing.id);
      return outcome;
    },
  };
  const pipeline = new ImportPipeline({
    listingSchema,
    blocklist: new InMemoryDeletionBlocklist(
      pool.filter((_, i) => blocked.has(i)).map((l) => l.id),
    ),
    writer,
    tourProviders,
    now: () => NOW,
  });
  let processed = 0;
  const lines: string[] = [];
  const framework = new ConnectorFramework({
    registry: new ConnectorRegistry([connectorModule(scenario)]),
    processor: {
      process: (raw, ctx) => {
        processed += 1;
        return pipeline.process(raw, ctx);
      },
    },
    sink: (line) => lines.push(line),
    now: () => NOW,
  });
  const config = connectorConfigSchema.parse({
    id: SOURCE,
    type: 'external-api',
    module: MODULE,
    enabled: true,
    schedule: 'rate(1 hour)',
    settings: {},
  });
  const summary = await framework.runConnector(config, { runId: 'run-16' });
  const runLog = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((e) => e['event'] === 'run.finished');
  return { summary, runLog, processed, stored, existedBefore };
}

/** Records the connector emits before it fails. */
function emittedRecords({ records, failure }: Scenario): readonly EmittedRecord[] {
  if (failure?.at === 'initialize') return [];
  if (failure?.at === 'run') return records.slice(0, failure.before);
  return records;
}

const counters = ({ imported, updated, rejected }: ConnectorRunSummary) => ({
  imported,
  updated,
  rejected,
});

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

describe('Property 16: Lauf-Zähler', () => {
  it('imported + updated + rejected = processed records, updated = stored ids that existed before the run', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbScenario((n) => arbRecords(n).map(uniqueValidIds)),
        async (scenario) => {
          const { summary, runLog, processed, stored, existedBefore } = await runScenario(scenario);
          const { pool, blocked } = scenario;

          // Processed = exactly the records emitted before the connector failed.
          const emitted = emittedRecords(scenario);
          expect(processed).toBe(emitted.length);
          expect(summary.imported + summary.updated + summary.rejected).toBe(processed);

          // updated = stored records whose id existed before the run; the rest stored is new.
          const updatedIds = stored.filter((id) => existedBefore.has(id));
          expect(summary.updated).toBe(updatedIds.length);
          expect(summary.imported).toBe(stored.length - updatedIds.length);

          // Model: stored = valid, attributable, not blocklisted.
          const expectedStored = emitted
            .filter((r) => r.kind === 'valid' && !blocked.has(r.listing))
            .map((r) => pool[r.listing]?.id);
          expect(stored).toEqual(expectedStored);

          // The run log carries the same counters (Req 5.8), also for a failed run.
          expect(runLog).toEqual(expect.objectContaining(counters(summary)));
          expect(summary.status).toBe(scenario.failure === undefined ? 'SUCCESS' : 'FAILURE');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('imported + updated + rejected = processed records also with repeated ids in one run', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario(arbRecords), async (scenario) => {
        const { summary, runLog, processed, stored } = await runScenario(scenario);
        expect(processed).toBe(emittedRecords(scenario).length);
        expect(summary.imported + summary.updated + summary.rejected).toBe(processed);
        expect(summary.imported + summary.updated).toBe(stored.length);
        expect(runLog).toEqual(expect.objectContaining(counters(summary)));
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Known discrepancy (reported, not resolved here): a listing that is new before the run and
   * emitted twice is stored twice. The writer reports `imported`, then `updated` (it existed at
   * write time). The property text counts `updated` only for ids that existed *before the run*,
   * which would require `updated = 0` and thus `imported = 2` for a single new listing. Req 5.8
   * ("Anzahl der importierten, aktualisierten und abgewiesenen Listings") does not decide it.
   * This test pins the current behaviour so a change of either side is a conscious decision.
   */
  it('counts a repeated new id in one run as imported once and updated once (write-time existence)', async () => {
    const [listing] = fc.sample(arbListing(), { numRuns: 1, seed: 16 });
    if (listing === undefined) throw new Error('no sample');
    const scenario: Scenario = {
      pool: [listing],
      existing: new Set(),
      blocked: new Set(),
      records: [
        { listing: 0, kind: 'valid' },
        { listing: 0, kind: 'valid' },
      ],
      failure: undefined,
    };
    const { summary, stored, existedBefore } = await runScenario(scenario);

    expect(stored).toEqual([listing.id, listing.id]);
    expect(existedBefore.has(listing.id)).toBe(false);
    expect(counters(summary)).toEqual({ imported: 1, updated: 1, rejected: 0 });
    // Literal property text: stored ids that existed before the run.
    const updatedBeforeRun = stored.filter((id) => existedBefore.has(id)).length;
    expect(updatedBeforeRun).toBe(0);
    expect(summary.updated).not.toBe(updatedBeforeRun);
  });
});
