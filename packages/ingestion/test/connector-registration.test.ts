import {
  CONNECTOR_TYPES,
  ConnectorFramework,
  connectorsFileSchema,
  createDefaultRegistry,
  ImportPipeline,
  InMemoryImportStore,
  type Connector,
  type ConnectorModule,
  type ConnectorRegistry,
  type ConnectorState,
  type ConnectorType,
  type DbClient,
  type DefaultRegistryDeps,
  type FetchLike,
  type RawRecord,
} from '@open-estate/ingestion';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  TourProvidersConfig,
} from '@open-estate/shared';
import { z } from 'zod';
import { createFakeSecrets } from './support/fake-secrets';

/**
 * Task 10.14: connectors are added purely by registering a module and referencing it in
 * `connectors.json` (Req 5.1, 5.2, 5.3), and a listing with SALE + RENT travels through
 * connector → framework → import pipeline → store with both offers intact.
 */

const NOW = new Date('2026-11-05T10:00:00.000Z');

const listingSchema = buildSchemas(assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG), {
  defaultLocale: 'de',
  enabled: [{ locale: 'de', label: 'Deutsch' }],
}).listing;

/** Listing input with one SALE and one RENT offer, as a connector hands it to the pipeline. */
function saleAndRentRecord(id: string): RawRecord {
  return {
    id,
    originalLocale: 'de',
    title: 'Stadthaus mit Garten',
    description: 'Kauf oder Miete',
    translations: [],
    offers: [
      { offerType: 'SALE', price: '450000', currency: 'EUR' },
      { offerType: 'RENT', coldRent: '1500.00', currency: 'EUR' },
    ],
    listingType: 'loft',
    rooms: 4,
    area: '120.00',
    address: { city: 'Hamburg', postalCode: '20095', country: 'DE' },
    sourceUrl: `https://partner.example/listings/${id}`,
    media: [],
  };
}

/** Framework wired to the real import pipeline and the in-memory listing store. */
function setup(registry: ConnectorRegistry) {
  const store = new InMemoryImportStore({ clock: () => NOW.getTime() });
  const pipeline = new ImportPipeline({
    listingSchema,
    reader: store.reader,
    writer: store.writer,
    tourProviders: TourProvidersConfig.parse({ providers: [] }),
  });
  const framework = new ConnectorFramework({
    registry,
    processor: pipeline,
    sink: () => undefined,
    now: () => NOW,
  });
  const run = (entry: Record<string, unknown>) => {
    const [config] = connectorsFileSchema.parse([
      { enabled: true, schedule: 'rate(1 hour)', ...entry },
    ]);
    if (!config) throw new Error('fixture');
    return framework.runConnector(config, { runId: 'run-7' });
  };
  return { store, run };
}

/** Dummy module for an additional source of the given type, defined entirely in the test. */
function dummyModule(type: ConnectorType): ConnectorModule {
  const settingsSchema = z.strictObject({ ids: z.array(z.string().min(1)).min(1) });
  return {
    name: `acme-${type}`,
    type,
    settingsSchema,
    create(): Connector {
      let state: ConnectorState = 'idle';
      return {
        type,
        initialize: async () => {
          state = 'initialized';
        },
        run: async (ctx) => {
          state = 'running';
          for (const id of settingsSchema.parse(ctx.config).ids)
            await ctx.emit(saleAndRentRecord(id));
          state = 'succeeded';
        },
        reportStatus: () => ({ state, imported: 0, updated: 0, rejected: 0 }),
      };
    },
  };
}

const baseDeps = (overrides: Partial<DefaultRegistryDeps> = {}): DefaultRegistryDeps => ({
  webCrawler: { loadAllowlist: async () => ({}) },
  secrets: createFakeSecrets({}),
  ...overrides,
});

