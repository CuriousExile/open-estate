import {
  ConnectorFramework,
  applyFieldMapping,
  connectorsFileSchema,
  createDefaultRegistry,
  fieldMappingSchema,
  type DbClient,
  type DbClientOptions,
  type DefaultRegistryDeps,
  type FetchLike,
  type RawRecord,
  type RecordProcessor,
} from '@open-estate/ingestion';
import { createFakeSecrets } from './support/fake-secrets';

const DB_PASSWORD = 'db-p4ss-do-not-log';
const API_TOKEN = 'api-t0ken-do-not-log';

const mapping = {
  fields: {
    id: 'ref',
    'address.city': 'location.city',
    'offers[0].price': 'price',
  },
  constants: { originalLocale: 'de', 'offers[0].offerType': 'SALE' },
};

describe('applyFieldMapping', () => {
  it('maps source paths into the listing input format and adds constants', () => {
    const parsed = fieldMappingSchema.parse(mapping);
    expect(
      applyFieldMapping({ ref: 'L-1', location: { city: 'Hannover' }, price: 250_000 }, parsed),
    ).toEqual({
      id: 'L-1',
      address: { city: 'Hannover' },
      offers: [{ price: 250_000, offerType: 'SALE' }],
      originalLocale: 'de',
    });
  });

  it('skips missing and null source values', () => {
    const parsed = fieldMappingSchema.parse(mapping);
    expect(applyFieldMapping({ ref: 'L-2', price: null }, parsed)).toEqual({
      id: 'L-2',
      offers: [{ offerType: 'SALE' }],
      originalLocale: 'de',
    });
  });

  it('rejects unsafe or malformed paths and empty mappings', () => {
    for (const path of ['__proto__.x', 'a..b', 'offers[100]', 'a.constructor', '$.x']) {
      expect(fieldMappingSchema.safeParse({ fields: { [path]: 'x' } }).success).toBe(false);
      expect(fieldMappingSchema.safeParse({ fields: { x: path } }).success).toBe(false);
    }
    expect(fieldMappingSchema.safeParse({ fields: {} }).success).toBe(false);
  });
});

function run(entry: Record<string, unknown>, deps: DefaultRegistryDeps) {
  const emitted: RawRecord[] = [];
  const lines: string[] = [];
  const processor: RecordProcessor = {
    process: async (raw) => {
      emitted.push(raw);
      return 'imported';
    },
  };
  const [config] = connectorsFileSchema.parse([
    { enabled: true, schedule: 'rate(1 hour)', ...entry },
  ]);
  if (!config) throw new Error('fixture');
  const framework = new ConnectorFramework({
    registry: createDefaultRegistry(deps),
    processor,
    sink: (line) => lines.push(line),
  });
  return framework
    .runConnector(config, { runId: 'run-1' })
    .then((summary) => ({ summary, emitted, lines }));
}

const webCrawler = { loadAllowlist: async () => ({}) };

