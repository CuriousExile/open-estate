// Feature: real-estate-platform, Property 17: Ungültige Connector-Konfiguration wird abgelehnt
import {
  CONNECTOR_TYPES,
  ConnectorFramework,
  ConnectorRegistry,
  connectorConfigSchema,
  connectorsFileSchema,
  type Connector,
  type ConnectorModule,
  type ConnectorType,
  type RecordProcessor,
} from '@open-estate/ingestion';
import fc from 'fast-check';
import { z } from 'zod';

/**
 * Property 17: for any connector configuration that violates the connector schema
 * (module unknown, type mismatch, settings rejected by the module's own schema) the
 * framework calls neither `initialize` nor `run` and logs the reason. The module's
 * `create` is not called either (validation happens before instantiation).
 * Valid configurations are executed (initialize + run).
 *
 * **Validates: Requirements 5.4**
 */

const RUNS = { numRuns: 100 };
const T0 = new Date('2026-11-05T10:00:00.000Z');

const MODULE_NAME = 'spy-db';
const MODULE_TYPE: ConnectorType = 'relational-db';
const TABLE_MAX = 32;
const BATCH_MAX = 500;
const TAGS_MAX = 5;
const TAG_MAX = 16;
const MODES = ['full', 'delta'] as const;

const settingsSchema = z.strictObject({
  table: z.string().min(1).max(TABLE_MAX),
  batchSize: z.int().min(1).max(BATCH_MAX),
  mode: z.enum(MODES),
  tags: z.array(z.string().max(TAG_MAX)).max(TAGS_MAX).optional(),
});
type Settings = z.output<typeof settingsSchema>;

/** Spy module: counts every lifecycle call. */
function spyModule() {
  const calls = { create: 0, initialize: 0, run: 0 };
  const module: ConnectorModule<Settings> = {
    name: MODULE_NAME,
    type: MODULE_TYPE,
    settingsSchema,
    create(): Connector<Settings> {
      calls.create += 1;
      return {
        type: MODULE_TYPE,
        initialize: async () => {
          calls.initialize += 1;
        },
        run: async () => {
          calls.run += 1;
        },
        reportStatus: () => ({ state: 'idle', imported: 0, updated: 0, rejected: 0 }),
      };
    },
  };
  return { module, calls };
}

const noopProcessor: RecordProcessor = { process: async () => 'imported' };

async function execute(
  overrides: { type?: ConnectorType; module?: string; settings: unknown },
  runId: string,
) {
  const spy = spyModule();
  const lines: string[] = [];
  const framework = new ConnectorFramework({
    registry: new ConnectorRegistry([spy.module as ConnectorModule]),
    processor: noopProcessor,
    sink: (line) => lines.push(line),
    now: () => T0,
  });
  const config = connectorConfigSchema.parse({
    id: 'partner-db',
    type: overrides.type ?? MODULE_TYPE,
    module: overrides.module ?? MODULE_NAME,
    enabled: true,
    schedule: 'rate(1 hour)',
    settings: overrides.settings,
  });
  const summary = await framework.runConnector(config, { runId });
  const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { summary, calls: spy.calls, lines, entries };
}

// --- Generators ------------------------------------------------------------

/** Unique-looking marker value; must never show up in the log. */
const arbMarker = fc
  .string({ unit: fc.constantFrom(...'0123456789abcdef'.split('')), minLength: 8, maxLength: 8 })
  .map((hex) => `MRK${hex}`);

const arbValidSettings = fc.record(
  {
    table: arbMarker,
    batchSize: fc.integer({ min: 1, max: BATCH_MAX }),
    mode: fc.constantFrom(...MODES),
    tags: fc.array(arbMarker, { maxLength: TAGS_MAX }),
  },
  { requiredKeys: ['table', 'batchSize', 'mode'] },
);

const without = (obj: object, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));

type Mutation = (s: Record<string, unknown>) => Record<string, unknown>;
const set =
  (key: string, value: unknown): Mutation =>
  (s) => ({ ...s, [key]: value });

/** Each mutation on its own makes valid settings invalid. */
const arbMutation: fc.Arbitrary<Mutation> = fc.oneof(
  // wrong type
  arbMarker.map((m) => set('batchSize', m)),
  fc.integer().map((n) => set('table', n)),
  fc.boolean().map((b) => set('mode', b)),
  arbMarker.map((m) => set('tags', m)),
  // value outside the allowed range / set
  arbMarker.map((m) => set('mode', m)),
  arbMarker.map((m) => set('table', m.padEnd(TABLE_MAX + 1, 'x'))),
  fc.constant(set('table', '')),
  fc.integer({ min: -1_000_000, max: 0 }).map((n) => set('batchSize', n)),
  fc.integer({ min: BATCH_MAX + 1, max: 1_000_000 }).map((n) => set('batchSize', n)),
  fc
    .double({ min: 1.01, max: BATCH_MAX - 0.01, noNaN: true })
    .filter((n) => !Number.isInteger(n))
    .map((n) => set('batchSize', n)),
  fc
    .array(arbMarker, { minLength: TAGS_MAX + 1, maxLength: TAGS_MAX + 4 })
    .map((t) => set('tags', t)),
  arbMarker.map((m) => set('tags', [m.padEnd(TAG_MAX + 1, 'x')])),
  // missing required field
  fc.constantFrom('table', 'batchSize', 'mode').map(
    (key): Mutation =>
      (s) =>
        without(s, key),
  ),
  // unknown field (strictObject); key and value differ, only the value is a marker
  fc.tuple(fc.constantFrom('extra', 'password', 'dsn'), arbMarker).map(([k, m]) => set(k, m)),
);

