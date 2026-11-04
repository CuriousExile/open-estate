// Feature: real-estate-platform, Property 35: Löschsperre ist dauerhaft
import { createAdminHandler, type AdminRequest } from '@open-estate/admin';
import {
  createListingService,
  createSearchService,
  InMemoryApiKeyStore,
  InMemorySearchProvider,
  StaticAccessConfigSource,
  type SearchProvider,
} from '@open-estate/core';
import {
  createRunLogger,
  DELETION_BLOCK_REASON,
  DeletionBlockedError,
  ImportPipeline,
  InMemoryDeletionBlocklist,
  type ListingWriter,
  type WriteOutcome,
} from '@open-estate/ingestion';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  parseSearchQuery,
  TourProvidersConfig,
  type Listing,
} from '@open-estate/shared';
import fc from 'fast-check';
import { expectedStored, NOW, SOURCE, toInput } from '../../ingestion/test/support/import-harness';
import { arbListing } from '../../shared/test/arbitraries';
import { createDeletionHarness } from './support/deletion-harness';

/**
 * Property 35: for any deleted id and any following sequence of imports and queries — until the
 * block is lifted explicitly — the detail lookup answers `NOT_FOUND` (404), no search returns the
 * listing, and every import of the id is rejected with „Löschsperre“ without storing anything;
 * also when deletion and import of the same id run concurrently.
 *
 * One world, three views on it:
 * - `listings` (`Map<string, Listing>`) backs the admin `InMemoryDeletionListingStore`, the import
 *   writer and the search side. `InMemorySearchProvider` copies its input, so it is rebuilt from
 *   the map per call (the index follows the store).
 * - The pipeline's `InMemoryDeletionBlocklist` is the mirror of the admin blocklist store, so
 *   blocks and explicit lifts via the admin API are visible to the import pipeline.
 * - `InMemoryListingWriter` keeps its own map, so a small writer on the shared map stands in for
 *   it. Like `DynamoDbListingWriter` (one `TransactWriteItems` with a blocklist `ConditionCheck`)
 *   it checks the blocklist and puts in one step.
 *
 * After an initial deletion via `POST /admin/deletions` a random sequence of imports, deletions
 * (by id or source), explicit lifts (`DELETE /admin/deletion-blocklist/{id}`), detail lookups and
 * searches runs against a model (present listings, blocked ids). After a lift, a re-import must
 * succeed. A `race` step runs `POST /admin/deletions` and an import of the same id with
 * `Promise.all`; `fc.scheduler` orders the effect points (pipeline pre-check, write, block,
 * removal). Afterwards the listing is gone, the id is blocked, the import was either an `updated`
 * before the block or rejected with „Löschsperre“, and a further import is rejected.
 *
 * **Validates: Requirements 18.5, 18.6, 18.7**
 */

const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const ADMIN = 'arn:aws:iam::123456789012:user/admin';

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const schemas = buildSchemas(taxonomy, {
  defaultLocale: 'de',
  enabled: [{ locale: 'de', label: 'Deutsch' }],
});
const tourProviders = TourProvidersConfig.parse({ providers: [] });
const DELETION_BLOCK_ISSUES = [{ field: 'id', reason: DELETION_BLOCK_REASON }];

// ---------------------------------------------------------------------------------------------
// Shared world
// ---------------------------------------------------------------------------------------------

/** Pipeline blocklist plus a synchronous view, so the writer can check and put in one step. */
class WorldBlocklist extends InMemoryDeletionBlocklist {
  private readonly blocked = new Set<string>();

  override add(listingId: string): void {
    super.add(listingId);
    this.blocked.add(listingId);
  }

  override remove(listingId: string): void {
    super.remove(listingId);
    this.blocked.delete(listingId);
  }

  isBlocked(listingId: string): boolean {
    return this.blocked.has(listingId);
  }
}

