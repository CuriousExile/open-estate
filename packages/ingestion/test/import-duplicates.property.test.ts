// Feature: duplicate-detection, Property 23: Import und Duplikate
import {
  connectorConfigSchema,
  ConnectorFramework,
  ConnectorRegistry,
  ImportPipeline,
  InMemoryImportStore,
  type Connector,
  type ConnectorModule,
} from '@open-estate/ingestion';
import { buildSchemas, TourProvidersConfig } from '@open-estate/shared';
import fc from 'fast-check';
import { z } from 'zod';
import {
  arbRealisticInput,
  arbVariantOptions,
  formattingVariant,
  TAXONOMY,
} from '../../shared/test/arbitraries/duplicates';

/**
 * For any sequence of Import_Datensätze of a run (new listings, repeated ids, spelling variants
 * of the same property, with or without a delivered status): `imported + updated + unchanged +
 * rejected` = processed records; `flagged` = listings created as duplicates ≤ `imported`; each of
 * them is `INACTIVE` regardless of the delivered status; listings that existed before the run
 * keep their status; and the run log names every flagged listing once.
 *
 * **Validates: Requirements 5.1, 5.2, 5.5, 6.2**
 */

const SOURCE = 'crm-feed';
const MODULE = 'dummy-feed';
const NOW = new Date('2026-11-05T10:00:00.000Z');
const listingSchema = buildSchemas(TAXONOMY, {
  defaultLocale: 'de',
  enabled: [{ locale: 'de', label: 'Deutsch' }],
}).listing;
const tourProviders = TourProvidersConfig.parse({ providers: [] });

interface EmittedRecord {
  /** Listing id: a small range, so ids repeat (updates). */
  id: number;
  /** Index into the content pool. */
  content: number;
  status: 'ACTIVE' | 'INACTIVE' | undefined;
}

const arbScenario = fc.record({
  pool: fc.array(arbRealisticInput(), { minLength: 1, maxLength: 2 }).chain((bases) =>
    fc.array(
      fc
        .tuple(fc.constantFrom(...bases), arbVariantOptions)
        .map(([base, o]) => formattingVariant(base, o)),
      { minLength: 1, maxLength: 4 },
    ),
  ),
  seeded: fc.array(fc.nat(), { maxLength: 3 }),
  records: fc.array(
    fc.record({
      id: fc.nat({ max: 5 }),
      content: fc.nat(),
      status: fc.constantFrom('ACTIVE' as const, 'INACTIVE' as const, undefined),
    }),
    { minLength: 1, maxLength: 8 },
  ),
});

function moduleEmitting(records: readonly Record<string, unknown>[]): ConnectorModule {
  return {
    name: MODULE,
    type: 'external-api',
    settingsSchema: z.strictObject({}),
    create: (): Connector => ({
      type: 'external-api',
      initialize: async () => undefined,
      run: async (ctx) => {
        for (const record of records) await ctx.emit(record);
      },
      reportStatus: () => ({ state: 'idle', imported: 0, updated: 0, rejected: 0 }),
    }),
  };
}

describe('Property 23: Import und Duplikate', () => {
  it('counts flagged creations, stores them INACTIVE and keeps existing statuses', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async ({ pool, seeded, records }) => {
        let time = NOW.getTime();
        const store = new InMemoryImportStore({
          clock: () => (time += 1000),
          duplicates: { taxonomy: TAXONOMY },
        });
        const pipeline = new ImportPipeline({
          listingSchema,
          reader: store.reader,
          writer: store.writer,
          tourProviders,
          taxonomy: TAXONOMY,
          ...(store.detector !== undefined && { duplicates: store.detector }),
          clock: () => (time += 1000),
        });
        const contentOf = (n: number) => pool[n % pool.length] ?? {};
        const raw = (record: EmittedRecord) => ({
          ...contentOf(record.content),
          id: `lst-${record.id}`,
          ...(record.status !== undefined && { status: record.status }),
        });

        // Listings that exist before the run, imported by an earlier run.
        const framework = (emitted: readonly Record<string, unknown>[], lines: string[]) =>
          new ConnectorFramework({
            registry: new ConnectorRegistry([moduleEmitting(emitted)]),
            processor: pipeline,
            sink: (line) => lines.push(line),
            now: () => NOW,
          });
        const config = connectorConfigSchema.parse({
          id: SOURCE,
          type: 'external-api',
          module: MODULE,
          enabled: true,
          schedule: 'rate(1 hour)',
          settings: {},
        });
        const earlier = seeded.map((n) => raw({ id: n % 6, content: n, status: 'ACTIVE' }));
        await framework(earlier, []).runConnector(config, { runId: 'run-0' });
        const before = new Map(store.listings.all().map((item) => [item.id, item.status]));

        const lines: string[] = [];
        const summary = await framework(records.map(raw), lines).runConnector(config, {
          runId: 'run-1',
        });

        const { imported, updated, unchanged, rejected, flagged } = summary;
        expect(imported + updated + unchanged + rejected).toBe(records.length);
        expect(flagged).toBeLessThanOrEqual(imported);

        // Created as a duplicate = version 1 carries the Statusbegründung (Req 5.4). A later
        // record of the same run may change the listing so that its Markierung goes again; it
        // stays counted, and it stays INACTIVE, because updates never change the status.
        const created = store.listings.all().filter((item) => !before.has(item.id));
        const createdFlagged = [];
        for (const item of created) {
          const v1 = await store.versions.get(item.id, 1);
          if (v1?.statusReason?.code === 'DUPLICATE') {
            expect(v1.status).toBe('INACTIVE');
            createdFlagged.push(item);
          }
        }
        expect(flagged).toBe(createdFlagged.length);
        for (const item of createdFlagged) expect(item.status).toBe('INACTIVE');
        for (const [id, status] of before)
          expect(store.managed(id)?.management.status).toBe(status);

        const flaggedLines = lines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((entry) => entry['event'] === 'record.flagged');
        expect(flaggedLines.map((e) => e['listingId']).sort()).toEqual(
          createdFlagged.map((item) => item.id).sort(),
        );
      }),
      { numRuns: 100 },
    );
  });
});
