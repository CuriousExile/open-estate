// Feature: real-estate-platform, Property 13: Abweisung lässt den Bestand unverändert
import {
  connectorConfigSchema,
  ConnectorFramework,
  ConnectorRegistry,
  DELETION_BLOCK_REASON,
  ImportPipeline,
  InMemoryDeletionBlocklist,
  InMemoryListingWriter,
  type Connector,
  type ConnectorModule,
  type DeletionBlocklist,
  type ListingWriter,
} from '@open-estate/ingestion';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  formatDecimal,
  LISTING_BOUNDS as B,
  ListingBase,
  TourProvidersConfig,
  type Listing,
} from '@open-estate/shared';
import fc from 'fast-check';
import { z } from 'zod';
import { arbListing, arbRentOffer, arbSaleOffer } from '../../shared/test/arbitraries';
import { NOW, SOURCE, toInput, toInputOffer, type Input, type Obj } from './support/import-harness';

/**
 * Property 13: for any store state S and any rejected candidate (validation, offer rule, deletion
 * blocklist) the store equals S after processing; in particular an existing version with the same
 * `id` is kept.
 *
 * Strategy: S is a set of valid listings with unique ids, written directly into an
 * `InMemoryListingWriter`. One connector run emits 1–5 candidates, each rejected for one reason:
 * - `validation`: a valid listing in the input format with one schema violation (Req 4.9, 5.6),
 * - `offer-rule`: a valid listing whose offers violate an offer rule (Req 12.4, 12.5, 12.11),
 * - `blocked-before`: a valid listing whose id is on the blocklist before the run (pre-check),
 * - `blocked-at-write`: a valid listing whose id is blocked right after the pipeline's pre-check,
 *   so only the writer's transactional re-check (`ConditionCheck`) can reject it.
 * Candidates mostly reuse an id from S. The whole run goes through `ConnectorFramework`, so the
 * run counters are the real ones (Req 5.8).
 *
 * A small model tracks the blocklist over the run: an attributable id that is blocked when the
 * candidate arrives is rejected with „Löschsperre“ and never reaches the writer; a
 * `blocked-at-write` candidate reaches the writer exactly once and is rejected there.
 *
 * **Validates: Requirements 4.9, 5.6, 12.4, 12.5, 12.11**
 */

const RUN_ID = 'run-13';
const MODULE_NAME = 'emit-candidates';

const listingSchema = buildSchemas(assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG), {
  defaultLocale: 'de',
  enabled: [{ locale: 'de', label: 'Deutsch' }],
}).listing;
const tourProviders = TourProvidersConfig.parse({ providers: [] });
const ListingId = ListingBase.shape.id;

type Kind = 'validation' | 'offer-rule' | 'blocked-before' | 'blocked-at-write';

interface Violation {
  readonly name: string;
  readonly apply: (input: Input) => void;
}

interface RejectedCase {
  readonly kind: Kind;
  readonly name: string;
  readonly input: Input;
  readonly [fc.toStringMethod]: () => string;
}

// ---------------------------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------------------------

const violation = (name: string, apply: (input: Input) => void): Violation => ({ name, apply });

const setTop = (key: string, value: unknown) =>
  violation(`${key} = ${JSON.stringify(value) ?? 'removed'}`.slice(0, 60), (input) => {
    if (value === undefined) Reflect.deleteProperty(input, key);
    else input[key] = value;
  });

const setNested = (parent: string, key: string, value: unknown) =>
  violation(`${parent}.${key} = ${JSON.stringify(value) ?? 'removed'}`, (input) => {
    const target = (input[parent] ?? {}) as Obj;
    if (value === undefined) Reflect.deleteProperty(target, key);
    else target[key] = value;
    input[parent] = target;
  });

/** Schema violations outside the offers (Req 4.9, 5.6); one of them makes `id` unattributable. */
const VALIDATION: readonly Violation[] = [
  setTop('id', 'x'.repeat(B.id.max + 1)),
  setTop('title', ''),
  setTop('title', undefined),
  setTop('listingType', 'castle'),
  setTop('sourceUrl', 'ftp://files.example/listing'),
  setTop('rooms', 2.3),
  setTop('area', '0.99'),
  setTop('originalLocale', undefined),
  setTop('address', undefined),
  setNested('address', 'country', 'DEU'),
  setNested('geo', 'lat', 90.5),
];

const replaceOffers = (name: string, offers: Obj[]) =>
  violation(name, (input) => {
    input['offers'] = offers;
  });

