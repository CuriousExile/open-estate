import { randomUUID } from 'node:crypto';
import {
  agencyScope,
  cleanMedia,
  contentRules,
  contentToInput,
  creationTime,
  creationTimeAfterCheck,
  DuplicateIndexUnavailable,
  flagsAfterCheck,
  type DuplicateAssessment,
  type DuplicateDetectionSwitch,
  type DuplicateDetector,
  filterPii,
  prepareContent,
  type Candidate,
  type ContentRules,
  type FieldIssue,
  type ManagedListing,
  type MediaDrop,
  type MediaTruncation,
  type StateChange,
  type WriteConflict,
  type WriteResult,
} from '@open-estate/core';
import {
  CustomId,
  ListingBase,
  ListingStatusSchema,
  mergeImport,
  PII_FIELD_PATHS,
  type DuplicateFlag,
  type ImportRecord,
  type ListingContent,
  type ListingFlag,
  type ListingStatus,
  type PiiAllowlistConfig,
  type Schemas,
  type Taxonomy,
  type TourProvidersConfig,
} from '@open-estate/shared';
import type { RawRecord } from '../connector';
import type { RecordOutcome, RecordProcessingContext, RecordProcessor } from '../record-processor';
import type { RunLogger } from '../run-logger';
import {
  IMPORT_TARGET_REJECTION_REASONS,
  resolveImportTarget,
  type ImportIdentity,
  type ImportTarget,
  type ImportTargetReader,
  type ImportTargetRejectionCode,
} from './import-target';

/** Rejection reason for blocked ids, as required verbatim by Req 18.7. */
export const DELETION_BLOCK_REASON = IMPORT_TARGET_REJECTION_REASONS.DELETION_BLOCKED;

/** Rejection reason after {@link MAX_WRITE_RETRIES} version conflicts (design: "Import"). */
export const CONCURRENT_CHANGE_REASON = 'Nebenläufige Änderung';

/** Repetitions of steps 2–7 after a version conflict with a parallel write. */
export const MAX_WRITE_RETRIES = 3;

/** Rejection reason when the Duplikat_Index cannot be read (duplicate-detection Req 5.9). */
export const DUPLICATE_CHECK_UNAVAILABLE_REASON = 'Duplikatprüfung nicht verfügbar';

/** Provenance fields; set by the `VersionedListingWriter` only (Req 4.12, 4.16, 11.5). */
const PROVENANCE_FIELDS = ['source', 'lastImportedAt', 'lastRunId'] as const;

/** Fields a connector may deliver: the listing schema without provenance, plus identity/status. */
const MAPPED_FIELDS = [
  ...Object.keys(ListingBase.shape).filter(
    (key) => !(PROVENANCE_FIELDS as readonly string[]).includes(key),
  ),
  'customId',
  'status',
];

const ListingId = ListingBase.shape.id;

/**
 * Stand-in provenance for validating against the listing schema. The writer derives the real
 * values (Req 4.16); provenance is not part of the Listing_Inhalt and does not reach the store.
 */
const VALIDATION_TIMESTAMP = new Date(0).toISOString();

/** Rejection field per identity rejection code (the run log names a field per issue). */
const TARGET_REJECTION_FIELD: Readonly<Record<ImportTargetRejectionCode, string>> = {
  IDENTITY_MISSING: 'id',
  IDENTITY_CONFLICT: 'customId',
  DELETION_BLOCKED: 'id',
  FOREIGN_AGENCY: 'id',
};

/** Write path of the import: `VersionedListingWriter.write` (channel `IMPORT`). */
export interface ImportListingWriter {
  write(change: StateChange): Promise<WriteResult>;
}

