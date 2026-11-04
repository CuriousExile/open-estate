// Feature: real-estate-platform, Property 14: Upsert ersetzt vollständig und ist idempotent
import { toManagedListingItem } from '@open-estate/core';
import {
  createRunLogger,
  ImportPipeline,
  InMemoryImportStore,
  type RecordProcessingContext,
} from '@open-estate/ingestion';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  LISTING_BOUNDS as B,
  PII_FIELD_PATHS,
  TourProvidersConfig,
  type Listing,
  type RentOffer,
} from '@open-estate/shared';
import fc from 'fast-check';
import { arbListing, arbMoneyMinor, arbSaleOffer, arbUrl } from '../../shared/test/arbitraries';
import { NOW, SOURCE, toInput, type Input } from './support/import-harness';

/**
 * Property 14: for any store state and any valid listing l with an existing or new `id`, the
 * stored record afterwards equals exactly l (enriched with provenance), media and tours replaced
 * completely and no leftovers of the previous version; importing l a second time changes neither
 * the record nor the number of records.
 *
 * Strategy: the store holds 0–3 unrelated listings and, most of the time, a "rich" previous
 * version of l's id (geo, street, full contact, translations, SALE + RENT with optional amounts,
 * several media and tours) imported earlier by the same connector. l is either an arbitrary
 * listing or a sparse one (SALE only, no geo/street/contact/translations/tours, at most two
 * media), so the replacement has to drop fields, flat search fields (`rentAmountMinor`,
 * `tourHosts`) and list elements. l goes through the full `ImportPipeline` twice (same run, fixed
 * clock, Importmodus `REPLACE` as for the bundled full-feed modules) against an
 * `InMemoryImportStore` (`VersionedListingWriter`): the stored listing equals the enriched l and
 * the stored item equals `toManagedListingItem(enriched l, management)`. The second import yields
 * `unchanged` (same Inhalts_Hash, no version, Req 7.3). The pipeline keeps contact (all PII paths
 * allow-listed) and tours (their hosts are on the tour allow-list), so every field of l can reach
 * the store.
 *
 * **Validates: Requirements 4.11, 16.3**
 */

const RUN_ID = 'run-14';

const listingSchema = buildSchemas(assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG), {
  defaultLocale: 'de',
  enabled: [{ locale: 'de', label: 'Deutsch' }],
}).listing;

const TOUR_PROVIDERS = [
  { code: 'tour-a', hostnames: ['tours-a.example'] },
  { code: 'tour-b', hostnames: ['tours-b.example', 'view.tours-b.example'] },
] as const;
const tourProviders = TourProvidersConfig.parse({
  providers: TOUR_PROVIDERS.map((p) => ({ code: p.code, hostnames: [...p.hostnames] })),
});
const TOUR_HOSTS = TOUR_PROVIDERS.flatMap((p) =>
  p.hostnames.map((host) => ({ host, code: p.code })),
);

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

/** Tour on an allow-listed host with the provider code the pipeline derives from it. */
const arbAllowedTour: fc.Arbitrary<Listing['tours'][number]> = fc
  .tuple(fc.constantFrom(...TOUR_HOSTS), fc.stringMatching(/^[a-z0-9-]{1,20}$/))
  .map(([{ host, code }, path]) => ({ url: `https://${host}/${path}`, providerCode: code }));

/** RENT offer with both optional amounts. */
const arbFullRentOffer: fc.Arbitrary<RentOffer> = arbMoneyMinor.chain((coldRent) =>
  fc.record({
    offerType: fc.constant('RENT' as const),
    coldRent: fc.constant(coldRent),
    currency: fc.stringMatching(/^[A-Z]{3}$/),
    additionalCosts: arbMoneyMinor,
    warmRent: fc.integer({ min: coldRent, max: B.money.maxMinor }),
  }),
);

const arbContact = fc.record({
  name: fc.string({ minLength: B.contactName.min, maxLength: B.contactName.max }),
  phone: fc.string({ minLength: B.contactPhone.min, maxLength: B.contactPhone.max }),
  email: fc.string({ minLength: B.contactEmail.min, maxLength: B.contactEmail.max }),
});

/** Previous version with as many optional parts as possible; tours on arbitrary hosts. */
const arbRichOld: fc.Arbitrary<Listing> = fc
  .tuple(
    arbListing().filter((l) => l.translations.length > 0),
    fc.record({ lat: fc.integer({ min: -90, max: 90 }), lon: fc.integer({ min: -180, max: 180 }) }),
    fc.string({ minLength: B.street.min, maxLength: B.street.max }),
    arbContact,
    arbSaleOffer,
    arbFullRentOffer,
    fc.array(fc.record({ url: arbUrl() }), { minLength: 3, maxLength: B.media.max }),
    fc.array(fc.record({ url: arbUrl(), providerCode: fc.constantFrom('old-a', 'old-b') }), {
      minLength: 2,
      maxLength: B.tours.max,
    }),
  )
  .map(([base, geo, street, contact, sale, rent, media, tours]) => ({
    ...base,
    geo,
    address: { ...base.address, street },
    contact,
    offers: [sale, rent],
    media,
    tours,
  }));