describe('connector registration without core changes', () => {
  it('ships one bundled module per supported source type', () => {
    const registry = createDefaultRegistry(baseDeps());
    expect(CONNECTOR_TYPES).toEqual(['relational-db', 'external-api', 'web-crawler']);
    for (const type of CONNECTOR_TYPES) {
      const resolved = registry.resolve({ id: `bundled-${type}`, type, module: type });
      expect(resolved.ok && resolved.value.type).toBe(type);
    }
  });

  it.each(CONNECTOR_TYPES)(
    'runs a dummy %s connector added to the default registry via configuration only',
    async (type) => {
      const registry = createDefaultRegistry(baseDeps()).register(dummyModule(type));
      const t = setup(registry);

      const summary = await t.run({
        id: 'acme',
        type,
        module: `acme-${type}`,
        settings: { ids: ['D-1', 'D-2'] },
      });

      expect(summary).toMatchObject({
        outcome: 'COMPLETED',
        status: 'SUCCESS',
        source: 'acme',
        imported: 2,
        updated: 0,
        rejected: 0,
      });
      expect(t.store.size).toBe(2);
      expect(t.store.get('D-1')?.offers.map((o) => o.offerType)).toEqual(['SALE', 'RENT']);
      expect(t.store.get('D-1')?.source).toBe('acme');
      // Bundled modules stay resolvable next to the added one.
      expect(registry.names()).toEqual(
        expect.arrayContaining([`acme-${type}`, 'relational-db', 'external-api', 'web-crawler']),
      );
    },
  );
});

/** Source-side mapping of a row/item with both a sale price and a cold rent. */
const saleRentMapping = {
  fields: {
    id: 'ref',
    title: 'headline',
    description: 'text',
    listingType: 'kind',
    rooms: 'rooms',
    area: 'living_area',
    'address.city': 'city',
    'address.postalCode': 'zip',
    'address.country': 'country',
    sourceUrl: 'url',
    'offers[0].price': 'sale_price',
    'offers[1].coldRent': 'cold_rent',
  },
  constants: {
    originalLocale: 'de',
    translations: [],
    media: [],
    'offers[0].offerType': 'SALE',
    'offers[0].currency': 'EUR',
    'offers[1].offerType': 'RENT',
    'offers[1].currency': 'EUR',
  },
};

const sourceRow = {
  ref: 'S-1',
  headline: 'Altbau am Park',
  text: 'Kauf oder Miete möglich',
  kind: 'loft',
  rooms: 3,
  living_area: '88.50',
  city: 'Leipzig',
  zip: '04109',
  country: 'DE',
  url: 'https://partner.example/listings/S-1',
  sale_price: '320000.00',
  cold_rent: '1100.00',
};

const expectedOffers = [
  { offerType: 'SALE', price: 32_000_000, currency: 'EUR' },
  { offerType: 'RENT', coldRent: 110_000, currency: 'EUR' },
];

describe('reference connectors end-to-end into the listing store', () => {
  it('relational-db imports a listing with SALE and RENT offers', async () => {
    const client: DbClient = {
      connect: async () => undefined,
      query: async (_text, values) => ({ rows: values?.at(-1) === 0 ? [sourceRow] : [] }),
      end: async () => undefined,
    };
    const secrets = createFakeSecrets({
      'oe/db': JSON.stringify({ host: 'db', username: 'u', password: 'p', dbname: 'd' }),
    });
    const t = setup(
      createDefaultRegistry(baseDeps({ secrets, relationalDb: { clientFactory: () => client } })),
    );

    const summary = await t.run({
      id: 'partner-db',
      type: 'relational-db',
      module: 'relational-db',
      secretRef: 'oe/db',
      settings: { query: 'SELECT * FROM listings ORDER BY ref', mapping: saleRentMapping },
    });

    expect(summary).toMatchObject({ status: 'SUCCESS', imported: 1, rejected: 0 });
    const stored = t.store.get('S-1');
    expect(stored?.offers).toEqual(expectedOffers);
    expect(stored).toMatchObject({ source: 'partner-db', lastRunId: 'run-7', area: 8850 });
  });

  it('external-api imports a listing with SALE and RENT offers; an identical re-run is unchanged', async () => {
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => [sourceRow],
    });
    const t = setup(createDefaultRegistry(baseDeps({ externalApi: { fetch } })));
    const entry = {
      id: 'partner-api',
      type: 'external-api',
      module: 'external-api',
      settings: { endpoint: 'https://api.partner.example/v1/listings', mapping: saleRentMapping },
    };

    expect(await t.run(entry)).toMatchObject({ status: 'SUCCESS', imported: 1 });
    // Same source data ⇒ same Inhalts_Hash ⇒ no version, counted as unchanged (Req 7.3, 13.2).
    expect(await t.run(entry)).toMatchObject({
      status: 'SUCCESS',
      imported: 0,
      updated: 0,
      unchanged: 1,
    });
    expect(t.store.size).toBe(1);
    expect(t.store.get('S-1')?.offers).toEqual(expectedOffers);
  });
});