export interface ImportPipelineOptions {
  /** `buildSchemas(taxonomy, locales).listing`: listing type restricted to the loaded taxonomy. */
  readonly listingSchema: Schemas['listing'];
  /** Step 2: identity resolution (listings, Custom_Id keys, deletion blocklist). */
  readonly reader: ImportTargetReader;
  /** Step 7: versioned write; re-checks the blocklist and the version in one transaction. */
  readonly writer: ImportListingWriter;
  /** Content of `pii-allowlist.json`; `undefined` (file missing) or empty ⇒ drop every PII field. */
  readonly piiAllowlist?: PiiAllowlistConfig;
  /** Content of `tour-providers.json`. */
  readonly tourProviders: TourProvidersConfig;
  /**
   * Loaded taxonomy (the one `listingSchema` is built from); decides the allowed Objektmerkmale
   * per group (duplicate-detection Req 2.5). Without it no merkmal is dropped.
   */
  readonly taxonomy?: Taxonomy;
  /** Id of a listing created without delivered id (Req 12.5); default `randomUUID`. */
  readonly newId?: () => string;
  /**
   * Duplikat_Prüfung of every written record (duplicate-detection Req 5.1, 6.1). Every production
   * wiring sets it; without it the pipeline imports as before the feature.
   */
  readonly duplicates?: Pick<DuplicateDetector, 'assess'>;
  /**
   * Ein/Aus of the Duplikat-Erkennung (design: "Ein- und Ausschalten"); default: always on.
   * Switched off, records are written without check and without Duplikat_Index maintenance.
   */
  readonly detection?: DuplicateDetectionSwitch;
  /** Time of the Duplikat_Prüfung (Anlagezeitpunkt of new listings); default system clock. */
  readonly clock?: () => number;
}

/** Value-free log notes of one attempt; written only for the attempt that decides the record. */
type Note = (logger: RunLogger) => void;

type Attempt = { readonly outcome: RecordOutcome; readonly notes: readonly Note[] } | 'retry';

/**
 * `ImportPipeline.process(raw)` (design: "Import-Pipeline", Req 4.16, 6.7, 7.3, 12.2–12.14;
 * Req 16.1–16.5, 16.11, 18.1–18.3, 18.7 of `real-estate-platform`):
 * 1. Mapping — listing fields plus `customId` and `status`; unknown and provenance fields are
 *    dropped. Invalid `id`/`customId` reject the record (no identity, nothing attributable).
 * 2. Identity — `resolveImportTarget` (Identität fehlt, Identitätskonflikt, Löschsperre, Fremde
 *    Agentur; update, creation, agency claim).
 * 3. PII filter and media/tour cleanup on the delivered fields only (absent lists stay absent).
 * 4. `mergeImport` with the connector's Importmodus into the stored content (API representation),
 *    then PII filter, media cleanup and
 * 5. validation of the merged content (`prepareContent`), every field issue is logged.
 * 6. Status — creation: delivered value or `ACTIVE`; existing listing: stored value (Req 6.7,
 *    12.10).
 * 7. `VersionedListingWriter` with channel and change type `IMPORT`, actor `{connectorId, runId}`.
 *    `unchanged` only refreshes the provenance (writer, Req 4.16, 7.3). A version conflict with a
 *    parallel write repeats steps 2–7 up to {@link MAX_WRITE_RETRIES} times, then „Nebenläufige
 *    Änderung“.
 *
 * Logs never contain field values (Req 18.2); only ids, field names, reasons and tour URLs.
 */
export class ImportPipeline implements RecordProcessor {
  private readonly listingSchema: Schemas['listing'];
  private readonly reader: ImportTargetReader;
  private readonly writer: ImportListingWriter;
  private readonly rules: ContentRules;
  private readonly newId: () => string;
  private readonly duplicates: Pick<DuplicateDetector, 'assess'> | undefined;
  private readonly detection: DuplicateDetectionSwitch | undefined;
  private readonly clock: () => number;

  constructor(options: ImportPipelineOptions) {
    this.listingSchema = options.listingSchema;
    this.reader = options.reader;
    this.writer = options.writer;
    this.rules = contentRules(options);
    this.newId = options.newId ?? randomUUID;
    this.duplicates = options.duplicates;
    this.detection = options.detection;
    this.clock = options.clock ?? Date.now;
  }