/** Valid listing whose tours the pipeline keeps unchanged. */
const arbFullNext: fc.Arbitrary<Listing> = fc
  .tuple(arbListing(), fc.array(arbAllowedTour, { maxLength: B.tours.max }))
  .map(([listing, tours]) => ({ ...listing, tours }));

/** Sparse listing: SALE only, no geo/street/contact/translations/tours, at most two media. */
const arbSparseNext: fc.Arbitrary<Listing> = arbListing({ offerTypes: [['SALE']] }).map(
  (listing) => {
    const sparse: Listing = {
      ...listing,
      address: {
        city: listing.address.city,
        postalCode: listing.address.postalCode,
        country: listing.address.country,
      },
      translations: [],
      media: listing.media.slice(0, 2),
      tours: [],
    };
    delete sparse.geo;
    delete sparse.contact;
    return sparse;
  },
);

interface Scenario {
  readonly others: readonly Listing[];
  readonly previous: Listing | undefined;
  readonly next: Listing;
}

const arbScenario: fc.Arbitrary<Scenario> = fc
  .record({
    others: fc.uniqueArray(arbListing(), { maxLength: 3, selector: (l) => l.id }),
    previous: fc.option(arbRichOld, { nil: undefined, freq: 4 }),
    next: fc.oneof(arbFullNext, arbSparseNext),
  })
  .map(({ others, previous, next }) => ({
    others,
    previous,
    next: previous === undefined ? next : { ...next, id: previous.id },
  }))
  .filter(({ others, previous, next }) => {
    const ids = [...others.map((l) => l.id), ...(previous === undefined ? [] : [previous.id])];
    return new Set(ids).size === ids.length && !others.some((l) => l.id === next.id);
  });

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

/** l as a connector delivers it: contact and tours (URL only) included. */
function toFullInput(listing: Listing): Input {
  return {
    ...toInput(listing),
    tours: listing.tours.map((t) => ({ url: t.url })),
    ...(listing.contact !== undefined && { contact: { ...listing.contact } }),
  };
}

/** What the pipeline must store for l: l with this run's provenance. */
const enriched = (listing: Listing): Listing => ({
  ...listing,
  source: SOURCE,
  lastImportedAt: NOW.toISOString(),
  lastRunId: RUN_ID,
});

function setup() {
  const store = new InMemoryImportStore({ clock: () => NOW.getTime() });
  const pipeline = new ImportPipeline({
    listingSchema,
    reader: store.reader,
    writer: store.writer,
    tourProviders,
    piiAllowlist: { allowedFields: [...PII_FIELD_PATHS] },
  });
  const ctx: RecordProcessingContext = {
    runId: RUN_ID,
    source: SOURCE,
    importMode: 'REPLACE',
    logger: createRunLogger({
      runId: RUN_ID,
      source: SOURCE,
      sink: () => undefined,
      now: () => NOW,
    }),
  };
  /** Raw stored item (listing, flat search fields, management attributes). */
  const item = (id: string) => store.listings.all().find((stored) => stored.id === id);
  return { store, item, process: (raw: Input) => pipeline.process(raw, ctx) };
}

async function checkUpsert({ others, previous, next }: Scenario) {
  const t = setup();
  for (const listing of others) await t.store.seed(listing);
  // The previous version was imported by the same connector (provenance `source` is kept).
  if (previous !== undefined) await t.store.seed({ ...previous, source: SOURCE });
  const othersBefore = others.map((listing) => t.store.get(listing.id));
  const sizeBefore = t.store.size;
  // structuredClone: generated objects have a null prototype, stored ones a plain one.
  const expected = structuredClone(enriched(next));
  const input = toFullInput(next);

  // First import: new id ⇒ imported, existing id ⇒ updated; stored record is exactly l.
  expect(await t.process(structuredClone(input))).toBe(
    previous === undefined ? 'imported' : 'updated',
  );
  // `toStrictEqual` also fails on extra keys, i.e. leftovers of the previous version.
  expect(t.store.get(next.id)).toStrictEqual(expected);
  const management = t.store.managed(next.id)?.management;
  expect(management).toBeDefined();
  if (management !== undefined) {
    expect(t.item(next.id)).toStrictEqual(toManagedListingItem(expected, management));
  }
  expect(t.store.size).toBe(previous === undefined ? sizeBefore + 1 : sizeBefore);
  const sizeAfterFirst = t.store.size;
  const itemAfterFirst = t.item(next.id);

  // Second import of l: record and record count unchanged, no version (Req 7.3).
  expect(await t.process(structuredClone(input))).toBe('unchanged');
  expect(t.store.get(next.id)).toStrictEqual(expected);
  expect(t.item(next.id)).toStrictEqual(itemAfterFirst);
  expect(t.store.size).toBe(sizeAfterFirst);

  // Unrelated listings are untouched.
  expect(others.map((listing) => t.store.get(listing.id))).toStrictEqual(othersBefore);
}

describe('Property 14: Upsert ersetzt vollständig und ist idempotent', () => {
  it('pipeline + VersionedListingWriter stores exactly l and is idempotent', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        await checkUpsert(scenario);
      }),
      { numRuns: 100 },
    );
  });
});