/** `InMemoryListingWriter` semantics on the shared map; check + put without an await between. */
class SharedMapListingWriter implements ListingWriter {
  constructor(
    private readonly listings: Map<string, Listing>,
    private readonly blocklist: WorldBlocklist,
  ) {}

  async write(listing: Listing): Promise<WriteOutcome> {
    if (this.blocklist.isBlocked(listing.id)) throw new DeletionBlockedError(listing.id);
    const outcome = this.listings.has(listing.id) ? 'updated' : 'imported';
    this.listings.set(listing.id, structuredClone(listing));
    return outcome;
  }
}

/** Search provider over the current content of the map. */
function liveProvider(listings: Map<string, Listing>): SearchProvider {
  const snapshot = () => new InMemorySearchProvider([...listings.values()]);
  return {
    search: (q) => snapshot().search(q),
    getById: (id) => snapshot().getById(id),
  };
}

const parse = (body: string) => JSON.parse(body) as Record<string, unknown>;

function request(httpMethod: string, path: string, body?: unknown): AdminRequest {
  return {
    httpMethod,
    path,
    body: body === undefined ? null : JSON.stringify(body),
    requestContext: { identity: { userArn: ADMIN } },
  };
}

interface Logged {
  event: string;
  listingId?: string;
  source?: string;
  issues?: { field: string; reason: string }[];
}

function createWorld(initial: readonly Listing[], s: fc.Scheduler) {
  const listings = new Map(initial.map((l) => [l.id, structuredClone(l)]));
  const blocklist = new WorldBlocklist();
  const harness = createDeletionHarness({ listings, blocklistMirror: blocklist, clock: () => T0 });

  // Effect points; only ordered by the scheduler during a `race` step.
  let racing = false;
  const gate = async (label: string): Promise<void> => {
    if (racing) await s.schedule(Promise.resolve(label), label);
  };
  const block = harness.blocklist.block.bind(harness.blocklist);
  harness.blocklist.block = async (entry) => {
    await gate('deletion: block');
    return block(entry);
  };
  const remove = harness.listings.removeForRequest.bind(harness.listings);
  harness.listings.removeForRequest = async (listingId, requestId) => {
    await gate('deletion: remove');
    return remove(listingId, requestId);
  };

  let requestIds = 0;
  const handler = createAdminHandler({
    apiKeys: new InMemoryApiKeyStore(),
    accessConfig: new StaticAccessConfigSource({
      mode: 'open',
      rateLimit: { requests: 1_000_000, windowSeconds: 60 },
    }),
    audit: harness.audit,
    clock: () => T0,
    deletions: { ...harness.deletions, newRequestId: () => `req-${++requestIds}` },
  });

  const writer = new SharedMapListingWriter(listings, blocklist);
  let writes = 0;
  const pipeline = new ImportPipeline({
    listingSchema: schemas.listing,
    blocklist: {
      has: async (id) => {
        await gate('import: pre-check');
        return blocklist.has(id);
      },
    },
    writer: {
      write: async (listing) => {
        await gate('import: write');
        writes += 1;
        return writer.write(listing);
      },
    },
    tourProviders,
    now: () => NOW,
  });

  let runs = 0;
  async function importListing(content: Listing) {
    const runId = `run-${++runs}`;
    const lines: string[] = [];
    const logger = createRunLogger({
      runId,
      source: SOURCE,
      sink: (line) => lines.push(line),
      now: () => NOW,
    });
    const outcome = await pipeline.process(toInput(content), { runId, source: SOURCE, logger });
    const rejections = lines
      .map((line) => JSON.parse(line) as Logged)
      .filter((e) => e.event === 'record.rejected');
    return { runId, outcome, rejections };
  }

  const provider = liveProvider(listings);
  const search = createSearchService({ provider, taxonomy, tourProviders, defaultCurrency: 'EUR' });
  const detail = createListingService({ provider, taxonomy });

  /** All result ids of a query, following `nextPageToken`. */
  async function searchAll(raw: Record<string, unknown>): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 100; page++) {
      const parsed = parseSearchQuery({ ...raw, ...(pageToken && { pageToken }) }, schemas);
      if (!parsed.ok) throw new Error(`invalid query: ${JSON.stringify(parsed.error)}`);
      const result = await search.search(parsed.value, []);
      if (!result.ok) throw new Error(`search failed: ${JSON.stringify(result.error)}`);
      ids.push(...result.value.items.map((l) => l.id));
      pageToken = result.value.nextPageToken;
      if (pageToken === undefined) return ids;
    }
    throw new Error('pagination did not terminate');
  }

  return {
    listings,
    blocklist,
    harness,
    handler,
    importListing,
    searchAll,
    detail,
    writes: () => writes,
    setRacing: (on: boolean) => (racing = on),
  };
}