  async process(raw: RawRecord, ctx: RecordProcessingContext): Promise<RecordOutcome> {
    const { logger } = ctx;

    // 1. Mapping (the connector delivers the listing input format).
    const mapped = mapRecord(raw);
    const identity = parseIdentity(mapped);
    if (!identity.ok) {
      reject(logger, identity.listingId, identity.issues, identity.customId);
      return 'rejected';
    }

    for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt += 1) {
      const result = await this.attempt(mapped, identity.value, ctx);
      if (result === 'retry') continue;
      result.notes.forEach((note) => note(logger));
      return result.outcome;
    }
    reject(
      logger,
      identity.value.id,
      [{ field: 'id', reason: CONCURRENT_CHANGE_REASON }],
      identity.value.customId,
    );
    return 'rejected';
  }

  /** Steps 2–7 against the current state; `retry` after a version conflict. */
  private async attempt(
    mapped: Candidate,
    identity: ImportIdentity,
    ctx: RecordProcessingContext,
  ): Promise<Attempt> {
    const connector = {
      connectorId: ctx.source,
      ...(ctx.agencyId !== undefined && { agencyId: ctx.agencyId }),
    };
    // 2. Identity.
    const target = await resolveImportTarget(identity, connector, this.reader, this.newId);
    if (target.kind === 'reject') {
      const issue = { field: TARGET_REJECTION_FIELD[target.code], reason: target.reason };
      return rejected(target.listingId, [issue], [], identity.customId);
    }
    const listingId = target.kind === 'create' ? target.id : target.listing.listing.id;
    const existing = target.kind === 'update' ? target.listing : undefined;
    const customId = identity.customId ?? existing?.management.customId;
    const notes: Note[] = [];

    // 3. PII filter and media/tour cleanup on the delivered fields.
    const delivered = this.cleanDelivered(mapped, listingId, notes);

    // 4. Merge with the Importmodus, 4b./5. PII filter on the result and validation.
    const merged = mergeImport(
      existing === undefined ? undefined : storedContent(existing),
      delivered as ImportRecord,
      ctx.importMode ?? 'MERGE',
    );
    const prepared = prepareContent(
      {
        ...merged,
        id: listingId,
        source: existing?.listing.source ?? ctx.source,
        lastImportedAt: VALIDATION_TIMESTAMP,
        lastRunId: ctx.runId,
      },
      this.listingSchema,
      this.rules,
    );
    notes.push(...dropNotes(listingId, prepared));

    // 6. Status: delivered only for a new listing (Req 6.7, 12.5, 12.10).
    const status = statusOf(target, mapped['status']);
    const issues = [...(prepared.ok ? [] : prepared.issues), ...(status.ok ? [] : [status.issue])];
    if (!prepared.ok || !status.ok) return rejected(listingId, issues, notes, customId);

    // 5a. Duplikat_Prüfung (duplicate-detection Req 5.1, 5.2, 6.1, 6.2).
    const agencyId = agencyOf(target, ctx.agencyId);
    const duplicate = await this.checkDuplicates(listingId, target, prepared.content, agencyId);
    if (duplicate === 'unavailable') {
      const issue = { field: 'id', reason: DUPLICATE_CHECK_UNAVAILABLE_REASON };
      return rejected(listingId, [issue], notes, customId);
    }
    // A new duplicate is stored, but not published (Req 5.2); existing listings keep their
    // status whatever the check finds (Req 6.2, 6.7 of `listing-management`).
    const checked = duplicate === 'disabled' ? undefined : duplicate;
    const flag = checked?.flag ?? null;
    const flagged = target.kind === 'create' && flag !== null;

    // 7. Versioned write.
    const result = await this.writer.write({
      listingId,
      expectedVersion: target.kind === 'update' ? target.expectedVersion : null,
      next: {
        content: prepared.content,
        status: flagged ? 'INACTIVE' : status.value,
        ...optional('customId', customId),
        ...optional('agencyId', agencyId),
      },
      changeType: 'IMPORT',
      channel: 'IMPORT',
      actor: { kind: 'connector', connectorId: ctx.source, runId: ctx.runId },
      ...(checked !== undefined && {
        flags: checked.flags,
        assessment: checked.assessment,
        ...(target.kind === 'create' && { createdAt: checked.createdAt }),
        ...(flagged && {
          statusReason: { code: 'DUPLICATE' as const, originalId: flag.originalId },
        }),
      }),
      ...(duplicate === 'disabled' && { duplicateDetection: 'disabled' as const }),
    });
    if (!result.ok) return conflictOutcome(result.error, listingId, notes, customId);
    const outcome = OUTCOMES[result.value.outcome];
    if (outcome === 'imported' && flagged) {
      const { originalId, matches } = flag;
      const reasons = matches.find((m) => m.listingId === originalId)?.reasons ?? [];
      notes.push((logger) => logger.recordFlagged(listingId, originalId, reasons));
      return { outcome: 'flagged', notes };
    }
    return { outcome, notes };
  }

  /**
   * Step 5a: Duplikat_Prüfung of the merged content in the Prüfbereich of the listing after the
   * write. `undefined` without a detector; `disabled` if the Duplikat-Erkennung is switched off;
   * `unavailable` if the Duplikat_Index or the switch cannot be read.
   */
  private async checkDuplicates(
    listingId: string,
    target: ImportTarget,
    content: ListingContent,
    agencyId: string | undefined,
  ): Promise<DuplicateCheck | 'disabled' | 'unavailable' | undefined> {
    const detector = this.duplicates;
    if (detector === undefined) return undefined;
    try {
      if (this.detection !== undefined && !(await this.detection.isEnabled())) return 'disabled';
    } catch {
      return 'unavailable';
    }
    const now = new Date(this.clock()).toISOString();
    const existing = target.kind === 'update' ? target.listing : undefined;
    let createdAt = existing === undefined ? now : creationTime(existing);
    let assessment: DuplicateAssessment;
    try {
      assessment = await detector.assess({
        listingId,
        scope: agencyScope(agencyId),
        createdAt,
        content,
      });
    } catch (error) {
      if (error instanceof DuplicateIndexUnavailable) return 'unavailable';
      throw error;
    }
    if (existing === undefined) createdAt = creationTimeAfterCheck(createdAt, assessment);
    const { flags, flag } = flagsAfterCheck(
      existing === undefined ? 'CREATE' : 'UPDATE',
      { listingId, createdAt },
      assessment,
      existing?.management.flags ?? [],
      now,
    );
    return { assessment, flags, flag, createdAt };
  }

  /**
   * Step 3: PII filter and media/tour cleanup on the delivered fields. `cleanMedia` turns a
   * missing list into `[]`; that would clear stored media under `MERGE`, so absence is restored.
   */
  private cleanDelivered(mapped: Candidate, listingId: string, notes: Note[]): Candidate {
    const pii = filterPii(mapped, PII_FIELD_PATHS, this.rules.allowedPii);
    const media = cleanMedia(pii.candidate, this.rules.tourHosts);
    notes.push(
      ...dropNotes(listingId, {
        droppedPii: pii.dropped,
        mediaDrops: media.drops,
        mediaTruncations: media.truncations,
      }),
    );
    const cleaned: Candidate = { ...media.candidate };
    if (mapped['media'] === undefined) delete cleaned['media'];
    if (mapped['tours'] === undefined) delete cleaned['tours'];
    return cleaned;
  }
}

