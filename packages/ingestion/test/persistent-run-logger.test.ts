import { InMemoryConnectorRunStore, type ConnectorRunWriter } from '@open-estate/core';
import {
  ConnectorFramework,
  ConnectorRegistry,
  connectorConfigSchema,
  createRunLogger,
  toRunRejection,
  withRunPersistence,
  type Connector,
  type ConnectorModule,
  type RawRecord,
  type RecordProcessor,
} from '@open-estate/ingestion';
import { z } from 'zod';

// Persisting `RunLogger` (task 6.7, Req 13.2, 13.3): summary with `unchanged` and `agencyId` to
// `ConnectorRuns`, rejections with identifier/Custom_Id, field names and reason to `RunRejections`.

const T0 = new Date('2026-11-05T10:00:00.000Z');
const PERIOD = { from: '2026-11-05T00:00:00Z', to: '2026-11-06T00:00:00Z' };
const SECRET_VALUE = 'max.mustermann@example.com';

const settingsSchema = z.object({});

function moduleEmitting(records: RawRecord[], failRun = false): ConnectorModule {
  return {
    name: 'fake-db',
    type: 'relational-db',
    settingsSchema,
    create(): Connector<z.output<typeof settingsSchema>> {
      return {
        type: 'relational-db',
        initialize: async () => undefined,
        run: async (ctx) => {
          for (const raw of records) await ctx.emit(raw);
          if (failRun) throw new Error('cursor lost');
        },
        reportStatus: () => ({ state: 'idle', imported: 0, updated: 0, rejected: 0 }),
      };
    },
  } as ConnectorModule;
}

/** Outcome from the record; `rejected` records log field names and a reason, never the value. */
const processor: RecordProcessor = {
  process: async (raw, ctx) => {
    if (raw['outcome'] === 'throw') throw new TypeError('boom');
    if (raw['outcome'] === 'rejected') {
      ctx.logger.recordRejected(
        raw['id'] as string | undefined,
        [
          { field: 'contact.email', reason: 'PII field not allowed' },
          { field: 'price', reason: 'Required' },
          { field: 'price', reason: 'Required' },
        ],
        raw['customId'] as string | undefined,
      );
    }
    return raw['outcome'] as 'imported';
  },
};

function setup(records: RawRecord[], options: { agencyId?: string; failRun?: boolean } = {}) {
  const store = new InMemoryConnectorRunStore();
  const lines: string[] = [];
  let tick = 0;
  const framework = new ConnectorFramework({
    registry: new ConnectorRegistry([moduleEmitting(records, options.failRun)]),
    processor,
    runs: store,
    sink: (line) => lines.push(line),
    now: () => new Date(T0.getTime() + 1000 * tick++),
  });
  const config = connectorConfigSchema.parse({
    id: 'partner-db',
    type: 'relational-db',
    module: 'fake-db',
    enabled: true,
    schedule: 'rate(1 hour)',
    settings: {},
    ...(options.agencyId !== undefined && { agencyId: options.agencyId }),
  });
  return { store, framework, config, lines };
}