describe('relational-db connector', () => {
  it('reads rows in batches inside a read-only transaction using credentials from secretRef', async () => {
    const rows = [1, 2, 3].map((n) => ({
      ref: `L-${n}`,
      location: { city: 'Kiel' },
      price: n * 1000,
    }));
    const queries: { text: string; values: unknown[] | undefined }[] = [];
    const opened: DbClientOptions[] = [];
    let ended = false;
    const clientFactory = (options: DbClientOptions): DbClient => {
      opened.push(options);
      return {
        connect: async () => undefined,
        query: async (text, values) => {
          queries.push({ text, values });
          if (!values) return { rows: [] };
          const [, limit, offset] = values as [string, number, number];
          return { rows: rows.slice(offset, offset + limit) };
        },
        end: async () => {
          ended = true;
        },
      };
    };
    const secrets = createFakeSecrets({
      'oe/partner-db': JSON.stringify({
        engine: 'postgres',
        host: 'db.internal',
        port: 5432,
        username: 'reader',
        password: DB_PASSWORD,
        dbname: 'estate',
      }),
    });

    const { summary, emitted, lines } = await run(
      {
        id: 'partner-db',
        type: 'relational-db',
        module: 'relational-db',
        secretRef: 'oe/partner-db',
        settings: {
          query: 'SELECT * FROM listings WHERE active = $1 ORDER BY ref',
          parameters: [true],
          batchSize: 2,
          mapping,
        },
      },
      { webCrawler, secrets, relationalDb: { clientFactory } },
    );

    expect(summary).toMatchObject({ status: 'SUCCESS', imported: 3 });
    expect(emitted.map((r) => r['id'])).toEqual(['L-1', 'L-2', 'L-3']);
    expect(emitted[0]).toMatchObject({
      address: { city: 'Kiel' },
      offers: [{ price: 1000, offerType: 'SALE' }],
    });
    expect(opened[0]).toMatchObject({
      tls: true,
      credentials: { host: 'db.internal', username: 'reader' },
    });
    expect(queries.map((q) => q.text)).toEqual([
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'SELECT * FROM (SELECT * FROM listings WHERE active = $1 ORDER BY ref) AS oe_source LIMIT $2 OFFSET $3',
      'SELECT * FROM (SELECT * FROM listings WHERE active = $1 ORDER BY ref) AS oe_source LIMIT $2 OFFSET $3',
      'COMMIT',
    ]);
    expect(queries[2]?.values).toEqual([true, 2, 2]);
    expect(ended).toBe(true);
    expect(lines.join('\n')).not.toContain(DB_PASSWORD);
  });

  it('rejects non-SELECT queries before initialize', async () => {
    const secrets = createFakeSecrets({});
    const { summary } = await run(
      {
        id: 'partner-db',
        type: 'relational-db',
        module: 'relational-db',
        secretRef: 'oe/partner-db',
        settings: { query: 'DELETE FROM listings; SELECT 1', mapping },
      },
      { webCrawler, secrets },
    );
    expect(summary).toMatchObject({ outcome: 'CONFIG_REJECTED', status: 'FAILURE' });
    expect(secrets.requested).toEqual([]);
  });
});

describe('external-api connector', () => {
  it('follows cursor pagination and sends the secret header from secretRef', async () => {
    const pages: Record<string, unknown> = {
      first: {
        data: {
          items: [
            { ref: 'A-1', price: 1 },
            { ref: 'A-2', price: 2 },
          ],
        },
        next: 'c2',
      },
      c2: { data: { items: [{ ref: 'A-3', price: 3 }] }, next: null },
    };
    const requests: { url: string; headers: Record<string, string> }[] = [];
    const fetch: FetchLike = async (url, init) => {
      requests.push({ url, headers: init.headers });
      const cursor = new URL(url).searchParams.get('cursor') ?? 'first';
      return { ok: true, status: 200, json: async () => pages[cursor] };
    };
    const secrets = createFakeSecrets({ 'oe/partner-api': API_TOKEN });

    const { summary, emitted, lines } = await run(
      {
        id: 'partner-api',
        type: 'external-api',
        module: 'external-api',
        secretRef: 'oe/partner-api',
        settings: {
          endpoint: 'https://api.partner.example/v1/listings',
          query: { status: 'active' },
          secretHeader: { name: 'Authorization', prefix: 'Bearer ' },
          recordsPath: 'data.items',
          pagination: { type: 'cursor', cursorPath: 'next', cursorParam: 'cursor' },
          mapping,
        },
      },
      { webCrawler, secrets, externalApi: { fetch } },
    );

    expect(summary).toMatchObject({ status: 'SUCCESS', imported: 3 });
    expect(emitted.map((r) => r['id'])).toEqual(['A-1', 'A-2', 'A-3']);
    expect(requests.map((r) => r.url)).toEqual([
      'https://api.partner.example/v1/listings?status=active',
      'https://api.partner.example/v1/listings?status=active&cursor=c2',
    ]);
    expect(requests[0]?.headers['Authorization']).toBe(`Bearer ${API_TOKEN}`);
    expect(lines.join('\n')).not.toContain(API_TOKEN);
  });

  it('rejects non-https endpoints', async () => {
    const { summary } = await run(
      {
        id: 'partner-api',
        type: 'external-api',
        module: 'external-api',
        settings: { endpoint: 'http://api.partner.example/v1', mapping },
      },
      { webCrawler, secrets: createFakeSecrets({}) },
    );
    expect(summary).toMatchObject({ outcome: 'CONFIG_REJECTED' });
  });
});