const OUTCOMES = { created: 'imported', updated: 'updated', unchanged: 'unchanged' } as const;

/** Result of step 5a. */
interface DuplicateCheck {
  assessment: DuplicateAssessment;
  flags: ListingFlag[];
  flag: DuplicateFlag | null;
  createdAt: string;
}

function mapRecord(raw: RawRecord): Candidate {
  const candidate: Candidate = {};
  for (const key of MAPPED_FIELDS) {
    if (Object.hasOwn(raw, key)) candidate[key] = raw[key];
  }
  return candidate;
}

type ParsedIdentity =
  | { ok: true; value: ImportIdentity }
  | { ok: false; listingId?: string; customId?: string; issues: FieldIssue[] };

/** Delivered `id`/`customId` must be valid to resolve the target; absent ones are fine. */
function parseIdentity(mapped: Candidate): ParsedIdentity {
  const issues: FieldIssue[] = [];
  const parse = (field: 'id' | 'customId', schema: typeof CustomId): string | undefined => {
    const value = mapped[field];
    if (value === undefined) return undefined;
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    issues.push(...parsed.error.issues.map((issue) => ({ field, reason: issue.message })));
    return undefined;
  };
  const id = parse('id', ListingId);
  const customId = parse('customId', CustomId);
  if (issues.length > 0) {
    return { ok: false, ...optional('listingId', id), ...optional('customId', customId), issues };
  }
  return { ok: true, value: { ...optional('id', id), ...optional('customId', customId) } };
}

