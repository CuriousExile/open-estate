import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  connectorRunEventSchema,
  ConnectorFramework,
  connectorsFileSchema,
  createDefaultRegistry,
  crawlerAllowlistSchema,
  ImportPipeline,
  InMemoryImportStore,
  type Connector,
  type ConnectorContext,
  type ConnectorModule,
  type ConnectorRegistry,
  type ConnectorState,
  type ConnectorStatus,
  type FetchLike,
  type RawRecord,
  type SecretResolver,
} from '@open-estate/ingestion';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  PiiAllowlistConfig,
  TourProvidersConfig,
} from '@open-estate/shared';
import { z } from 'zod';
import { createFakeSecrets } from './support/fake-secrets';

/**
 * Keeps `docs/connectors.md` honest (task 20.3, Req 10.3): the example connector module below is
 * the one printed in the guide (compared verbatim, imports aside), it runs through the real
 * framework and import pipeline, and every JSON example in the guide passes the schema the
 * runtime parses it with.
 */

// #region docs-example
export const PARTNER_FEED_MODULE = 'partner-feed';

/** `connectors.json` → `settings`; validated by the framework before `initialize`. */
export const partnerFeedSettingsSchema = z.strictObject({
  /** https only; credentials never go into settings, they come from `secretRef`. */
  feedUrl: z.url({ protocol: /^https$/ }),
  originalLocale: z.string().min(2).max(35).default('de'),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .default('DE'),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('EUR'),
  timeoutMs: z.int().min(100).max(60_000).default(10_000),
  maxRecords: z.int().min(1).max(100_000).default(10_000),
});
export type PartnerFeedSettings = z.output<typeof partnerFeedSettingsSchema>;

/** Runtime dependencies that do not belong into `connectors.json`. */
export interface PartnerFeedDeps {
  /** Resolves `secretRef` (here: an API key); AWS Secrets Manager in production. */
  readonly secrets: SecretResolver;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
}

type FeedItem = Readonly<Record<string, unknown>>;

const isFeedItem = (value: unknown): value is FeedItem =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Source format → listing input format. Values are passed through unchecked: validation,
 * PII filtering and media cleanup are the import pipeline's job.
 */
function toListingInput(item: FeedItem, settings: PartnerFeedSettings): RawRecord {
  const images: unknown[] = Array.isArray(item['images']) ? item['images'] : [];
  return {
    // Missing `ref` ⇒ no `id` ⇒ the record is rejected by validation.
    ...(typeof item['ref'] === 'string' && { id: `pf-${item['ref']}` }),
    originalLocale: settings.originalLocale,
    title: item['headline'],
    description: item['text'] ?? '',
    translations: [],
    offers: [{ offerType: 'SALE', price: item['price'], currency: settings.currency }],
    listingType: item['kind'],
    rooms: item['rooms'],
    area: item['livingArea'],
    address: { city: item['city'], postalCode: item['zip'], country: settings.country },
    sourceUrl: item['url'],
    media: images.map((url) => ({ url })),
    // PII: dropped by the pipeline unless `contact.email` is in `pii-allowlist.json`.
    ...(item['agentEmail'] !== undefined && { contact: { email: item['agentEmail'] } }),
  };
}

/** Reads one JSON array from an https feed (GET) and emits one record per item. */
class PartnerFeedConnector implements Connector<PartnerFeedSettings> {
  readonly type = 'external-api' as const;
  private state: ConnectorState = 'idle';
  private readonly headers: Record<string, string> = { accept: 'application/json' };

  constructor(private readonly deps: PartnerFeedDeps) {}

  async initialize(ctx: ConnectorContext<PartnerFeedSettings>): Promise<void> {
    // Secret values are never logged and never put into error messages.
    if (ctx.secretRef !== undefined) {
      this.headers['x-api-key'] = await this.deps.secrets.get(ctx.secretRef);
    }
    this.state = 'initialized';
  }

