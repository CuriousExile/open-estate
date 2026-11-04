import {
  ConnectorFramework,
  ConnectorRegistry,
  connectorConfigSchema,
  type Connector,
  type ConnectorConfig,
  type ConnectorModule,
  type ConnectorStatus,
  type RawRecord,
  type RecordOutcome,
  type RecordProcessor,
} from '@open-estate/ingestion';
import { z } from 'zod';

const T0 = new Date('2026-11-05T10:00:00.000Z');
const SECRET = 'p4ssw0rd-do-not-log';

const settingsSchema = z.strictObject({ table: z.string().min(1), batchSize: z.int().min(1) });
type Settings = z.output<typeof settingsSchema>;

interface Behaviour {
  records?: RawRecord[];
  failInitialize?: boolean;
  failRun?: boolean;
}

/** Fake connector module recording which lifecycle methods were called. */
function fakeModule(behaviour: Behaviour = {}) {
  const calls: string[] = [];
  const seenConfigs: unknown[] = [];
  const module: ConnectorModule<Settings> = {
    name: 'fake-db',
    type: 'relational-db',
    settingsSchema,
    create(): Connector<Settings> {
      const status: ConnectorStatus = { state: 'idle', imported: 0, updated: 0, rejected: 0 };
      return {
        type: 'relational-db',
        initialize: async (ctx) => {
          calls.push('initialize');
          seenConfigs.push(ctx.config);
          if (behaviour.failInitialize) throw new Error('connection refused');
        },
        run: async (ctx) => {
          calls.push('run');
          for (const raw of behaviour.records ?? []) await ctx.emit(raw);
          if (behaviour.failRun) throw new Error('cursor lost');
        },
        reportStatus: () => status,
      };
    },
  };
  return { module, calls, seenConfigs };
}

/** Fake pipeline: outcome taken from the record, `throw` simulates a processing crash. */
const fakeProcessor: RecordProcessor = {
  process: async (raw) => {
    if (raw['outcome'] === 'throw') throw new TypeError('boom');
    return raw['outcome'] as RecordOutcome;
  },
};

function config(overrides: Record<string, unknown> = {}): ConnectorConfig {
  return connectorConfigSchema.parse({
    id: 'partner-db',
    type: 'relational-db',
    module: 'fake-db',
    enabled: true,
    schedule: 'rate(1 hour)',
    settings: { table: 'listings', batchSize: 10 },
    ...overrides,
  });
}

function setup(behaviour: Behaviour = {}) {
  const fake = fakeModule(behaviour);
  const lines: string[] = [];
  let tick = 0;
  const framework = new ConnectorFramework({
    registry: new ConnectorRegistry([fake.module as ConnectorModule]),
    processor: fakeProcessor,
    sink: (line) => lines.push(line),
    now: () => new Date(T0.getTime() + 1000 * tick++),
  });
  const events = () => lines.map((l) => (JSON.parse(l) as { event: string }).event);
  const entries = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { framework, ...fake, lines, events, entries };
}

const records = (...outcomes: string[]): RawRecord[] =>
  outcomes.map((outcome, i) => ({ id: `L-${i}`, outcome }));

