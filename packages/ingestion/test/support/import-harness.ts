import {
  createRunLogger,
  ImportPipeline,
  InMemoryImportStore,
  type ImportListingWriter,
  type RecordProcessingContext,
} from '@open-estate/ingestion';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  formatDecimal,
  TourProvidersConfig,
  type Listing,
  type Offer,
} from '@open-estate/shared';

/** Shared harness of the import-validation properties (Property 11, Property 12). */

export const NOW = new Date('2026-11-05T10:00:00.000Z');
export const SOURCE = 'property-source';

export type Input = Record<string, unknown>;
export type Obj = Record<string, unknown>;

const listingSchema = buildSchemas(assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG), {
  defaultLocale: 'de',
  enabled: [{ locale: 'de', label: 'Deutsch' }],
}).listing;
const tourProviders = TourProvidersConfig.parse({ providers: [] });

/** Internal offer → input representation (amounts as decimal strings). */
export function toInputOffer(offer: Offer): Obj {
  if (offer.offerType === 'SALE') {
    return { offerType: 'SALE', price: formatDecimal(offer.price), currency: offer.currency };
  }
  return {
    offerType: 'RENT',
    coldRent: formatDecimal(offer.coldRent),
    currency: offer.currency,
    ...(offer.additionalCosts !== undefined && {
      additionalCosts: formatDecimal(offer.additionalCosts),
    }),
    ...(offer.warmRent !== undefined && { warmRent: formatDecimal(offer.warmRent) }),
  };
}

/**
 * Internal listing → raw record as a connector delivers it: amounts/area as decimal strings,
 * no provenance (set by the pipeline), no contact (PII) and no tours (host allow-list).
 */
export function toInput(listing: Listing): Input {
  return {
    id: listing.id,
    originalLocale: listing.originalLocale,
    title: listing.title,
    description: listing.description,
    translations: listing.translations.map((t) => ({ ...t })),
    offers: listing.offers.map(toInputOffer),
    listingType: listing.listingType,
    rooms: listing.rooms,
    area: formatDecimal(listing.area),
    address: { ...listing.address },
    ...(listing.geo !== undefined && { geo: { ...listing.geo } }),
    sourceUrl: listing.sourceUrl,
    media: listing.media.map((m) => ({ ...m })),
  };
}

/** What the pipeline must store for a valid candidate built by `toInput(listing)`. */
export function expectedStored(listing: Listing, runId: string): Listing {
  const rest = { ...listing };
  delete rest.contact;
  return {
    ...rest,
    tours: [],
    source: SOURCE,
    lastImportedAt: NOW.toISOString(),
    lastRunId: runId,
  };
}

/** Pipeline with in-memory stores, a writer that counts writes and a logger that captures lines. */
export function setupImport(runId: string) {
  const lines: string[] = [];
  const logger = createRunLogger({
    runId,
    source: SOURCE,
    sink: (line) => lines.push(line),
    now: () => NOW,
  });
  const store = new InMemoryImportStore({ clock: () => NOW.getTime() });
  let writes = 0;
  const writer: ImportListingWriter = {
    write: (change) => {
      writes += 1;
      return store.writer.write(change);
    },
  };
  const pipeline = new ImportPipeline({
    listingSchema,
    reader: store.reader,
    writer,
    tourProviders,
  });
  const ctx: RecordProcessingContext = { runId, source: SOURCE, logger };
  const rejectedFields = (): string[] =>
    lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((e) => e['event'] === 'record.rejected')
      .flatMap((e) => (e['issues'] as { field: string }[]).map((i) => i.field));
  return {
    store,
    writes: () => writes,
    rejectedFields,
    process: (raw: Input) => pipeline.process(raw, ctx),
  };
}

/** Zod reports nested paths: a logged field covers an expected one if it equals or lies below it. */
export const covers = (logged: string, expected: string): boolean =>
  logged === expected || logged.startsWith(`${expected}.`);
