import { randomUUID } from 'node:crypto';
import {
  AssignAgencyRequest,
  authorize,
  contentHash,
  CreateListingRequest,
  err,
  ManualContentInputBase,
  ok,
  publicDetailUrl,
  refineListing,
  ReplaceContentRequest,
  RestoreRequest,
  SetStatusRequest,
  toApiErrors,
  typeCodes,
  duplicateFlagOf,
  IDEMPOTENCY_WINDOW_SECONDS,
  IdempotencyKey,
  idempotencyKeyHash,
  idempotencyRequestHash,
  withDuplicateFlag,
  type ApiError,
  type ChangeType,
  type Channel,
  type ListingContent,
  type ListingFlag,
  type ListingView,
  type ManualContentInput,
  type Origin,
  type Permission,
  type Principal,
  type Result,
  type Taxonomy,
  type VersionedState,
} from '@open-estate/shared';
import { z } from 'zod';
import { systemClock, type Clock } from '../access/ttl-cache';
import { prepareContent, type ContentRules, type FieldIssue } from '../content/prepare-content';
import {
  DuplicateIndexUnavailable,
  type DuplicateAssessment,
  type DuplicateDetector,
} from '../duplicates/duplicate-detector';
import {
  creationTimeAfterCheck,
  flagDetails,
  flagsAfterCheck,
  sameFlag,
} from '../duplicates/duplicate-decision';
import type { DuplicateDetectionSwitch } from '../duplicates/duplicate-detection-setting';
import type { IdempotencyActorKey, IdempotencyStore } from '../duplicates/idempotency-store';
import { creationTime } from '../search/listings-table';
import type { Candidate } from '../content/pii-filter';
import {
  AgencyAuditTrail,
  apiError,
  decisionError,
  notFound,
  actorRef,
  type AgencyActor,
  type AgencyAudit,
} from './agency-audit';
import type { AgencyStore } from './agency-store';
import type { ManagedListing, ManagedListingStore } from './listing-store';
import type { ListingVersionStore } from './listing-version-store';
import { contentToInput, scopeListingView, toListingView } from './listing-view';
import type { SnapshotStore } from './snapshot-store';
import { agencyScope } from './metric-counter-store';
import type {
  StateChange,
  VersionedListingWriter,
  WriteConflict,
  WriteResult,
} from './versioned-listing-writer';

// Listing commands of the Management_API (design: "ListingCommandService und
// VersionedListingWriter", Req 4, 6.2, 6.6, 8, 10.2, 10.5, 10.6).

export type ListingAuditAction =
  | 'listing.create'
  | 'listing.update'
  | 'listing.status'
  | 'listing.assign'
  | 'listing.restore'
  /** Repeated creation answered from its Idempotenzschlüssel (duplicate-detection Req 9.2). */
  | 'listing.create.replay'
  /** Markierung set, changed or removed by a write, or dismissed (duplicate-detection Req 7.7). */
  | 'listing.flag.set'
  | 'listing.flag.update'
  | 'listing.flag.remove'
  | 'listing.flag.dismiss';

/** Content schema of the current rules: `ManualContentInput` with the taxonomy's type codes. */
export type ManualContentSchema = z.ZodType<ManualContentInput>;

/** `ManualContentInput` with `listingType` restricted to the taxonomy (as `buildSchemas`). */
export function manualContentSchema(taxonomy: Taxonomy): ManualContentSchema {
  return refineListing(
    ManualContentInputBase.extend({ listingType: z.enum(typeCodes(taxonomy)) }),
  ) as ManualContentSchema;
}

export interface ListingCommandServiceDeps {
  listings: Pick<ManagedListingStore<unknown>, 'get'>;
  versions: Pick<ListingVersionStore<unknown>, 'get'>;
  snapshots: Pick<SnapshotStore, 'get'>;
  /** Existence of the target agency of a Plattform_Admin (creation, assignment). */
  agencies: Pick<AgencyStore<unknown>, 'get'>;
  writer: Pick<VersionedListingWriter<unknown>, 'write'> &
    Partial<Pick<VersionedListingWriter<unknown>, 'setFlags'>>;
  audit: AgencyAudit;
  /** Frontend origin (SSM `/open-estate/{env}/frontend-origin`) for the Öffentliche_Detail_URL. */
  frontendOrigin: string;
  /** `manualContentSchema(taxonomy)` of the currently loaded taxonomy. */
  contentSchema: ManualContentSchema;
  /** PII allow-list and tour allow-list (`contentRules`), as used by the import. */
  rules: ContentRules;
  /** Identifier of new listings; default `randomUUID`. */
  newId?: () => string;
  /**
   * Duplikat_Prüfung (duplicate-detection Req 5, 6, 8). Every production wiring sets it; without
   * it the commands behave as before the feature (tests of unrelated behaviour).
   */
  duplicates?: Pick<DuplicateDetector, 'assess'>;
  /**
   * Ein/Aus of the Duplikat-Erkennung (design: "Ein- und Ausschalten"); default: always on.
   * Switched off, no command checks or maintains the Duplikat_Index.
   */
  detection?: DuplicateDetectionSwitch;
  /** Lookup of Idempotenzschlüssel (Req 9.2); required by {@link ListingCommandService.createWithKey}. */
  idempotency?: Pick<IdempotencyStore<unknown>, 'get'>;
  /** Time of the Duplikat_Prüfung and of idempotency records; default system clock. */
  clock?: Clock;
}

