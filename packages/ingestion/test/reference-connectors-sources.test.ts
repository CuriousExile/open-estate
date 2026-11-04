import {
  ConnectorFramework,
  connectorsFileSchema,
  createDefaultRegistry,
  type DefaultRegistryDeps,
  type FetchLike,
  type RawRecord,
  type RecordProcessor,
} from '@open-estate/ingestion';
import { Client } from 'pg';
import { createFakeSecrets } from './support/fake-secrets';

/**
 * Reference connectors against mocked data sources (task 10.14): the real `pg` module is
 * replaced, so the default client factory is exercised; `fetch` is injected.
 * Happy paths with an injected client factory / cursor pagination live in
 * reference-connectors.test.ts.
 */

jest.mock('pg', () => ({ Client: jest.fn() }));
const MockClient = jest.mocked(Client);

const DB_PASSWORD = 'pg-s3cret-do-not-log';
const API_TOKEN = 'api-s3cret-do-not-log';
const mapping = { fields: { id: 'ref' }, constants: { originalLocale: 'de' } };

function run(entry: Record<string, unknown>, deps: Partial<DefaultRegistryDeps>) {
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
    registry: createDefaultRegistry({
      webCrawler: { loadAllowlist: async () => ({}) },
      secrets: createFakeSecrets({}),
      ...deps,
    }),
    processor,
    sink: (line) => lines.push(line),
  });
  return framework
    .runConnector(config, { runId: 'run-1' })
    .then((summary) => ({ summary, emitted, log: lines.join('\n') }));
}

describe('relational-db connector with mocked pg', () => {
  const secrets = () =>
    createFakeSecrets({
      'oe/db': JSON.stringify({
        host: 'db.internal',
        port: '6543',
        username: 'reader',
        password: DB_PASSWORD,
        dbname: 'estate',
      }),
    });
  const entry = (settings: Record<string, unknown> = {}) => ({
    id: 'partner-db',
    type: 'relational-db',
    module: 'relational-db',
    secretRef: 'oe/db',
    settings: { query: 'SELECT * FROM listings ORDER BY ref', mapping, ...settings },
  });

  /** Stubs `new Client(...)`; `rows` answers the n-th paged SELECT, `fail` makes it throw. */
  function mockPg({ rows = [] as unknown[][], fail = false } = {}) {
    const queries: string[] = [];
    const client = {
      connect: jest.fn(async () => undefined),
      end: jest.fn(async () => undefined),
      query: jest.fn<Promise<{ rows: unknown[] }>, [string, unknown[]?]>(async (text) => {
        queries.push(text);
        if (!text.startsWith('SELECT')) return { rows: [] };
        if (fail) throw new Error('relation "listings" does not exist');
        return { rows: rows.shift() ?? [] };
      }),
    };
    MockClient.mockReset();
    MockClient.mockImplementation(() => client as unknown as Client);
    return { client, queries };
  }

  it('builds the pg client from the secret with verified TLS and timeouts by default', async () => {
    const pg = mockPg({ rows: [[{ ref: 'R-1' }, { ref: 'R-2' }]] });

    const { summary, emitted } = await run(entry({ statementTimeoutMs: 5_000 }), {
      secrets: secrets(),
    });

    expect(summary).toMatchObject({ status: 'SUCCESS', imported: 2 });
    expect(emitted.map((r) => r['id'])).toEqual(['R-1', 'R-2']);
    expect(MockClient).toHaveBeenCalledTimes(1);
    expect(MockClient).toHaveBeenCalledWith({
      host: 'db.internal',
      port: 6543,
      user: 'reader',
      password: DB_PASSWORD,
      database: 'estate',
      ssl: { rejectUnauthorized: true },
      connectionTimeoutMillis: 10_000,
      statement_timeout: 5_000,
      application_name: 'open-estate-connector',
    });
    expect(pg.client.connect).toHaveBeenCalledTimes(1);
    expect(pg.client.end).toHaveBeenCalledTimes(1);
  });

  it('stops at maxRecords across batches', async () => {
    const pg = mockPg({ rows: [[{ ref: 'R-1' }, { ref: 'R-2' }], [{ ref: 'R-3' }]] });
    const { summary, emitted } = await run(entry({ batchSize: 2, maxRecords: 3 }), {
      secrets: secrets(),
    });
    expect(summary).toMatchObject({ status: 'SUCCESS', imported: 3 });
    expect(emitted).toHaveLength(3);
    const paged = pg.client.query.mock.calls.filter(([text]) => text.startsWith('SELECT'));
    expect(paged.map(([, values]) => values)).toEqual([
      [2, 0],
      [1, 2],
    ]);
  });

  it('fails the run on a query error, closes the connection and does not commit', async () => {
    const pg = mockPg({ fail: true });
    const { summary, log } = await run(entry(), { secrets: secrets() });
    expect(summary).toMatchObject({ outcome: 'COMPLETED', status: 'FAILURE', imported: 0 });
    expect(pg.queries).not.toContain('COMMIT');
    expect(pg.client.end).toHaveBeenCalledTimes(1);
    expect(log).toContain('run failed');
    expect(log).not.toContain(DB_PASSWORD);
  });

  it('fails initialize without secretRef and never opens a connection', async () => {
    mockPg();
    const withoutSecret: Record<string, unknown> = { ...entry() };
    delete withoutSecret['secretRef'];
    const { summary, log } = await run(withoutSecret, { secrets: secrets() });
    expect(summary).toMatchObject({ status: 'FAILURE' });
    expect(log).toContain('requires secretRef');
    expect(MockClient).not.toHaveBeenCalled();
  });

  it('reports an invalid secret by field names only', async () => {
    mockPg();
    const broken = createFakeSecrets({
      'oe/db': JSON.stringify({ host: 'db.internal', password: DB_PASSWORD }),
    });
    const { summary, log } = await run(entry(), { secrets: broken });
    expect(summary).toMatchObject({ status: 'FAILURE' });
    expect(log).toMatch(/database secret is invalid \(fields: [^)]*username/);
    expect(log).not.toContain(DB_PASSWORD);
    expect(MockClient).not.toHaveBeenCalled();
  });
});