/** Settings that are not an object at all. */
const arbNonObjectSettings = fc.oneof(
  arbMarker,
  fc.integer(),
  fc.constant(null),
  fc.array(arbMarker, { maxLength: 3 }),
);

const arbInvalidSettings = fc.oneof(
  {
    weight: 4,
    arbitrary: fc
      .tuple(arbValidSettings, fc.array(arbMutation, { minLength: 1, maxLength: 3 }))
      .map(([valid, mutations]) =>
        mutations.reduce<Record<string, unknown>>((s, m) => m(s), { ...valid }),
      ),
  },
  { weight: 1, arbitrary: arbNonObjectSettings },
);

const arbOtherSlug = fc
  .stringMatching(/^[a-z0-9](?:[a-z0-9-]{0,20}[a-z0-9])?$/)
  .filter((slug) => slug !== MODULE_NAME);
const arbOtherType = fc.constantFrom(...CONNECTOR_TYPES.filter((t) => t !== MODULE_TYPE));

type Case =
  | { kind: 'valid'; settings: unknown }
  | { kind: 'settings'; settings: unknown }
  | { kind: 'module'; module: string; settings: unknown }
  | { kind: 'type'; type: ConnectorType; settings: unknown };

const arbCase: fc.Arbitrary<Case> = fc.oneof(
  arbValidSettings.map((settings): Case => ({ kind: 'valid', settings })),
  {
    weight: 2,
    arbitrary: arbInvalidSettings.map((settings): Case => ({ kind: 'settings', settings })),
  },
  fc
    .tuple(arbOtherSlug, fc.oneof(arbValidSettings, arbInvalidSettings))
    .map(([module, settings]): Case => ({ kind: 'module', module, settings })),
  fc
    .tuple(arbOtherType, fc.oneof(arbValidSettings, arbInvalidSettings))
    .map(([type, settings]): Case => ({ kind: 'type', type, settings })),
);

/** All marker strings contained anywhere in the settings value. */
function markersIn(value: unknown): string[] {
  if (typeof value === 'string') return value.match(/MRK[0-9a-f]{8}/g) ?? [];
  if (Array.isArray(value)) return value.flatMap(markersIn);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(markersIn);
  return [];
}

// --- Properties --------------------------------------------------------------

describe('Property 17: Ungültige Connector-Konfiguration wird abgelehnt', () => {
  it('rejects exactly the invalid configurations, before create/initialize/run, with a value-free reason', async () => {
    await fc.assert(
      fc.asyncProperty(arbCase, fc.uuid(), async (c, runId) => {
        const { summary, calls, lines, entries } = await execute(
          {
            settings: c.settings,
            ...(c.kind === 'module' ? { module: c.module } : {}),
            ...(c.kind === 'type' ? { type: c.type } : {}),
          },
          runId,
        );
        const rejected = entries.filter((e) => e['event'] === 'config.rejected');

        if (c.kind === 'valid') {
          expect(summary.outcome).toBe('COMPLETED');
          expect(summary.status).toBe('SUCCESS');
          expect(calls).toEqual({ create: 1, initialize: 1, run: 1 });
          expect(rejected).toHaveLength(0);
        } else {
          expect(summary.outcome).toBe('CONFIG_REJECTED');
          expect(summary.status).toBe('FAILURE');
          expect(calls).toEqual({ create: 0, initialize: 0, run: 0 });
          expect(entries.some((e) => e['event'] === 'run.started')).toBe(false);
          expect(rejected).toHaveLength(1);

          const issues = rejected[0]?.['issues'] as { field: string; reason: string }[];
          expect(issues.length).toBeGreaterThanOrEqual(1);
          for (const { field, reason } of issues) {
            expect(reason.length).toBeGreaterThan(0);
            if (c.kind === 'module') expect(field).toBe('module');
            else if (c.kind === 'type') expect(field).toBe('type');
            else expect(field).toMatch(/^settings(\.|$)/);
          }
        }

        const log = lines.join('\n');
        for (const marker of markersIn(c.settings)) expect(log).not.toContain(marker);
      }),
      RUNS,
    );
  });

  it('connectorsFileSchema rejects a connectors.json with an invalid entry', () => {
    const validEntry = {
      id: 'partner-db',
      type: MODULE_TYPE,
      module: MODULE_NAME,
      enabled: true,
      schedule: 'rate(1 hour)',
    };
    const arbBrokenEntry: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
      arbMarker.map((m) => ({ ...validEntry, id: m.toUpperCase() })),
      arbMarker.map((m) => ({ ...validEntry, type: m })),
      arbMarker.map((m) => ({ ...validEntry, module: `../${m}` })),
      arbMarker.map((m) => ({ ...validEntry, schedule: m })),
      fc.oneof(fc.integer({ max: 0 }), fc.integer({ min: 901 })).map((t) => ({
        ...validEntry,
        timeoutSeconds: t,
      })),
      arbMarker.map((m) => ({ ...validEntry, unexpected: m })),
      fc
        .constantFrom('id', 'type', 'module', 'enabled', 'schedule')
        .map((key) => without(validEntry, key)),
    );

    fc.assert(
      fc.property(
        fc.array(fc.constant(null), { maxLength: 3 }),
        arbBrokenEntry,
        fc.nat(),
        (others, broken, position) => {
          const file = others.map((_, i) => ({ ...validEntry, id: `connector-${i}` }));
          file.splice(position % (file.length + 1), 0, broken as typeof validEntry);
          expect(connectorsFileSchema.safeParse(file).success).toBe(false);
        },
      ),
      RUNS,
    );
  });
});