/** Stored content in the API representation, the format of the Import_Datensatz. */
function storedContent(existing: ManagedListing): ListingContent {
  // `mergeImport` is structural; it is typed with the internal representation only.
  return contentToInput(existing.listing) as unknown as ListingContent;
}

type StatusResult = { ok: true; value: ListingStatus } | { ok: false; issue: FieldIssue };

function statusOf(target: ImportTarget, delivered: unknown): StatusResult {
  if (target.kind === 'update') return { ok: true, value: target.listing.management.status };
  if (delivered === undefined) return { ok: true, value: 'ACTIVE' };
  const parsed = ListingStatusSchema.safeParse(delivered);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, issue: { field: 'status', reason: parsed.error.issues[0]?.message ?? '' } };
}

/** Owning agency after the write: the connector's on creation and claim (Req 12.5, 12.13). */
function agencyOf(target: ImportTarget, connectorAgency: string | undefined): string | undefined {
  if (target.kind === 'update' && !target.claimAgency) return target.listing.management.agencyId;
  return connectorAgency;
}

function conflictOutcome(
  conflict: WriteConflict,
  listingId: string,
  notes: Note[],
  customId: string | undefined,
): Attempt {
  switch (conflict.code) {
    // A concurrent write, or a concurrent Exakt_Duplikat that claimed the exact key first
    // (duplicate-detection Req 9.1): resolve the target and assess again.
    case 'VERSION_CONFLICT':
    case 'NOT_FOUND':
    case 'EXACT_CLAIMED':
      return 'retry';
    case 'IDEMPOTENCY_RACE':
      // Imports carry no Idempotenzschlüssel; this cannot happen.
      throw new Error('Unexpected idempotency conflict in the import pipeline');
    case 'DELETION_BLOCKED':
      return rejected(listingId, [{ field: 'id', reason: DELETION_BLOCK_REASON }], notes, customId);
    case 'CUSTOM_ID_TAKEN':
      return rejected(
        listingId,
        [{ field: 'customId', reason: IMPORT_TARGET_REJECTION_REASONS.IDENTITY_CONFLICT }],
        notes,
      );
  }
}

function rejected(
  listingId: string | undefined,
  issues: readonly FieldIssue[],
  notes: readonly Note[],
  customId?: string,
): Attempt {
  return {
    outcome: 'rejected',
    notes: [...notes, (logger) => reject(logger, listingId, issues, customId)],
  };
}

/** Logs a rejection; the Custom_Id only if valid (identifier, never a field value, Req 13.3). */
function reject(
  logger: RunLogger,
  listingId: string | undefined,
  issues: readonly FieldIssue[],
  customId: string | undefined,
): void {
  if (customId === undefined) logger.recordRejected(listingId, issues);
  else logger.recordRejected(listingId, issues, customId);
}

interface Drops {
  readonly droppedPii: readonly string[];
  readonly droppedAttributes?: readonly string[];
  readonly mediaDrops: readonly MediaDrop[];
  readonly mediaTruncations: readonly MediaTruncation[];
}

function dropNotes(listingId: string, drops: Drops): Note[] {
  return [
    ...drops.droppedPii.map(
      (field): Note =>
        (logger) =>
          logger.piiFieldDropped(listingId, field),
    ),
    ...(drops.droppedAttributes ?? []).map(
      (field): Note =>
        (logger) =>
          logger.attributeDropped(listingId, field),
    ),
    ...drops.mediaDrops.map(
      ({ kind, index, reason, url }): Note =>
        (logger) =>
          logger.mediaDropped(listingId, kind, index, reason, url),
    ),
    ...drops.mediaTruncations.map(
      ({ kind, droppedCount }): Note =>
        (logger) =>
          logger.mediaTruncated(listingId, kind, droppedCount),
    ),
  ];
}

/** `{ [key]: value }` if defined, else `{}` (for `exactOptionalPropertyTypes`). */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