describe('ConnectorFramework.runConnector', () => {
  it('runs a valid connector and logs the counters', async () => {
    const t = setup({ records: records('imported', 'updated', 'imported', 'rejected') });
    const summary = await t.framework.runConnector(config(), { runId: 'run-1' });

    expect(t.calls).toEqual(['initialize', 'run']);
    expect(t.seenConfigs).toEqual([{ table: 'listings', batchSize: 10 }]);
    expect(summary).toMatchObject({
      runId: 'run-1',
      source: 'partner-db',
      outcome: 'COMPLETED',
      status: 'SUCCESS',
      imported: 2,
      updated: 1,
      rejected: 1,
    });
    expect(summary.startedAt.getTime()).toBeLessThanOrEqual(summary.endedAt.getTime());
    expect(t.events()).toEqual(['run.started', 'run.finished']);
    expect(t.entries()[1]).toMatchObject({
      runId: 'run-1',
      source: 'partner-db',
      status: 'SUCCESS',
      startedAt: summary.startedAt.toISOString(),
      endedAt: summary.endedAt.toISOString(),
      imported: 2,
      updated: 1,
      rejected: 1,
    });
  });

  it('rejects invalid settings without initialize or run and logs paths, not values', async () => {
    const t = setup({ records: records('imported') });
    const summary = await t.framework.runConnector(
      config({ settings: { table: '', batchSize: SECRET, password: SECRET } }),
      { runId: 'run-2' },
    );

    expect(t.calls).toEqual([]);
    expect(summary).toMatchObject({ outcome: 'CONFIG_REJECTED', status: 'FAILURE', imported: 0 });
    expect(t.events()).toEqual(['config.rejected', 'run.finished']);
    const issues = t.entries()[0]?.['issues'] as { field: string }[];
    expect(issues.map((i) => i.field).sort()).toEqual([
      'settings',
      'settings.batchSize',
      'settings.table',
    ]);
    expect(t.lines.join('\n')).not.toContain(SECRET);
  });

  it('rejects an unknown module', async () => {
    const t = setup();
    const summary = await t.framework.runConnector(config({ module: 'nope' }), { runId: 'r' });

    expect(t.calls).toEqual([]);
    expect(summary.outcome).toBe('CONFIG_REJECTED');
    expect(t.entries()[0]).toMatchObject({
      event: 'config.rejected',
      issues: [{ field: 'module', reason: 'unknown connector module "nope"' }],
    });
  });

  it('rejects a type mismatch between config and module', async () => {
    const t = setup();
    const summary = await t.framework.runConnector(config({ type: 'external-api' }), {
      runId: 'r',
    });

    expect(t.calls).toEqual([]);
    expect(summary).toMatchObject({ outcome: 'CONFIG_REJECTED', status: 'FAILURE' });
    expect(t.entries()[0]).toMatchObject({
      event: 'config.rejected',
      issues: [{ field: 'type' }],
    });
  });

  it('does not execute a disabled connector and logs the skip', async () => {
    const t = setup({ records: records('imported') });
    const summary = await t.framework.runConnector(config({ enabled: false }), { runId: 'r' });

    expect(t.calls).toEqual([]);
    expect(summary).toMatchObject({ outcome: 'DISABLED', status: 'SUCCESS', imported: 0 });
    expect(t.entries()).toEqual([
      expect.objectContaining({ event: 'run.skipped', reason: 'connector is disabled' }),
    ]);
  });

  it('fails the run when initialize throws, without calling run', async () => {
    const t = setup({ failInitialize: true });
    const summary = await t.framework.runConnector(config(), { runId: 'r' });

    expect(t.calls).toEqual(['initialize']);
    expect(summary).toMatchObject({ outcome: 'COMPLETED', status: 'FAILURE' });
    expect(t.events()).toEqual(['run.started', 'connector.error', 'run.finished']);
    expect(t.entries()[1]?.['reason']).toBe('initialize failed: Error: connection refused');
  });

  it('fails the run when run throws and keeps the counters so far', async () => {
    const t = setup({ records: records('imported', 'updated'), failRun: true });
    const summary = await t.framework.runConnector(config(), { runId: 'r' });

    expect(summary).toMatchObject({ status: 'FAILURE', imported: 1, updated: 1, rejected: 0 });
    expect(t.events()).toEqual(['run.started', 'connector.error', 'run.finished']);
    expect(t.entries()[1]?.['reason']).toBe('run failed: Error: cursor lost');
    expect(t.entries()[2]).toMatchObject({ status: 'FAILURE', imported: 1, updated: 1 });
  });

  it('counts a processor exception as one rejection and continues the run', async () => {
    const t = setup({ records: records('imported', 'throw', 'updated') });
    const summary = await t.framework.runConnector(config(), { runId: 'r' });

    expect(summary).toMatchObject({ status: 'SUCCESS', imported: 1, updated: 1, rejected: 1 });
    expect(t.events()).toEqual(['run.started', 'record.rejected', 'run.finished']);
    expect(t.entries()[1]).toMatchObject({
      listingId: 'L-1',
      issues: [{ field: 'record', reason: 'processing failed: TypeError: boom' }],
    });
  });
});