describe('persisting RunLogger in the framework', () => {
  it('stores the summary with all four counters and the agency', async () => {
    const { store, framework, config } = setup(
      [
        { outcome: 'imported' },
        { outcome: 'updated' },
        { outcome: 'unchanged' },
        { outcome: 'unchanged' },
        { outcome: 'rejected', id: 'L-9', email: SECRET_VALUE },
      ],
      { agencyId: 'agency-1' },
    );
    const summary = await framework.runConnector(config, { runId: 'run-1' });

    const { items } = await store.query(PERIOD, { limit: 10 });
    expect(items).toEqual([
      {
        runId: 'run-1',
        connectorId: 'partner-db',
        agencyId: 'agency-1',
        startedAt: summary.startedAt.toISOString(),
        endedAt: summary.endedAt.toISOString(),
        status: 'SUCCESS',
        imported: 1,
        updated: 1,
        unchanged: 2,
        rejected: 1,
      },
    ]);
    expect(summary).toMatchObject({ imported: 1, updated: 1, unchanged: 2, rejected: 1 });
  });

  it('stores every rejection with id or Custom_Id, field names and reason, never values', async () => {
    const { store, framework, config } = setup([
      { outcome: 'rejected', id: 'L-1', email: SECRET_VALUE },
      { outcome: 'rejected', customId: 'EXT-7', email: SECRET_VALUE },
      { outcome: 'throw', customId: 'EXT-8' },
    ]);
    await framework.runConnector(config, { runId: 'run-2' });

    const page = await store.rejections('run-2', { limit: 10 });
    expect(page).toEqual({
      items: [
        {
          listingId: 'L-1',
          fields: ['contact.email', 'price'],
          reason: 'PII field not allowed; Required',
        },
        {
          customId: 'EXT-7',
          fields: ['contact.email', 'price'],
          reason: 'PII field not allowed; Required',
        },
        { customId: 'EXT-8', fields: ['record'], reason: 'processing failed: TypeError: boom' },
      ],
    });
    expect(JSON.stringify(page)).not.toContain(SECRET_VALUE);
    const [run] = (await store.query(PERIOD, { limit: 10 })).items;
    expect(run).not.toHaveProperty('agencyId');
    expect(run?.rejected).toBe(3);
  });

  it('stores failed runs and config rejections, but not disabled runs', async () => {
    const failing = setup([{ outcome: 'imported' }], { failRun: true });
    await failing.framework.runConnector(failing.config, { runId: 'run-3' });
    expect((await failing.store.query(PERIOD, { limit: 10 })).items).toMatchObject([
      { runId: 'run-3', status: 'FAILURE', imported: 1 },
    ]);

    const disabled = setup([]);
    await disabled.framework.runConnector({ ...disabled.config, enabled: false }, { runId: 'r' });
    expect((await disabled.store.query(PERIOD, { limit: 10 })).items).toEqual([]);

    const misconfigured = setup([]);
    await misconfigured.framework.runConnector(
      { ...misconfigured.config, module: 'missing' },
      { runId: 'run-4' },
    );
    expect((await misconfigured.store.query(PERIOD, { limit: 10 })).items).toMatchObject([
      { runId: 'run-4', status: 'FAILURE', rejected: 0 },
    ]);
  });

  it('logs a failed write as connector error without failing the run', async () => {
    const lines: string[] = [];
    const writer: ConnectorRunWriter = {
      record: async () => {
        throw new Error('throttled');
      },
    };
    const logger = withRunPersistence(
      createRunLogger({ runId: 'run-5', source: 'partner-db', sink: (line) => lines.push(line) }),
      { writer },
    );
    logger.runFinished({
      status: 'SUCCESS',
      startedAt: T0,
      endedAt: T0,
      imported: 0,
      updated: 0,
      unchanged: 0,
      rejected: 0,
    });
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>).at(-1)).toMatchObject({
      level: 'error',
      event: 'connector.error',
      reason: 'run log persistence failed: Error: throttled',
    });
  });

  it('still writes the run log lines of the wrapped logger', async () => {
    const { framework, config, lines } = setup([{ outcome: 'rejected', customId: 'EXT-1' }]);
    await framework.runConnector(config, { runId: 'run-6' });
    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(entries.find((e) => e['event'] === 'record.rejected')).toMatchObject({
      customId: 'EXT-1',
      issues: [{ field: 'contact.email' }, { field: 'price' }, { field: 'price' }],
    });
    expect(entries.find((e) => e['event'] === 'run.finished')).toMatchObject({ unchanged: 0 });
  });
});

describe('toRunRejection', () => {
  it('caps field names and reasons', () => {
    const rejection = toRunRejection(undefined, [
      { field: 'f'.repeat(300), reason: 'r'.repeat(2000) },
    ]);
    expect(rejection.fields[0]).toHaveLength(201);
    expect(rejection.reason).toHaveLength(1001);
    expect(rejection).not.toHaveProperty('listingId');
  });
});
