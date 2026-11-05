import type {
  Connector,
  ConnectorModule,
  ConnectorStatus,
  RawRecord,
} from '@open-estate/ingestion';
import { z } from 'zod';
import { markDemoContent } from './demo-data';

// DEV ONLY: a connector module that replays fixed batches of records, so the local demo runs the
// real ConnectorFramework and ImportPipeline (field merge, provenance, IMPORT versions, rejections,
// persisted run summaries) without any external source.

export const DEMO_FEED_MODULE = 'demo-crm-feed';

const settingsSchema = z.object({
  /** Index of the batch to replay. */
  batch: z.int().min(0),
  /** Simulated source failure after this many records (run status `FAILURE`). */
  failAfter: z.int().min(0).optional(),
});
type DemoFeedSettings = z.infer<typeof settingsSchema>;

export function demoFeedModule(
  batches: readonly (readonly RawRecord[])[],
): ConnectorModule<DemoFeedSettings> {
  return {
    name: DEMO_FEED_MODULE,
    type: 'external-api',
    settingsSchema,
    create(): Connector<DemoFeedSettings> {
      let state: ConnectorStatus['state'] = 'idle';
      return {
        type: 'external-api',
        async initialize() {
          state = 'initialized';
        },
        async run(ctx) {
          state = 'running';
          const records = batches[ctx.config.batch] ?? [];
          for (const [index, record] of records.entries()) {
            if (ctx.config.failAfter !== undefined && index >= ctx.config.failAfter) {
              state = 'failed';
              throw new Error('Demo CRM: upstream request timed out');
            }
            // Mark demo data at the source; only touches title/description, so records that are
            // meant to be rejected (unknown type, negative area, missing identity) still are.
            await ctx.emit(markDemoContent(record as Record<string, unknown>) as RawRecord);
          }
          state = 'succeeded';
        },
        reportStatus: () => ({ state, imported: 0, updated: 0, rejected: 0 }),
      };
    },
  };
}