type World = ReturnType<typeof createWorld>;

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

/** An id of the pool, or the n-th currently blocked id (resolved when the step runs). */
type Target = { pool: number } | { blocked: number };

type FilterField = 'none' | 'offerType' | 'city' | 'postalCode' | 'type';

type Op =
  | { kind: 'import'; target: Target; content: Listing }
  | { kind: 'delete'; target: Target }
  | { kind: 'deleteSource'; source: number }
  | { kind: 'unblock'; target: Target }
  | { kind: 'detail'; target: Target }
  | { kind: 'search'; target: Target; field: FilterField; pageSize: number }
  | { kind: 'race'; target: Target; content: Listing };

const arbIndex = fc.nat({ max: 20 });
const arbTarget: fc.Arbitrary<Target> = fc.oneof(
  arbIndex.map((pool) => ({ pool })),
  arbIndex.map((blocked) => ({ blocked })),
);

const arbOp: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant('import'), target: arbTarget, content: arbListing() }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('delete'), target: arbTarget }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('deleteSource'), source: arbIndex }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('unblock'), target: arbTarget }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('detail'), target: arbTarget }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('search'),
      target: arbTarget,
      field: fc.constantFrom<FilterField>('none', 'offerType', 'city', 'postalCode', 'type'),
      pageSize: fc.integer({ min: 1, max: 5 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('race'), target: arbTarget, content: arbListing() }),
  },
) as fc.Arbitrary<Op>;

/** Pool of 2–7 ids; the first `initial` listings are stored up front, the first one is deleted. */
const arbScenario = fc
  .uniqueArray(arbListing(), { minLength: 2, maxLength: 7, selector: (l) => l.id })
  .chain((pool) =>
    fc.record({
      pool: fc.constant(pool),
      initialCount: fc.integer({ min: 1, max: pool.length }),
      ops: fc.array(arbOp, { minLength: 1, maxLength: 15 }),
    }),
  );