/** Result of a creation with Idempotenzschlüssel: `replayed` = answered from an earlier request. */
export interface CreateOutcome {
  view: ListingView;
  replayed: boolean;
}

/** Request bodies with the Listing_Inhalt still raw: it is validated by `prepareContent`. */
const RawContent = z.record(z.string(), z.unknown());
const CreateBody = CreateListingRequest.extend({ content: RawContent });
const ReplaceBody = ReplaceContentRequest.extend({ content: RawContent });

const DELETION_BLOCK_REASON = 'Löschsperre';

const listingTarget = (id: string) => `listing/${id}`;
const isPlatformAdmin = (p: Principal) => p.kind === 'user' && p.role === 'PLATFORM_ADMIN';

/** Änderungskanal (Req 10.5): Plattform_Admin → `ADMIN`, Maschinenzugang → `API`, else `PORTAL`. */
export function channelOf(p: Principal): Channel {
  if (isPlatformAdmin(p)) return 'ADMIN';
  return p.kind === 'machine' ? 'API' : 'PORTAL';
}

const ownAgency = (p: Principal): string | undefined => ('agencyId' in p ? p.agencyId : undefined);

/** Field issues of `prepareContent` as catalog errors on `content.<path>` (Req 4.4, 8.4). */
const contentErrors = (issues: readonly FieldIssue[]): ApiError[] =>
  issues.map((issue) => ({
    code: 'INVALID_PARAMETER',
    message: issue.reason,
    field: issue.field === 'record' ? 'content' : `content.${issue.field}`,
  }));

const LIST_FIELD = { media: 'media', tour: 'tours' } as const;

/**
 * Names of the fields dropped by the import rules (Req 4.10): PII paths, Objektmerkmale the
 * listing type does not allow (duplicate-detection Req 2.5), dropped media and tours by their
 * delivered position (`media.3`), and a truncated list by its field (`media`).
 */
function droppedFieldNames(prepared: ReturnType<typeof prepareContent>): string[] {
  return [
    ...prepared.droppedPii,
    ...prepared.droppedAttributes,
    ...prepared.mediaDrops.map((drop) => `${LIST_FIELD[drop.kind]}.${drop.index}`),
    ...prepared.mediaTruncations.map((truncation) => LIST_FIELD[truncation.kind]),
  ];
}

type PreparedInput =
  { ok: true; content: ListingContent; dropped: string[] } | { ok: false; errors: ApiError[] };

/** One command after loading and authorization: everything the write needs. */
interface Command {
  actor: AgencyActor;
  action: ListingAuditAction;
  listingId: string;
  /** Agency recorded in the audit entry. */
  auditAgencyId: string | undefined;
  expectedVersion: number | null;
  next: VersionedState;
  changeType: ChangeType;
  restoredFrom?: number;
  dropped: string[];
  /**
   * Duplikat_Prüfung of the command: `CREATE` (new listing: flag and `INACTIVE`), `UPDATE` (flag
   * only), `RELEASE` (activation of a flagged listing: flag removed, Verwerfungen); absent = none.
   */
  duplicates?: 'CREATE' | 'UPDATE' | 'RELEASE';
  /** Anlagezeitpunkt of the listing (the creation time for a new one). */
  createdAt: string;
  /** Current Markierungen (none for a new listing). */
  flags: ListingFlag[];
  /** Idempotenzschlüssel record of a creation (Req 9.2). */
  idempotency?: StateChange['idempotency'];
}

/**
 * Validation, authorization and versioned write of the listing commands. Every call is audited
 * here exactly once — one entry per executed write (`SUCCESS`, or `UNCHANGED` without a new
 * version) and per rejection (first error code; `FORBIDDEN` in category `access-denied`); the
 * router must not audit these calls again.
 *
 * Bodies are passed raw (parsed JSON): the Listing_Inhalt runs through the same PII filter,
 * media/tour cleanup and schema as the import (`prepareContent`, Req 4.3, 4.4, 4.10), and the PII
 * filter has to see the content before validation. Order per command (design): load (404),
 * `authorize`, request and content validation (400), base version (409 `VERSION_CONFLICT`), write;
 * the writer checks deletion blocklist and Custom_Id in its transaction (409 `DELETION_BLOCKED`,
 * `CUSTOM_ID_TAKEN`).
 */