  async run(ctx: ConnectorContext<PartnerFeedSettings>): Promise<void> {
    const { feedUrl, timeoutMs, maxRecords } = ctx.config;
    const fetchFn: FetchLike = this.deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.state = 'running';
    try {
      const response = await fetchFn(feedUrl, {
        method: 'GET',
        headers: { ...this.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Status only: error bodies may echo request headers (the API key).
      if (!response.ok) throw new Error(`HTTP ${response.status} from partner feed`);
      const body = await response.json();
      if (!Array.isArray(body)) throw new Error('partner feed is not a JSON array');
      for (const item of body.slice(0, maxRecords)) {
        // Non-objects are emitted empty, so they show up as rejected in the run counters.
        await ctx.emit(isFeedItem(item) ? toListingInput(item, ctx.config) : {});
      }
      this.state = 'succeeded';
    } catch (error) {
      this.state = 'failed';
      throw error; // the framework logs it and finishes the run with status FAILURE
    }
  }

  reportStatus(): ConnectorStatus {
    // imported/updated/rejected are counted by the framework from the pipeline outcomes.
    return { state: this.state, imported: 0, updated: 0, rejected: 0 };
  }
}

export function partnerFeedModule(deps: PartnerFeedDeps): ConnectorModule<PartnerFeedSettings> {
  return {
    name: PARTNER_FEED_MODULE,
    type: 'external-api',
    settingsSchema: partnerFeedSettingsSchema,
    create: () => new PartnerFeedConnector(deps),
  };
}
// #endregion docs-example

const DOC_PATH = path.resolve(__dirname, '../../../docs/connectors.md');
const doc = readFileSync(DOC_PATH, 'utf8');

const NOW = new Date('2026-11-05T10:00:00.000Z');
const API_KEY_REF = 'open-estate/partner-feed';

const listingSchema = buildSchemas(assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG), {
  defaultLocale: 'de',
  enabled: [{ locale: 'de', label: 'Deutsch' }],
}).listing;

const feed = [
  {
    ref: 'A-1',
    headline: 'Altbau am Park',
    text: 'Hell, ruhig, saniert',
    kind: 'loft',
    price: '320000.00',
    rooms: 3,
    livingArea: '88.50',
    city: 'Leipzig',
    zip: '04109',
    url: 'https://partner.example/listings/A-1',
    images: ['https://cdn.partner.example/a-1.jpg', 'http://insecure.example/a-1.jpg'],
    agentEmail: 'agent@partner.example',
  },
  { ref: 'A-2', headline: 'Ohne Zimmerangabe', kind: 'loft', price: '1.00' },
  'not an object',
];

function setup(fetchResult: { ok: boolean; status: number; body: unknown }) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, headers: init.headers });
    return { ok: fetchResult.ok, status: fetchResult.status, json: async () => fetchResult.body };
  };
  const registry = createDefaultRegistry({
    webCrawler: { loadAllowlist: async () => ({ targets: [] }) },
    secrets: createFakeSecrets({}),
  }).register(
    partnerFeedModule({ secrets: createFakeSecrets({ [API_KEY_REF]: 'key-123' }), fetch }),
  );
  const store = new InMemoryImportStore({ clock: () => NOW.getTime() });
  const lines: Record<string, unknown>[] = [];
  const framework = new ConnectorFramework({
    registry,
    processor: new ImportPipeline({
      listingSchema,
      reader: store.reader,
      writer: store.writer,
      tourProviders: TourProvidersConfig.parse({ providers: [] }),
    }),
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    now: () => NOW,
  });
  const run = (entry: Record<string, unknown>) => {
    const [config] = connectorsFileSchema.parse([entry]);
    if (!config) throw new Error('fixture');
    return framework.runConnector(config, { runId: 'run-1' });
  };
  return { registry, store, lines, requests, run };
}

const entry = {
  id: 'partner-feed',
  type: 'external-api',
  module: 'partner-feed',
  enabled: true,
  schedule: 'rate(6 hours)',
  secretRef: API_KEY_REF,
  settings: { feedUrl: 'https://feed.partner.example/listings.json' },
};