/** Offer-rule violations (Req 12.1, 12.4, 12.5, 12.11). */
const arbOfferViolation: fc.Arbitrary<Violation> = fc.oneof(
  fc.constant(replaceOffers('no offer', [])),
  fc
    .tuple(arbSaleOffer, arbRentOffer, arbSaleOffer)
    .map((offers) => replaceOffers('three offers', offers.map(toInputOffer))),
  fc
    .oneof(fc.tuple(arbSaleOffer, arbSaleOffer), fc.tuple(arbRentOffer, arbRentOffer))
    .map((offers) => replaceOffers('two offers of the same type', offers.map(toInputOffer))),
  fc
    .tuple(arbSaleOffer, fc.constantFrom('additionalCosts', 'warmRent'))
    .map(([offer, key]) =>
      replaceOffers(`SALE with ${key}`, [{ ...toInputOffer(offer), [key]: '10.00' }]),
    ),
  arbRentOffer
    .filter((offer) => offer.coldRent > B.money.minMinor)
    .map((offer) =>
      replaceOffers('RENT with warmRent < coldRent', [
        { ...toInputOffer(offer), warmRent: formatDecimal(offer.coldRent - 1) },
      ]),
    ),
  arbRentOffer.map((offer) => {
    const input = toInputOffer(offer);
    delete input['coldRent'];
    return replaceOffers('RENT without coldRent', [input]);
  }),
  fc
    .tuple(arbSaleOffer, fc.constantFrom<unknown>('LEASE', 'sale', undefined))
    .map(([offer, code]) =>
      replaceOffers(`offerType = ${String(JSON.stringify(code))}`, [
        { ...toInputOffer(offer), offerType: code },
      ]),
    ),
);

const NO_VIOLATION = violation('valid', () => undefined);

const arbKindAndViolation: fc.Arbitrary<[Kind, Violation]> = fc.oneof(
  fc.constantFrom(...VALIDATION).map((v): [Kind, Violation] => ['validation', v]),
  arbOfferViolation.map((v): [Kind, Violation] => ['offer-rule', v]),
  fc.constant<[Kind, Violation]>(['blocked-before', NO_VIOLATION]),
  fc.constant<[Kind, Violation]>(['blocked-at-write', NO_VIOLATION]),
);

/** A rejected candidate; its id is taken from `storeIds` most of the time. */
function arbCase(storeIds: readonly string[]): fc.Arbitrary<RejectedCase> {
  const arbIdOverride: fc.Arbitrary<string | undefined> =
    storeIds.length === 0
      ? fc.constant(undefined)
      : fc.oneof(
          { arbitrary: fc.constantFrom(...storeIds), weight: 3 },
          { arbitrary: fc.constant(undefined), weight: 1 },
        );
  return fc
    .tuple(arbListing(), arbIdOverride, arbKindAndViolation)
    .map(([listing, id, [kind, v]]) => {
      const input = structuredClone(toInput(id === undefined ? listing : { ...listing, id }));
      v.apply(input);
      const name = `${kind}: ${v.name}`;
      return {
        kind,
        name,
        input,
        [fc.toStringMethod]: () => `${name} (id ${String(input['id'])})`,
      };
    });
}

/** S (0–5 listings with unique ids) and 1–5 rejected candidates for one run. */
const arbScenario = fc
  .uniqueArray(arbListing(), { maxLength: 5, selector: (l) => l.id })
  .chain((store) =>
    fc.tuple(
      fc.constant(store),
      fc.array(arbCase(store.map((l) => l.id)), { minLength: 1, maxLength: 5 }),
    ),
  );

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

/** Every id the store could hold: S plus all candidate ids (a stray insert would show up here). */
function snapshot(store: InMemoryListingWriter, ids: readonly string[]) {
  return {
    size: store.size,
    listings: Object.fromEntries(ids.map((id) => [id, store.get(id)])),
  };
}

const attributableId = (input: Input): string | undefined => {
  const parsed = ListingId.safeParse(input['id']);
  return parsed.success ? parsed.data : undefined;
};

/** Attributable ids of the candidates of one kind. */
const idsOf = (cases: readonly RejectedCase[], kind: Kind): string[] =>
  cases.filter((c) => c.kind === kind).flatMap((c) => attributableId(c.input) ?? []);