export class ListingCommandService {
  private readonly deps: ListingCommandServiceDeps;
  private readonly trail: AgencyAuditTrail<ListingAuditAction>;
  private readonly newId: () => string;

  private readonly clock: Clock;

  constructor(deps: ListingCommandServiceDeps) {
    this.deps = deps;
    this.trail = new AgencyAuditTrail<ListingAuditAction>(deps.audit);
    this.newId = deps.newId ?? randomUUID;
    this.clock = deps.clock ?? systemClock;
  }

  private now(): string {
    return new Date(this.clock()).toISOString();
  }

  /**
   * `POST /listings` (Req 4.1, 4.2, 4.5, 4.11): platform-assigned id, origin `MANUAL`, version 1,
   * status default `INACTIVE`. Agency actors create in their own agency; a Plattform_Admin names
   * an existing agency (`agencyId`, required).
   */
  async create(p: Principal, body: unknown): Promise<Result<ListingView, ApiError[]>> {
    return this.createInternal(p, body, {});
  }

  private async createInternal(
    p: Principal,
    body: unknown,
    options: {
      /** Idempotency record for the id the creation assigns. */
      idempotency?: (listingId: string) => NonNullable<StateChange['idempotency']>;
    },
  ): Promise<Result<ListingView, ApiError[]>> {
    const actor = { principal: p, channel: channelOf(p) };
    const action = 'listing.create';
    const rawAgency = (body as { agencyId?: unknown } | null)?.agencyId;
    const agencyId = typeof rawAgency === 'string' ? rawAgency : ownAgency(p);
    const denied = decisionError(authorize(p, 'listing:write', agencyId ?? null), 'listing:write');
    if (denied !== null) return this.trail.reject(actor, action, 'listing', agencyId, denied);

    const listingId = this.newId();
    const parsed = CreateBody.safeParse(body);
    const prepared = this.prepareRaw(body, listingId, 'MANUAL');
    const errors = [
      ...(parsed.success ? [] : toApiErrors(parsed.error.issues)),
      ...(prepared.ok ? [] : prepared.errors),
    ];
    if (agencyId === undefined) {
      errors.push({ ...apiError('INVALID_PARAMETER', 'agencyId is required'), field: 'agencyId' });
    }
    if (!parsed.success || !prepared.ok || agencyId === undefined) {
      return this.rejectAll(actor, action, 'listing', agencyId, errors);
    }
    if (isPlatformAdmin(p) && (await this.deps.agencies.get(agencyId)) === null) {
      return this.trail.reject(actor, action, 'listing', agencyId, unknownAgency());
    }

    const { status, customId } = parsed.data;
    return this.execute({
      actor,
      action,
      listingId,
      auditAgencyId: agencyId,
      expectedVersion: null,
      next: {
        content: prepared.content,
        status,
        agencyId,
        ...(customId !== undefined && { customId }),
      },
      changeType: 'CREATE',
      dropped: prepared.dropped,
      duplicates: 'CREATE',
      createdAt: this.now(),
      flags: [],
      ...(options.idempotency !== undefined && {
        idempotency: options.idempotency(listingId),
      }),
    });
  }

