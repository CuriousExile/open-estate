import {
  ConnectorRegistry,
  connectorsFileSchema,
  type Connector,
  type ConnectorModule,
  type ConnectorStatus,
  type ConnectorType,
} from '@open-estate/ingestion';
import { z } from 'zod';

/** Minimal connector built entirely outside the framework (Req 5.1). */
function dummyModule(name: string, type: ConnectorType): ConnectorModule<{ count: number }> {
  return {
    name,
    type,
    settingsSchema: z.object({ count: z.int().min(0) }),
    create(): Connector<{ count: number }> {
      let status: ConnectorStatus = { state: 'idle', imported: 0, updated: 0, rejected: 0 };
      return {
        type,
        initialize: async () => {
          status = { ...status, state: 'initialized' };
        },
        run: async (ctx) => {
          for (let i = 0; i < ctx.config.count; i++) await ctx.emit({ id: `${name}-${i}` });
          status = { ...status, state: 'succeeded' };
        },
        reportStatus: () => status,
      };
    },
  };
}

const [config] = connectorsFileSchema.parse([
  { id: 'db', type: 'relational-db', module: 'dummy-db', enabled: true, schedule: 'rate(1 hour)' },
]);
if (!config) throw new Error('fixture');

describe('ConnectorRegistry', () => {
  const registry = new ConnectorRegistry([
    dummyModule('dummy-db', 'relational-db'),
    dummyModule('dummy-api', 'external-api'),
    dummyModule('dummy-crawler', 'web-crawler'),
  ]);

  it('resolves a known module by configuration', () => {
    const result = registry.resolve(config);
    expect(result.ok && result.value.name).toBe('dummy-db');
    expect(registry.names()).toEqual(['dummy-api', 'dummy-crawler', 'dummy-db']);
  });

  it('runs a resolved connector through the interface only', async () => {
    const result = registry.resolve(config);
    if (!result.ok) throw new Error('expected module');
    const settings = result.value.settingsSchema.parse({ count: 2 });
    const connector = result.value.create();
    const emitted: unknown[] = [];
    const ctx = {
      config: settings,
      runId: 'run-1',
      logger: {} as never,
      emit: async (raw: unknown) => void emitted.push(raw),
    };
    await connector.initialize(ctx);
    await connector.run(ctx);
    expect(emitted).toEqual([{ id: 'dummy-db-0' }, { id: 'dummy-db-1' }]);
    expect(connector.reportStatus().state).toBe('succeeded');
  });

  it('reports an unknown module', () => {
    expect(registry.resolve({ ...config, module: 'missing' })).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'UNKNOWN_MODULE',
        connectorId: 'db',
        module: 'missing',
      }),
    });
  });

  it('reports a type mismatch between configuration and module', () => {
    expect(registry.resolve({ ...config, type: 'external-api' })).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'TYPE_MISMATCH',
        connectorId: 'db',
        module: 'dummy-db',
      }),
    });
  });

  it('refuses duplicate module names', () => {
    expect(() => registry.register(dummyModule('dummy-db', 'relational-db'))).toThrow(
      /already registered/,
    );
  });
});
