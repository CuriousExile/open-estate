import { contentRules, prepareContent, type Candidate, type ContentRules } from '@open-estate/core';
import {
  ListingBase,
  type PiiAllowlistConfig,
  type Schemas,
  type TourProvidersConfig,
} from '@open-estate/shared';
import type { RawRecord } from '../connector';
import type { RecordOutcome, RecordProcessingContext, RecordProcessor } from '../record-processor';
import { DeletionBlockedError, type DeletionBlocklist } from './deletion-blocklist';
import type { ListingWriter } from './listing-writer';

/** Rejection reason for blocked ids, as required verbatim by Req 18.7. */
export const DELETION_BLOCK_REASON = 'Löschsperre';

/** Provenance fields; set by the pipeline only (Req 4.12, 11.5). */
const PROVENANCE_FIELDS = ['source', 'lastImportedAt', 'lastRunId'] as const;

/** Top-level fields a connector may deliver: the listing schema without provenance. */
const MAPPED_FIELDS = Object.keys(ListingBase.shape).filter(
  (key) => !(PROVENANCE_FIELDS as readonly string[]).includes(key),
);

const ListingId = ListingBase.shape.id;

export interface ImportPipelineOptions {
  /** `buildSchemas(taxonomy, locales).listing`: listing type restricted to the loaded taxonomy. */
  readonly listingSchema: Schemas['listing'];
  readonly blocklist: DeletionBlocklist;
  /** Step 7 (atomic upsert); a `DeletionBlockedError` is recorded as rejected („Löschsperre“). */
  readonly writer: ListingWriter;
  /** Content of `pii-allowlist.json`; `undefined` (file missing) or empty ⇒ drop every PII field. */
  readonly piiAllowlist?: PiiAllowlistConfig;
  /** Content of `tour-providers.json`. */
  readonly tourProviders: TourProvidersConfig;
  readonly now?: () => Date;
}

/**
 * `ImportPipeline.process(raw)` (design: "Connector_Framework und Import-Pipeline", Req 4.8–4.10,
 * 4.12, 5.5, 5.6, 12.4, 12.5, 12.11, 12.14, 16.1–16.5, 16.8, 16.11, 18.1–18.3, 18.7).
 *
 * Execution order and why it deviates from the numbering of the design:
 * 1. Mapping — keep the listing fields only (unknown fields are dropped, never stored).
 * 2. Deletion blocklist — reject with reason „Löschsperre“, nothing else happens.
 * 6. Enrichment — provenance is a required part of the schema, so it is set before validation.
 *    It touches neither PII nor media fields, so setting it before steps 3 and 5 is equivalent.
 * 3./5./4. `prepareContent` (core): PII filter, media/tour cleanup, validation — both filters run
 *    before validation, so an invalid but dropped value causes no rejection (Req 16.4, 16.5).
 *    Every field issue is logged, the writer is not called.
 * 7. Write (`ListingWriter`), its outcome is the record outcome; blocked at write time ⇒ rejected.
 *
 * Logs never contain field values (Req 18.2); only ids, field names, reasons and tour URLs.
 * If `id` itself is invalid nothing can be attributed or stored: steps 3 and 5 run without
 * logging and validation rejects the record with all issues.
 */
export class ImportPipeline implements RecordProcessor {
  private readonly listingSchema: Schemas['listing'];
  private readonly blocklist: DeletionBlocklist;
  private readonly writer: ListingWriter;
  private readonly rules: ContentRules;
  private readonly now: () => Date;

  constructor(options: ImportPipelineOptions) {
    this.listingSchema = options.listingSchema;
    this.blocklist = options.blocklist;
    this.writer = options.writer;
    this.rules = contentRules(options);
    this.now = options.now ?? (() => new Date());
  }

  async process(raw: RawRecord, ctx: RecordProcessingContext): Promise<RecordOutcome> {
    const { logger } = ctx;

    // 1. Mapping: the connector delivers the listing input format; source-specific mapping is
    //    the connector's job. Unknown and provenance fields are not taken over.
    const mapped = mapToSchema(raw);
    const id = ListingId.safeParse(mapped['id']);
    const listingId = id.success ? id.data : undefined;

    // 2. Deletion blocklist (Req 18.7).
    if (listingId !== undefined && (await this.blocklist.has(listingId))) {
      logger.recordRejected(listingId, [{ field: 'id', reason: DELETION_BLOCK_REASON }]);
      return 'rejected';
    }

    // 6. Enrichment (Req 4.12, 11.5): raw values for these fields were not mapped.
    const candidate: Candidate = {
      ...mapped,
      source: ctx.source,
      lastImportedAt: this.now().toISOString(),
      lastRunId: ctx.runId,
    };

    // 3. PII filter (Req 18.1–18.3), 5. media/tour cleanup (Req 16.1, 16.2, 16.4, 16.5, 16.11),
    // 4. validation (Req 4.8–4.10, 5.5, 5.6, 12.4, 12.5, 12.11, 12.14).
    const prepared = prepareContent(candidate, this.listingSchema, this.rules);

    if (listingId !== undefined) {
      prepared.droppedPii.forEach((field) => logger.piiFieldDropped(listingId, field));
      prepared.mediaDrops.forEach(({ kind, index, reason, url }) =>
        logger.mediaDropped(listingId, kind, index, reason, url),
      );
      prepared.mediaTruncations.forEach(({ kind, droppedCount }) =>
        logger.mediaTruncated(listingId, kind, droppedCount),
      );
    }

    if (!prepared.ok) {
      logger.recordRejected(listingId, prepared.issues);
      return 'rejected';
    }

    // 7. Atomic upsert. The writer re-checks the blocklist in the same transaction, which closes
    //    the race with a deletion that happens after step 2.
    try {
      return await this.writer.write(prepared.content);
    } catch (error) {
      if (!(error instanceof DeletionBlockedError)) throw error;
      logger.recordRejected(prepared.content.id, [{ field: 'id', reason: DELETION_BLOCK_REASON }]);
      return 'rejected';
    }
  }
}

function mapToSchema(raw: RawRecord): Candidate {
  const candidate: Candidate = {};
  for (const key of MAPPED_FIELDS) {
    if (Object.hasOwn(raw, key)) candidate[key] = raw[key];
  }
  return candidate;
}
