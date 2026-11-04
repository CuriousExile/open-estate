import {
  ListingBase,
  PII_FIELD_PATHS,
  tourHostIndex,
  type PiiAllowlistConfig,
  type Schemas,
  type TourProvidersConfig,
} from '@open-estate/shared';
import type { z } from 'zod';
import type { RawRecord } from '../connector';
import type { RecordOutcome, RecordProcessingContext, RecordProcessor } from '../record-processor';
import type { FieldIssue } from '../run-logger';
import { DeletionBlockedError, type DeletionBlocklist } from './deletion-blocklist';
import type { ListingWriter } from './listing-writer';
import { cleanMedia } from './media-cleanup';
import { filterPii, type Candidate } from './pii-filter';

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
 * 3. PII filter — before validation, so an invalid but dropped PII value causes no rejection.
 * 5. Media/tour cleanup — before validation as well: an invalid medium or tour is dropped on
 *    its own and the rest is stored (Req 16.4, 16.5); validating first would reject the listing.
 * 6. Enrichment — provenance is a required part of the schema, so it is set before validation.
 * 4. Validation — every field issue is logged, the writer is not called.
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
  private readonly allowedPii: ReadonlySet<string>;
  private readonly tourHosts: ReadonlyMap<string, string>;
  private readonly now: () => Date;

  constructor(options: ImportPipelineOptions) {
    this.listingSchema = options.listingSchema;
    this.blocklist = options.blocklist;
    this.writer = options.writer;
    this.allowedPii = new Set(options.piiAllowlist?.allowedFields ?? []);
    this.tourHosts = tourHostIndex(options.tourProviders);
    this.now = options.now ?? (() => new Date());
  }

  async process(raw: RawRecord, ctx: RecordProcessingContext): Promise<RecordOutcome> {
    const { logger } = ctx;

    // 1. Mapping: the connector delivers the listing input format; source-specific mapping is
    //    the connector's job. Unknown and provenance fields are not taken over.
    let candidate = mapToSchema(raw);
    const id = ListingId.safeParse(candidate['id']);
    const listingId = id.success ? id.data : undefined;

    // 2. Deletion blocklist (Req 18.7).
    if (listingId !== undefined && (await this.blocklist.has(listingId))) {
      logger.recordRejected(listingId, [{ field: 'id', reason: DELETION_BLOCK_REASON }]);
      return 'rejected';
    }

    // 3. PII filter (Req 18.1–18.3).
    const pii = filterPii(candidate, PII_FIELD_PATHS, this.allowedPii);
    candidate = pii.candidate;

    // 5. Media/tour cleanup (Req 16.1, 16.2, 16.4, 16.5, 16.11).
    const media = cleanMedia(candidate, this.tourHosts);
    candidate = media.candidate;

    if (listingId !== undefined) {
      pii.dropped.forEach((field) => logger.piiFieldDropped(listingId, field));
      media.drops.forEach(({ kind, index, reason, url }) =>
        logger.mediaDropped(listingId, kind, index, reason, url),
      );
      media.truncations.forEach(({ kind, droppedCount }) =>
        logger.mediaTruncated(listingId, kind, droppedCount),
      );
    }

    // 6. Enrichment (Req 4.12, 11.5): raw values for these fields were not mapped.
    candidate = {
      ...candidate,
      source: ctx.source,
      lastImportedAt: this.now().toISOString(),
      lastRunId: ctx.runId,
    };

    // 4. Validation (Req 4.8–4.10, 5.5, 5.6, 12.4, 12.5, 12.11, 12.14).
    const result = this.listingSchema.safeParse(candidate);
    if (!result.success) {
      logger.recordRejected(listingId, toFieldIssues(result.error.issues));
      return 'rejected';
    }

    // 7. Atomic upsert. The writer re-checks the blocklist in the same transaction, which closes
    //    the race with a deletion that happens after step 2.
    try {
      return await this.writer.write(result.data);
    } catch (error) {
      if (!(error instanceof DeletionBlockedError)) throw error;
      logger.recordRejected(result.data.id, [{ field: 'id', reason: DELETION_BLOCK_REASON }]);
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

/**
 * One issue per affected field. `unrecognized_keys` (e.g. rent fields on a `SALE` offer) names
 * several fields at once and is split so each one is logged (Req 12.5). Zod messages describe
 * types and bounds, not input values.
 */
export function toFieldIssues(issues: readonly z.core.$ZodIssue[]): FieldIssue[] {
  return issues.flatMap((issue) => {
    const path = issue.path.map(String);
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        field: [...path, key].join('.'),
        reason: 'Unrecognized field',
      }));
    }
    return [{ field: path.length === 0 ? 'record' : path.join('.'), reason: issue.message }];
  });
}