  /**
   * `POST /listings` with `Idempotency-Key` (duplicate-detection Req 9.2–9.6): a repetition of the
   * same request by the same actor within 24 hours answers with the listing it created
   * (`replayed: true`) instead of creating another one; the same key with another body is
   * refused with 409 `IDEMPOTENCY_KEY_REUSED`.
   */
  async createWithKey(
    p: Principal,
    body: unknown,
    key: string,
  ): Promise<Result<CreateOutcome, ApiError[]>> {
    const actor = { principal: p, channel: channelOf(p) };
    const store = this.deps.idempotency;
    if (store === undefined) throw new Error('createWithKey without an idempotency store');
    if (!IdempotencyKey.safeParse(key).success) {
      const error = {
        ...apiError(
          'INVALID_PARAMETER',
          'Idempotency-Key must be 1-128 printable ASCII characters',
        ),
        field: 'Idempotency-Key',
      };
      return this.trail.reject(actor, 'listing.create', 'listing', ownAgency(p), error);
    }
    const actorKey: IdempotencyActorKey =
      p.kind === 'machine' ? `mk:${p.keyId}` : `user:${p.userId}`;
    const keyHash = idempotencyKeyHash(key);
    const requestHash = idempotencyRequestHash(body);

    // A concurrent request with the same key may win between lookup and write: look again once.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const nowSeconds = Math.floor(this.clock() / 1000);
      const existing = await store.get(actorKey, keyHash, nowSeconds);
      if (existing !== null)
        return this.replay(actor, existing.listingId, existing.requestHash === requestHash);
      const record = (listingId: string) => ({
        nowSeconds,
        record: {
          actorKey,
          keyHash,
          listingId,
          requestHash,
          createdAt: new Date(nowSeconds * 1000).toISOString(),
          expiresAt: nowSeconds + IDEMPOTENCY_WINDOW_SECONDS,
        },
      });
      try {
        const created = await this.createInternal(p, body, { idempotency: record });
        return created.ok ? ok({ view: created.value, replayed: false }) : created;
      } catch (error) {
        if (!(error instanceof IdempotencyRace)) throw error;
      }
    }
    const error = apiError(
      'SERVICE_UNAVAILABLE',
      'Concurrent request with the same Idempotency-Key',
    );
    return this.trail.reject(actor, 'listing.create', 'listing', ownAgency(p), error);
  }

  /** Answer of a repeated request: the listing it created, or 409 for another body (Req 9.2, 9.3). */
  private async replay(
    actor: AgencyActor,
    listingId: string,
    sameRequest: boolean,
  ): Promise<Result<CreateOutcome, ApiError[]>> {
    const target = listingTarget(listingId);
    const current = sameRequest ? await this.deps.listings.get(listingId) : null;
    const agencyId = current?.management.agencyId ?? ownAgency(actor.principal);
    if (current === null) {
      // Another body, or the listing was removed meanwhile: the key stays bound to it.
      const error = apiError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key was already used for another request',
      );
      return this.trail.reject(actor, 'listing.create', 'listing', agencyId, {
        ...error,
        field: 'Idempotency-Key',
      });
    }
    await this.trail.success(actor, 'listing.create.replay', target, agencyId);
    return ok({ view: await this.viewFor(actor.principal, current), replayed: true });
  }

  /**
   * `PUT /listings/{id}` (Req 4.5, 4.6, 4.8, 4.9, 4.11, 4.12): replaces the whole content; status
   * and agency stay. `customId`: absent = keep, value = set, `null` = remove. Listings with origin
   * `IMPORT` require `sourceUrl`; `MANUAL` listings without it get the Öffentliche_Detail_URL.
   */
  async replaceContent(
    p: Principal,
    id: string,
    body: unknown,
  ): Promise<Result<ListingView, ApiError[]>> {
    const loaded = await this.load(p, id, 'listing:write', 'listing.update');
    if (!loaded.ok) return loaded;
    const { actor, current } = loaded.value;
    const { management } = current;

    const parsed = ReplaceBody.safeParse(body);
    const prepared = this.prepareRaw(body, id, management.origin);
    if (!parsed.success || !prepared.ok) {
      return this.rejectAll(actor, 'listing.update', listingTarget(id), management.agencyId, [
        ...(parsed.success ? [] : toApiErrors(parsed.error.issues)),
        ...(prepared.ok ? [] : prepared.errors),
      ]);
    }
    const { baseVersion, customId } = parsed.data;
    const nextCustomId = customId === undefined ? management.customId : (customId ?? undefined);
    // Only the Custom_Id changes: the Markierung stays as it is (duplicate-detection Req 6.4).
    const contentChanged = contentHash(prepared.content) !== management.contentHash;
    return this.execute({
      actor,
      action: 'listing.update',
      listingId: id,
      auditAgencyId: management.agencyId,
      expectedVersion: baseVersion,
      next: {
        ...withoutCustomId(currentState(current)),
        content: prepared.content,
        ...(nextCustomId !== undefined && { customId: nextCustomId }),
      },
      changeType: 'UPDATE',
      dropped: prepared.dropped,
      ...existingListing(current, contentChanged ? 'UPDATE' : undefined),
    });
  }

  /**
   * `PUT /listings/{id}/status` (Req 6.2, 6.9): new version with the status, content and history
   * stay; without `baseVersion` the change is based on the current version.
   */
  async setStatus(
    p: Principal,
    id: string,
    body: unknown,
  ): Promise<Result<ListingView, ApiError[]>> {
    const loaded = await this.load(p, id, 'listing:status', 'listing.status');
    if (!loaded.ok) return loaded;
    const { actor, current } = loaded.value;
    const { agencyId, version } = current.management;

    const parsed = SetStatusRequest.safeParse(body);
    if (!parsed.success) {
      return this.rejectAll(
        actor,
        'listing.status',
        listingTarget(id),
        agencyId,
        toApiErrors(parsed.error.issues),
      );
    }
    const flagged = duplicateFlagOf(current.management.flags ?? []) !== undefined;
    if (
      flagged &&
      parsed.data.status === 'ACTIVE' &&
      current.management.status === 'ACTIVE' &&
      (parsed.data.baseVersion ?? version) === version
    ) {
      // Already online (flagged by a change or the Abgleich): the release has no status to
      // change, so it is the Verwerfung — no version (duplicate-detection Req 8.1, 8.2).
      return this.dismissFlag(p, id, 'DUPLICATE');
    }
    return this.execute({
      actor,
      action: 'listing.status',
      listingId: id,
      auditAgencyId: agencyId,
      expectedVersion: parsed.data.baseVersion ?? version,
      next: { ...currentState(current), status: parsed.data.status },
      changeType: 'STATUS',
      dropped: [],
      // Activating a flagged listing releases it (duplicate-detection Req 8.1); every other
      // status change leaves the Markierungen alone (Req 6.4, 8.6).
      ...existingListing(
        current,
        parsed.data.status === 'ACTIVE' && flagged ? 'RELEASE' : undefined,
      ),
    });
  }

  /**
   * `PUT /listings/{id}/agency` (Plattform_Admin, Req 10.6): moves the listing (with its
   * Custom_Id) to an existing agency; version with change type `UPDATE`.
   */
  async assignAgency(
    p: Principal,
    id: string,
    body: unknown,
  ): Promise<Result<ListingView, ApiError[]>> {
    const loaded = await this.load(p, id, 'listing:assign', 'listing.assign');
    if (!loaded.ok) return loaded;
    const { actor, current } = loaded.value;
    const target = listingTarget(id);
    const { agencyId } = current.management;

    const parsed = AssignAgencyRequest.safeParse(body);
    if (!parsed.success) {
      return this.rejectAll(
        actor,
        'listing.assign',
        target,
        agencyId,
        toApiErrors(parsed.error.issues),
      );
    }
    if ((await this.deps.agencies.get(parsed.data.agencyId)) === null) {
      return this.trail.reject(actor, 'listing.assign', target, agencyId, unknownAgency());
    }
    return this.execute({
      actor,
      action: 'listing.assign',
      listingId: id,
      auditAgencyId: parsed.data.agencyId,
      expectedVersion: parsed.data.baseVersion,
      next: { ...currentState(current), agencyId: parsed.data.agencyId },
      changeType: 'UPDATE',
      dropped: [],
      // The new agency is a new Prüfbereich (duplicate-detection Req 6.1).
      ...existingListing(current, 'UPDATE'),
    });
  }

  /**
   * `POST /listings/{id}/restore` (Req 8.1, 8.2, 8.4, 8.5): content of version `version`,
   * re-validated against the current rules; status, Custom_Id and agency stay. Restoring the
   * current content creates no version (`UNCHANGED`).
   */
  async restore(p: Principal, id: string, body: unknown): Promise<Result<ListingView, ApiError[]>> {
    const loaded = await this.load(p, id, 'version:restore', 'listing.restore');
    if (!loaded.ok) return loaded;
    const { actor, current } = loaded.value;
    const target = listingTarget(id);
    const { agencyId, origin } = current.management;

    const parsed = RestoreRequest.safeParse(body);
    if (!parsed.success) {
      return this.rejectAll(
        actor,
        'listing.restore',
        target,
        agencyId,
        toApiErrors(parsed.error.issues),
      );
    }
    const record = await this.deps.versions.get(id, parsed.data.version);
    if (record === null) {
      const error = { ...notFound(), field: 'version' };
      return this.trail.reject(actor, 'listing.restore', target, agencyId, error);
    }
    const snapshot = await this.deps.snapshots.get(id, record.contentHash);
    if (snapshot === null) {
      throw new Error(`Snapshot of version ${record.version} of listing ${id} is missing`);
    }
    const prepared = this.prepare(contentToInput(snapshot), id, origin);
    if (!prepared.ok) {
      return this.rejectAll(actor, 'listing.restore', target, agencyId, prepared.errors);
    }
    return this.execute({
      actor,
      action: 'listing.restore',
      listingId: id,
      auditAgencyId: agencyId,
      expectedVersion: parsed.data.baseVersion,
      next: { ...currentState(current), content: prepared.content },
      changeType: 'RESTORE',
      restoredFrom: record.version,
      dropped: prepared.dropped,
      ...existingListing(current, 'UPDATE'),
    });
  }

  /** Loads the listing (404) and authorizes against its agency (404/403, Req 2.5, 2.6, 10.2). */
  private async load(
    p: Principal,
    id: string,
    permission: Permission,
    action: ListingAuditAction,
  ): Promise<Result<{ actor: AgencyActor; current: ManagedListing }, ApiError[]>> {
    const actor = { principal: p, channel: channelOf(p) };
    const target = listingTarget(id);
    const current = await this.deps.listings.get(id);
    if (current === null) return this.trail.reject(actor, action, target, undefined, notFound());
    const { agencyId } = current.management;
    const denied = decisionError(authorize(p, permission, agencyId ?? null), permission);
    if (denied !== null) return this.trail.reject(actor, action, target, agencyId, denied);
    return ok({ actor, current });
  }

  /** `prepareRaw` for a body whose `content` may be anything (reported by the body schema). */
  private prepareRaw(body: unknown, listingId: string, origin: Origin): PreparedInput {
    const content = (body as { content?: unknown } | null)?.content;
    const isObject = typeof content === 'object' && content !== null && !Array.isArray(content);
    return isObject
      ? this.prepare(content as Candidate, listingId, origin)
      : { ok: true, content: {} as ListingContent, dropped: [] };
  }

  /**
   * Derived source URL for `MANUAL` (Req 4.5), then `prepareContent` with the current rules.
   * `IMPORT` listings keep `sourceUrl` mandatory.
   */
  private prepare(raw: Candidate, listingId: string, origin: Origin): PreparedInput {
    const candidate =
      origin === 'MANUAL' && raw['sourceUrl'] === undefined
        ? { ...raw, sourceUrl: publicDetailUrl(this.deps.frontendOrigin, listingId) }
        : raw;
    const prepared = prepareContent(candidate, this.deps.contentSchema, this.deps.rules);
    const issues: FieldIssue[] = prepared.ok ? [] : [...prepared.issues];
    if (candidate['sourceUrl'] === undefined) {
      issues.push({ field: 'sourceUrl', reason: 'Required for listings with origin IMPORT' });
    }
    if (!prepared.ok || issues.length > 0) return { ok: false, errors: contentErrors(issues) };
    return {
      ok: true,
      content: prepared.content as ListingContent,
      dropped: droppedFieldNames(prepared),
    };
  }

  private async execute(command: Command): Promise<Result<ListingView, ApiError[]>> {
    const { actor, action, listingId, auditAgencyId } = command;
    const target = listingTarget(listingId);
    let result: WriteResult | undefined;
    let decision: DuplicateDecision | undefined;
    // A concurrent Exakt_Duplikat may claim the exact key between assessment and write; the
    // second assessment then sees its owner and writes with a Markierung (Req 9.1).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const decided = await this.decideDuplicates(command);
      if (!decided.ok)
        return this.trail.reject(actor, action, target, auditAgencyId, decided.error);
      decision = decided.value;
      result = await this.deps.writer.write({
        listingId,
        expectedVersion: command.expectedVersion,
        next: decision.next,
        changeType: command.changeType,
        channel: actor.channel,
        actor: actorRef(actor.principal),
        ...(command.restoredFrom !== undefined && { restoredFrom: command.restoredFrom }),
        ...(decision.flags !== undefined && { flags: decision.flags }),
        ...(decision.statusReason !== undefined && { statusReason: decision.statusReason }),
        ...(decision.dismiss.length > 0 && { dismiss: decision.dismiss }),
        ...(decision.assessment !== undefined && { assessment: decision.assessment }),
        ...(command.idempotency !== undefined && { idempotency: command.idempotency }),
        ...(decision.createdAt !== undefined && { createdAt: decision.createdAt }),
        ...(decision.switchedOff === true && { duplicateDetection: 'disabled' as const }),
      });
      if (result.ok || result.error.code !== 'EXACT_CLAIMED') break;
    }
    if (result === undefined || decision === undefined) throw new Error('execute without write');
    if (!result.ok) {
      if (result.error.code === 'IDEMPOTENCY_RACE') throw new IdempotencyRace();
      return this.trail.reject(actor, action, target, auditAgencyId, conflictError(result.error));
    }
    const { outcome, listing } = result.value;
    if (outcome === 'unchanged') {
      await this.trail.outcome(actor, action, target, auditAgencyId, 'UNCHANGED');
    } else {
      await this.trail.success(actor, action, target, auditAgencyId);
      await this.auditFlagChange(actor, target, auditAgencyId, command, decision);
    }
    return ok(await this.viewFor(actor.principal, listing, command.dropped));
  }

  /**
   * Duplikat_Prüfung of a command (duplicate-detection Req 5, 6, 8.1): the Markierung after the
   * write, the status of a new duplicate and the Verwerfungen of a release. 503 if the
   * Duplikat_Index cannot be read (Req 5.8); nothing is written then.
   */
  private async decideDuplicates(command: Command): Promise<Result<DuplicateDecision, ApiError>> {
    const detector = this.deps.duplicates;
    const none: DuplicateDecision = { next: command.next, dismiss: [] };
    if (detector === undefined) return ok(none);
    // Read for every command: switched off, no write maintains the Duplikat_Index either.
    const enabled = await this.detectionEnabled();
    if (enabled === null) return err(duplicateCheckUnavailable());
    if (!enabled) return ok(switchedOffDecision(command));
    if (command.duplicates === undefined) return ok(none);

    const { listingId, next } = command;
    // A new listing is created when it is written: each attempt takes the current time, so a
    // listing that lost the race for its exact key comes after the winner (Req 9.1).
    let createdAt = command.duplicates === 'CREATE' ? this.now() : command.createdAt;
    let assessment: DuplicateAssessment;
    try {
      assessment = await detector.assess({
        listingId,
        scope: agencyScope(next.agencyId),
        createdAt,
        content: next.content,
        derivedSourceUrl: publicDetailUrl(this.deps.frontendOrigin, listingId),
      });
    } catch (error) {
      if (!(error instanceof DuplicateIndexUnavailable)) throw error;
      return err(duplicateCheckUnavailable());
    }
    const current = duplicateFlagOf(command.flags);
    const self = { listingId, createdAt };

    if (command.duplicates === 'RELEASE') {
      // Every current Treffer, also those not named in the Markierung (Req 8.1).
      const dismiss = [
        ...new Set([
          ...assessment.matches.map((match) => match.listingId),
          ...(current?.matches.map((match) => match.listingId) ?? []),
        ]),
      ];
      return ok({ next, flags: withDuplicateFlag(command.flags, null), dismiss, assessment });
    }

    if (command.duplicates === 'CREATE') createdAt = creationTimeAfterCheck(createdAt, assessment);
    const { flags, flag } = flagsAfterCheck(
      command.duplicates,
      { ...self, createdAt },
      assessment,
      command.flags,
      this.now(),
    );
    if (command.duplicates === 'CREATE' && flag !== null) {
      // A new duplicate is stored, but not published: only the Original stays online (Req 5.2).
      return ok({
        next: { ...next, status: 'INACTIVE' },
        flags,
        statusReason: { code: 'DUPLICATE', originalId: flag.originalId },
        dismiss: [],
        assessment,
        createdAt,
      });
    }
    return ok({
      next,
      flags,
      dismiss: [],
      assessment,
      ...(command.duplicates === 'CREATE' && { createdAt }),
    });
  }

  /** Whether the Duplikat-Erkennung runs; `null` if the switch cannot be read. */
  private async detectionEnabled(): Promise<boolean | null> {
    const detection = this.deps.detection;
    if (detection === undefined) return true;
    try {
      return await detection.isEnabled();
    } catch {
      return null;
    }
  }

  /** One audit entry per changed Markierung (Req 7.7): codes and ids only. */
  private async auditFlagChange(
    actor: AgencyActor,
    target: string,
    agencyId: string | undefined,
    command: Command,
    decision: DuplicateDecision,
  ): Promise<void> {
    if (decision.flags === undefined) return;
    const before = duplicateFlagOf(command.flags);
    const after = duplicateFlagOf(decision.flags);
    if (
      before === after ||
      (before !== undefined && after !== undefined && sameFlag(before, after))
    ) {
      return;
    }
    const flag = after ?? before;
    if (flag === undefined) return;
    const action: ListingAuditAction =
      after === undefined
        ? command.duplicates === 'RELEASE'
          ? 'listing.flag.dismiss'
          : 'listing.flag.remove'
        : before === undefined
          ? 'listing.flag.set'
          : 'listing.flag.update';
    await this.trail.flagChange(actor, action, target, agencyId, flagDetails(flag));
  }

  /**
   * `DELETE /listings/{id}/flags/{code}` (duplicate-detection Req 8.2, 8.4): removes the
   * Markierung without a version and records Verwerfungen against every current Treffer; the
   * status stays. Without such a Markierung the call succeeds without a change.
   */
  async dismissFlag(
    p: Principal,
    id: string,
    code: string,
  ): Promise<Result<ListingView, ApiError[]>> {
    const loaded = await this.load(p, id, 'listing:status', 'listing.flag.dismiss');
    if (!loaded.ok) return loaded;
    const { actor, current } = loaded.value;
    const target = listingTarget(id);
    const { agencyId } = current.management;
    if (code !== 'DUPLICATE') {
      const error = { ...apiError('INVALID_PARAMETER', 'Unknown flag code'), field: 'code' };
      return this.trail.reject(actor, 'listing.flag.dismiss', target, agencyId, error);
    }
    const flags = current.management.flags ?? [];
    const flag = duplicateFlagOf(flags);
    if (flag === undefined) {
      await this.trail.outcome(actor, 'listing.flag.dismiss', target, agencyId, 'UNCHANGED');
      return ok(await this.viewFor(actor.principal, current));
    }

    const decided = await this.decideDuplicates({
      actor,
      action: 'listing.flag.dismiss',
      listingId: id,
      auditAgencyId: agencyId,
      expectedVersion: current.management.version,
      next: currentState(current),
      changeType: 'STATUS',
      dropped: [],
      ...existingListing(current, 'RELEASE'),
    });
    if (!decided.ok) {
      return this.trail.reject(actor, 'listing.flag.dismiss', target, agencyId, decided.error);
    }
    const writer = this.deps.writer;
    if (writer.setFlags === undefined)
      throw new Error('dismissFlag without VersionedListingWriter.setFlags');
    const result = await writer.setFlags({
      listingId: id,
      expectedVersion: current.management.version,
      flags: decided.value.flags ?? [],
      dismiss: decided.value.dismiss,
    });
    if (!result.ok) {
      return this.trail.reject(
        actor,
        'listing.flag.dismiss',
        target,
        agencyId,
        conflictError(result.error),
      );
    }
    await this.trail.flagChange(actor, 'listing.flag.dismiss', target, agencyId, flagDetails(flag));
    return ok(await this.viewFor(actor.principal, result.value));
  }

  /** The answer's `ListingView`, without ids of other agencies in its Markierung (Req 7.6). */
  private viewFor(
    principal: Principal,
    listing: ManagedListing,
    dropped: readonly string[] = [],
  ): Promise<ListingView> {
    return scopeListingView(
      toListingView(listing, this.deps.frontendOrigin, dropped),
      principal,
      this.deps.listings,
    );
  }

  /** Audits the first error code and returns all errors. */
  private async rejectAll(
    actor: AgencyActor,
    action: ListingAuditAction,
    target: string,
    agencyId: string | undefined,
    errors: ApiError[],
  ): Promise<Result<ListingView, ApiError[]>> {
    const [first] = errors;
    if (first === undefined) throw new Error('rejectAll without errors');
    await this.trail.reject(actor, action, target, agencyId, first);
    return err(errors);
  }
}