describe('external-api connector with mocked fetch', () => {
  const endpoint = 'https://api.partner.example/v1/listings';
  const entry = (settings: Record<string, unknown>) => ({
    id: 'partner-api',
    type: 'external-api',
    module: 'external-api',
    secretRef: 'oe/api',
    settings: { endpoint, mapping, ...settings },
  });

  /** Serves `pages[page]` for `?page=n`; pages beyond the list are empty. */
  function pagedFetch(pages: unknown[][], failOnPage?: number) {
    const urls: string[] = [];
    const fetch: FetchLike = async (url) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === failOnPage) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ items: pages[page] ?? [] }) };
    };
    return { fetch, urls };
  }

  const pageNumber = { type: 'page-number', pageParam: 'page', startPage: 0, maxPages: 10 };

  it('walks page-number pagination until the first empty page', async () => {
    const api = pagedFetch([[{ ref: 'P-1' }, { ref: 'P-2' }], [{ ref: 'P-3' }]]);
    const { summary, emitted } = await run(
      entry({ recordsPath: 'items', pagination: pageNumber }),
      { externalApi: { fetch: api.fetch } },
    );
    expect(summary).toMatchObject({ status: 'SUCCESS', imported: 3 });
    expect(emitted.map((r) => r['id'])).toEqual(['P-1', 'P-2', 'P-3']);
    expect(api.urls).toEqual([`${endpoint}?page=0`, `${endpoint}?page=1`, `${endpoint}?page=2`]);
  });

  it('respects maxPages and maxRecords', async () => {
    const pages = [
      [{ ref: 'P-1' }, { ref: 'P-2' }],
      [{ ref: 'P-3' }, { ref: 'P-4' }],
    ];
    const byPages = pagedFetch(pages);
    const limitedPages = await run(
      entry({ recordsPath: 'items', pagination: { ...pageNumber, maxPages: 1 } }),
      { externalApi: { fetch: byPages.fetch } },
    );
    expect(limitedPages.summary).toMatchObject({ imported: 2 });
    expect(byPages.urls).toHaveLength(1);

    const byRecords = pagedFetch(pages);
    const limitedRecords = await run(
      entry({ recordsPath: 'items', pagination: pageNumber, maxRecords: 3 }),
      { externalApi: { fetch: byRecords.fetch } },
    );
    expect(limitedRecords.emitted.map((r) => r['id'])).toEqual(['P-1', 'P-2', 'P-3']);
    expect(byRecords.urls).toHaveLength(2);
  });

  it('fails the run on an HTTP error, keeps records read so far and never logs the secret', async () => {
    const api = pagedFetch([[{ ref: 'P-1' }]], 1);
    const { summary, log } = await run(
      entry({
        recordsPath: 'items',
        pagination: pageNumber,
        secretHeader: { name: 'X-Api-Key' },
      }),
      { externalApi: { fetch: api.fetch }, secrets: createFakeSecrets({ 'oe/api': API_TOKEN }) },
    );
    expect(summary).toMatchObject({ outcome: 'COMPLETED', status: 'FAILURE', imported: 1 });
    expect(log).toContain('HTTP 503 from api.partner.example');
    expect(log).not.toContain(API_TOKEN);
  });

  it('fails the run when the response has no record array at recordsPath', async () => {
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ items: { ref: 'not-an-array' } }),
    });
    const { summary, emitted, log } = await run(entry({ recordsPath: 'items' }), {
      externalApi: { fetch },
    });
    expect(summary).toMatchObject({ status: 'FAILURE' });
    expect(emitted).toEqual([]);
    expect(log).toContain('no record array');
  });

  it('rejects an Authorization header outside secretHeader before initialize', async () => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>();
    const { summary } = await run(entry({ headers: { authorization: `Bearer ${API_TOKEN}` } }), {
      externalApi: { fetch },
    });
    expect(summary).toMatchObject({ outcome: 'CONFIG_REJECTED' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