/** Model: present listings (expected stored content) and blocked ids. */
interface Model {
  present: Map<string, Listing>;
  blocked: Set<string>;
  /** Latest content stored or offered for an id; search filters are derived from it. */
  lastContent: Map<string, Listing>;
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function resolveTarget(target: Target, pool: readonly string[], model: Model): string {
  if ('blocked' in target && model.blocked.size > 0) {
    const blocked = [...model.blocked].sort(byId);
    return blocked[target.blocked % blocked.length] as string;
  }
  const index = 'pool' in target ? target.pool : target.blocked;
  return pool[index % pool.length] as string;
}

function filterQuery(field: FilterField, content: Listing | undefined, pageSize: number) {
  const raw: Record<string, unknown> = { pageSize: String(pageSize) };
  if (content === undefined || field === 'none') return raw;
  if (field === 'offerType') raw['offerType'] = content.offers[0]?.offerType;
  if (field === 'city') raw['city'] = content.address.city;
  if (field === 'postalCode') raw['postalCode'] = content.address.postalCode;
  if (field === 'type') raw['types'] = content.listingType;
  // Arbitrary city/postal code strings may not be valid query values; then search unfiltered.
  return parseSearchQuery(raw, schemas).ok ? raw : { pageSize: String(pageSize) };
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

async function deleteById(world: World, model: Model, id: string) {
  const res = await world.handler(request('POST', '/admin/deletions', { listingId: id }));
  if (!model.present.has(id)) {
    expect(res.statusCode).toBe(404);
    expect(parse(res.body)).toMatchObject({ errors: [{ code: 'DELETION_TARGET_NOT_FOUND' }] });
    return;
  }
  expect(res.statusCode).toBe(202);
  const requestId = parse(res.body)['requestId'] as string;
  expect(await world.harness.requests.get(requestId)).toMatchObject({
    status: 'EXECUTED',
    removedCount: 1,
  });
  model.present.delete(id);
  model.blocked.add(id);
}

async function deleteBySource(world: World, model: Model, source: string) {
  const targets = [...model.present.values()].filter((l) => l.source === source).map((l) => l.id);
  const res = await world.handler(request('POST', '/admin/deletions', { source }));
  if (targets.length === 0) {
    expect(res.statusCode).toBe(404);
    return;
  }
  expect(res.statusCode).toBe(202);
  const requestId = parse(res.body)['requestId'] as string;
  expect(await world.harness.requests.get(requestId)).toMatchObject({
    status: 'EXECUTED',
    removedCount: targets.length,
  });
  targets.forEach((id) => {
    model.present.delete(id);
    model.blocked.add(id);
  });
}

/** Sequential import with the expected outcome from the model. */
async function importStep(world: World, model: Model, content: Listing) {
  const writesBefore = world.writes();
  const { runId, outcome, rejections } = await world.importListing(content);
  if (model.blocked.has(content.id)) {
    // Rejected at the pre-check: the writer is never called (Req 18.7).
    expect(outcome).toBe('rejected');
    expect(rejections).toEqual([
      expect.objectContaining({
        listingId: content.id,
        source: SOURCE,
        issues: DELETION_BLOCK_ISSUES,
      }),
    ]);
    expect(world.writes()).toBe(writesBefore);
    return;
  }
  expect(rejections).toEqual([]);
  expect(outcome).toBe(model.present.has(content.id) ? 'updated' : 'imported');
  const stored = expectedStored(content, runId);
  model.present.set(content.id, stored);
  model.lastContent.set(content.id, stored);
}

/** `POST /admin/deletions` and an import of the same id concurrently, ordered by `s`. */
async function raceStep(world: World, model: Model, s: fc.Scheduler, content: Listing) {
  const { id } = content;
  const wasBlocked = model.blocked.has(id);
  // A deletion needs a target; an unknown, unblocked id is imported first.
  if (!wasBlocked && !model.present.has(id)) await importStep(world, model, content);

  world.setRacing(true);
  const both = Promise.all([
    world.handler(request('POST', '/admin/deletions', { listingId: id })),
    world.importListing(content),
  ]);
  const [res, imported] = await s.waitFor(both);
  world.setRacing(false);

  // Whatever the order: rejected with „Löschsperre“, or an update that was then removed.
  if (imported.outcome === 'rejected') {
    expect(imported.rejections).toEqual([
      expect.objectContaining({ listingId: id, source: SOURCE, issues: DELETION_BLOCK_ISSUES }),
    ]);
  } else {
    expect(wasBlocked).toBe(false);
    expect(imported.outcome).toBe('updated');
  }

  if (wasBlocked) {
    expect(res.statusCode).toBe(404);
    expect(imported.outcome).toBe('rejected');
  } else {
    expect(res.statusCode).toBe(202);
    const requestId = parse(res.body)['requestId'] as string;
    expect(await world.harness.requests.get(requestId)).toMatchObject({
      status: 'EXECUTED',
      removedCount: 1,
    });
    model.present.delete(id);
    model.blocked.add(id);
    if (imported.outcome === 'updated')
      model.lastContent.set(id, expectedStored(content, imported.runId));
  }
  expect(world.listings.has(id)).toBe(false);

  // Any import after the block is rejected.
  await importStep(world, model, content);
}

async function unblockStep(world: World, model: Model, id: string) {
  const res = await world.handler(
    request('DELETE', `/admin/deletion-blocklist/${encodeURIComponent(id)}`),
  );
  if (!model.blocked.has(id)) {
    expect(res.statusCode).toBe(404);
    return;
  }
  expect(res.statusCode).toBe(200);
  expect(await world.blocklist.has(id)).toBe(false);
  model.blocked.delete(id);
}

async function detailStep(world: World, model: Model, id: string) {
  const result = await world.detail.get(id, []);
  if (model.present.has(id)) {
    expect(result.ok && result.value.id).toBe(id);
  } else {
    expect(result).toEqual({ ok: false, error: [expect.objectContaining({ code: 'NOT_FOUND' })] });
  }
}

async function searchStep(world: World, model: Model, raw: Record<string, unknown>) {
  const ids = await world.searchAll(raw);
  ids.forEach((id) => {
    expect(model.blocked.has(id)).toBe(false);
    expect(model.present.has(id)).toBe(true);
  });
}

/** Store, blocklists, detail and unfiltered search agree with the model after every step. */
async function checkState(world: World, model: Model) {
  expect(Object.fromEntries(world.listings)).toEqual(Object.fromEntries(model.present));
  const blocked = [...model.blocked].sort(byId);
  expect(world.harness.blocklist.ids().sort(byId)).toEqual(blocked);
  for (const id of blocked) {
    expect(world.listings.has(id)).toBe(false);
    expect(await world.blocklist.has(id)).toBe(true);
    await detailStep(world, model, id);
  }
  const all = await world.searchAll({ pageSize: '50' });
  expect(all.sort(byId)).toEqual([...model.present.keys()].sort(byId));
}

async function runOp(
  world: World,
  model: Model,
  s: fc.Scheduler,
  ids: string[],
  sources: string[],
  op: Op,
) {
  switch (op.kind) {
    case 'import':
      return importStep(world, model, { ...op.content, id: resolveTarget(op.target, ids, model) });
    case 'delete':
      return deleteById(world, model, resolveTarget(op.target, ids, model));
    case 'deleteSource':
      return deleteBySource(world, model, sources[op.source % sources.length] as string);
    case 'unblock':
      return unblockStep(world, model, resolveTarget(op.target, ids, model));
    case 'detail':
      return detailStep(world, model, resolveTarget(op.target, ids, model));
    case 'search': {
      const id = resolveTarget(op.target, ids, model);
      return searchStep(
        world,
        model,
        filterQuery(op.field, model.lastContent.get(id), op.pageSize),
      );
    }
    case 'race':
      return raceStep(world, model, s, { ...op.content, id: resolveTarget(op.target, ids, model) });
  }
}

describe('Property 35: Löschsperre ist dauerhaft', () => {
  it('a deleted id stays unreachable and unimportable until the block is lifted', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, fc.scheduler(), async ({ pool, initialCount, ops }, s) => {
        const initial = pool.slice(0, initialCount);
        const ids = pool.map((l) => l.id);
        const sources = [...new Set([SOURCE, ...initial.map((l) => l.source)])];
        const world = createWorld(initial, s);
        const model: Model = {
          present: new Map(initial.map((l) => [l.id, l])),
          blocked: new Set(),
          lastContent: new Map(initial.map((l) => [l.id, l])),
        };

        await deleteById(world, model, ids[0] as string);
        await checkState(world, model);
        for (const op of ops) {
          await runOp(world, model, s, ids, sources, op);
          await checkState(world, model);
        }
      }),
      { numRuns: 100 },
    );
  });
});