/** What the Duplikat_Prüfung of a command changes in the write (duplicate-detection Req 5–8). */
interface DuplicateDecision {
  /** State to write; a new duplicate gets `INACTIVE` (Req 5.2). */
  next: VersionedState;
  /** Markierungen after the write; `undefined` = unchanged. */
  flags?: ListingFlag[];
  statusReason?: { code: 'DUPLICATE'; originalId: string };
  /** Verwerfungen recorded by a release (Req 8.1). */
  dismiss: string[];
  assessment?: DuplicateAssessment;
  /** Anlagezeitpunkt of a new listing as decided; stored as is (Req 4.3, 9.1). */
  createdAt?: string;
  /** The Duplikat-Erkennung is switched off: no check, no Duplikat_Index maintenance. */
  switchedOff?: true;
}

const duplicateCheckUnavailable = (): ApiError =>
  apiError('SERVICE_UNAVAILABLE', 'Duplicate check unavailable, retry later');

/**
 * Decision with the Duplikat-Erkennung switched off: the requested state as is and the
 * Markierungen unchanged — except a release, which still removes the Markierung and records
 * Verwerfungen against the Treffer it names (there is no index query to find others).
 */
function switchedOffDecision(command: Command): DuplicateDecision {
  const decision: DuplicateDecision = { next: command.next, dismiss: [], switchedOff: true };
  if (command.duplicates !== 'RELEASE') return decision;
  const flag = duplicateFlagOf(command.flags);
  return {
    ...decision,
    flags: withDuplicateFlag(command.flags, null),
    dismiss: flag?.matches.map((match) => match.listingId) ?? [],
  };
}