describe('docs/connectors.md example connector', () => {
  it('imports valid feed items through the pipeline and counts the rest as rejected', async () => {
    const t = setup({ ok: true, status: 200, body: feed });

    const summary = await t.run(entry);

    expect(summary).toMatchObject({
      outcome: 'COMPLETED',
      status: 'SUCCESS',
      imported: 1,
      updated: 0,
      rejected: 2,
    });
    expect(t.requests).toEqual([
      {
        url: 'https://feed.partner.example/listings.json',
        headers: { accept: 'application/json', 'x-api-key': 'key-123' },
      },
    ]);
    const listing = t.store.get('pf-A-1');
    expect(listing).toMatchObject({ source: 'partner-feed', lastRunId: 'run-1' });
    // Not allow-listed PII is dropped, the http image is removed, the https one kept.
    expect(listing?.contact?.email).toBeUndefined();
    expect(listing?.media).toEqual([{ url: 'https://cdn.partner.example/a-1.jpg' }]);
    expect(t.lines.map((l) => l['event'])).toEqual(
      expect.arrayContaining(['pii.field_dropped', 'media.dropped', 'record.rejected']),
    );
    // Run log is value-free: neither the API key nor the e-mail address appear.
    expect(JSON.stringify(t.lines)).not.toMatch(/key-123|agent@partner\.example/);
  });

  it('rejects invalid settings before initialize', async () => {
    const t = setup({ ok: true, status: 200, body: [] });

    const summary = await t.run({ ...entry, settings: { feedUrl: 'http://feed.example/x' } });

    expect(summary).toMatchObject({ outcome: 'CONFIG_REJECTED', status: 'FAILURE' });
    expect(t.requests).toEqual([]);
    expect(t.lines.find((l) => l['event'] === 'config.rejected')).toMatchObject({
      issues: [{ field: 'settings.feedUrl' }],
    });
  });

  it('fails the run when the feed answers with an error status', async () => {
    const t = setup({ ok: false, status: 503, body: null });

    const summary = await t.run(entry);

    expect(summary).toMatchObject({ outcome: 'COMPLETED', status: 'FAILURE', imported: 0 });
    expect(t.lines.find((l) => l['event'] === 'connector.error')).toMatchObject({
      reason: 'run failed: Error: HTTP 503 from partner feed',
    });
  });

  it('is printed verbatim in the guide', () => {
    const own = readFileSync(__filename, 'utf8');
    const region = /\/\/ #region docs-example\n([\s\S]*?)\/\/ #endregion docs-example/.exec(own);
    const block = [...doc.matchAll(/```ts\n([\s\S]*?)```/g)]
      .map((m) => m[1] ?? '')
      .find((code) => code.includes('export const PARTNER_FEED_MODULE'));
    expect(region?.[1]).toBeDefined();
    expect(block).toBeDefined();
    // The guide adds the module's imports (relative paths inside packages/ingestion/src).
    const withoutImports = (block ?? '').replace(/^(?:import [\s\S]*?;\n)+\n/, '');
    expect(withoutImports).toBe(region?.[1]);
  });
});

describe('docs/connectors.md JSON examples', () => {
  const blocks = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  const registry: ConnectorRegistry = setup({ ok: true, status: 200, body: [] }).registry;

  it('contains JSON examples', () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  it.each(blocks.map((block, index) => [index, block] as const))(
    'block %i is valid against its runtime schema',
    (_, block) => {
      const json: unknown = JSON.parse(block);
      if (Array.isArray(json)) {
        // connectors.json: file schema (checked at synth) and module settings (checked per run).
        for (const config of connectorsFileSchema.parse(json)) {
          const module = registry.resolve(config);
          if (!module.ok) throw new Error(module.error.reason);
          const settings = module.value.settingsSchema.safeParse(config.settings);
          expect(settings.error?.issues ?? []).toEqual([]);
        }
        return;
      }
      const object = z.record(z.string(), z.unknown()).parse(json);
      if ('targets' in object) crawlerAllowlistSchema.parse(object);
      else if ('allowedFields' in object) PiiAllowlistConfig.parse(object);
      else if ('connectorId' in object) connectorRunEventSchema.parse(object);
      else if ('event' in object) expect(object).toHaveProperty('runId');
      else throw new Error(`unclassified JSON example: ${block.slice(0, 80)}`);
    },
  );
});