async function runScenario(initial: readonly Listing[], cases: readonly RejectedCase[]) {
  // S is written before any id is blocked; the deletions behind the blocklist are not modelled.
  const blocklist = new InMemoryDeletionBlocklist();
  const store = new InMemoryListingWriter(blocklist);
  for (const listing of initial) await store.write(listing);
  idsOf(cases, 'blocked-before').forEach((id) => blocklist.add(id));
  // Candidate being processed; connectors emit sequentially.
  let current: RejectedCase | undefined;
  // Pre-check of the pipeline: for a `blocked-at-write` candidate the deletion of its id happens
  // right after the check, i.e. between pre-check and write.
  const pipelineBlocklist: DeletionBlocklist = {
    has: async (id) => {
      const blocked = await blocklist.has(id);
      if (current?.kind === 'blocked-at-write') blocklist.add(id);
      return blocked;
    },
  };

  const writeAttempts: string[] = [];
  const writer: ListingWriter = {
    write: (listing) => {
      writeAttempts.push(listing.id);
      return store.write(listing);
    },
  };

  const pipeline = new ImportPipeline({
    listingSchema,
    blocklist: pipelineBlocklist,
    writer,
    tourProviders,
    now: () => NOW,
  });
  const module: ConnectorModule = {
    name: MODULE_NAME,
    type: 'external-api',
    settingsSchema: z.strictObject({}),
    create: (): Connector => ({
      type: 'external-api',
      initialize: async () => undefined,
      run: async (ctx) => {
        for (const c of cases) {
          current = c;
          await ctx.emit(c.input);
        }
      },
      reportStatus: () => ({ state: 'idle', imported: 0, updated: 0, rejected: 0 }),
    }),
  };
  const lines: string[] = [];
  const framework = new ConnectorFramework({
    registry: new ConnectorRegistry([module]),
    processor: pipeline,
    sink: (line) => lines.push(line),
    now: () => NOW,
  });
  const config = connectorConfigSchema.parse({
    id: SOURCE,
    type: 'external-api',
    module: MODULE_NAME,
    enabled: true,
    schedule: 'rate(1 hour)',
  });

  const ids = [
    ...new Set([
      ...initial.map((l) => l.id),
      ...cases.flatMap((c) => attributableId(c.input) ?? []),
    ]),
  ];
  const before = snapshot(store, ids);
  const summary = await framework.runConnector(config, { runId: RUN_ID });
  const after = snapshot(store, ids);
  const rejections = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((e) => e['event'] === 'record.rejected')
    .map((e) => ({
      listingId: e['listingId'] as string | undefined,
      issues: e['issues'] as { field: string; reason: string }[],
    }));
  return { summary, before, after, rejections, writeAttempts };
}

/** Model: expected log entry per candidate and the ids that must reach the writer. */
function expectations(cases: readonly RejectedCase[]) {
  const blocked = new Set(idsOf(cases, 'blocked-before'));
  const writes: string[] = [];
  const entries = cases.map((c) => {
    const id = attributableId(c.input);
    if (id !== undefined && blocked.has(id)) return { listingId: id, deletionBlock: true };
    if (c.kind === 'blocked-at-write' && id !== undefined) {
      blocked.add(id);
      writes.push(id);
      return { listingId: id, deletionBlock: true };
    }
    return { listingId: id, deletionBlock: false };
  });
  return { entries, writes };
}

const DELETION_BLOCK_ISSUES = [{ field: 'id', reason: DELETION_BLOCK_REASON }];

describe('Property 13: Abweisung lässt den Bestand unverändert', () => {
  it('leaves the store unchanged and counts every candidate as rejected', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async ([initial, cases]) => {
        const { summary, before, after, rejections, writeAttempts } = await runScenario(
          initial,
          cases,
        );

        // The store equals S, existing versions with the same id included.
        expect(after).toEqual(before);
        initial.forEach((listing) => expect(after.listings[listing.id]).toEqual(listing));

        // Run counters (Req 5.8).
        expect(summary.status).toBe('SUCCESS');
        expect({ imported: summary.imported, updated: summary.updated }).toEqual({
          imported: 0,
          updated: 0,
        });
        expect(summary.rejected).toBe(cases.length);

        // One rejection per candidate, with the expected reason; only race candidates are written.
        const expected = expectations(cases);
        expect(writeAttempts).toEqual(expected.writes);
        expect(rejections).toHaveLength(cases.length);
        rejections.forEach((rejection, i) => {
          const entry = expected.entries[i];
          expect(rejection.listingId).toBe(entry?.listingId);
          if (entry?.deletionBlock === true)
            expect(rejection.issues).toEqual(DELETION_BLOCK_ISSUES);
          else expect(rejection.issues.some((x) => x.reason === DELETION_BLOCK_REASON)).toBe(false);
        });
      }),
      { numRuns: 100 },
    );
  });
});