/** A concurrent request stored the same Idempotenzschlüssel first; the caller looks again. */
class IdempotencyRace extends Error {
  constructor() {
    super('Concurrent request with the same Idempotency-Key');
    this.name = 'IdempotencyRace';
  }
}

/** Command fields of an existing listing: Anlagezeitpunkt, flags and the kind of check. */
function existingListing(
  current: ManagedListing,
  duplicates: Command['duplicates'],
): Pick<Command, 'createdAt' | 'flags' | 'duplicates'> {
  return {
    createdAt: creationTime(current),
    flags: current.management.flags ?? [],
    ...(duplicates !== undefined && { duplicates }),
  };
}

/** Versioned state of the stored listing (content without id and provenance). */
function currentState({ listing, management }: ManagedListing): VersionedState {
  return {
    content: listing,
    status: management.status,
    ...(management.customId !== undefined && { customId: management.customId }),
    ...(management.agencyId !== undefined && { agencyId: management.agencyId }),
  };
}

function withoutCustomId(state: VersionedState): VersionedState {
  const copy = { ...state };
  delete copy.customId;
  return copy;
}

const unknownAgency = (): ApiError => ({ ...notFound(), field: 'agencyId' });

/** Writer conflicts as catalog errors (Req 4.8, 4.9, 4.12, 8.5). */
function conflictError(conflict: WriteConflict): ApiError {
  switch (conflict.code) {
    case 'VERSION_CONFLICT':
      return {
        ...apiError('VERSION_CONFLICT', 'baseVersion is not the current version'),
        field: 'baseVersion',
        details: { currentVersion: conflict.currentVersion },
      };
    case 'NOT_FOUND':
      return notFound();
    case 'DELETION_BLOCKED':
      return {
        ...apiError('DELETION_BLOCKED', DELETION_BLOCK_REASON),
        details: { reason: DELETION_BLOCK_REASON },
      };
    case 'CUSTOM_ID_TAKEN':
      return {
        ...apiError('CUSTOM_ID_TAKEN', 'Custom_Id is assigned to another listing of the agency'),
        field: 'customId',
      };
    // Both are resolved by a repetition inside the service; they only surface after it.
    case 'EXACT_CLAIMED':
    case 'IDEMPOTENCY_RACE':
      return apiError('SERVICE_UNAVAILABLE', 'Concurrent change, retry the request');
  }
}
