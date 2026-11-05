import { randomUUID } from 'node:crypto';
import {
  AssignAgencyRequest,
  authorize,
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
  type ApiError,
  type ChangeType,
  type Channel,
  type ListingContent,
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
import { prepareContent, type ContentRules, type FieldIssue } from '../content/prepare-content';
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
import { contentToInput, toListingView } from './listing-view';
import type { SnapshotStore } from './snapshot-store';
import type { VersionedListingWriter, WriteConflict } from './versioned-listing-writer';

// Listing commands of the Management_API (design: "ListingCommandService und
// VersionedListingWriter", Req 4, 6.2, 6.6, 8, 10.2, 10.5, 10.6).

export type ListingAuditAction =
  'listing.create' | 'listing.update' | 'listing.status' | 'listing.assign' | 'listing.restore';

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
  writer: Pick<VersionedListingWriter<unknown>, 'write'>;
  audit: AgencyAudit;
  /** Frontend origin (SSM `/open-estate/{env}/frontend-origin`) for the Öffentliche_Detail_URL. */
  frontendOrigin: string;
  /** `manualContentSchema(taxonomy)` of the currently loaded taxonomy. */
  contentSchema: ManualContentSchema;
  /** PII allow-list and tour allow-list (`contentRules`), as used by the import. */
  rules: ContentRules;
  /** Identifier of new listings; default `randomUUID`. */
  newId?: () => string;
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
 * Names of the fields dropped by the import rules (Req 4.10): PII paths, dropped media and tours
 * by their delivered position (`media.3`), and a truncated list by its field (`media`).
 */
function droppedFieldNames(prepared: ReturnType<typeof prepareContent>): string[] {
  return [
    ...prepared.droppedPii,
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

  constructor(deps: ListingCommandServiceDeps) {
    this.deps = deps;
    this.trail = new AgencyAuditTrail<ListingAuditAction>(deps.audit);
    this.newId = deps.newId ?? randomUUID;
  }

  /**
   * `POST /listings` (Req 4.1, 4.2, 4.5, 4.11): platform-assigned id, origin `MANUAL`, version 1,
   * status default `INACTIVE`. Agency actors create in their own agency; a Plattform_Admin names
   * an existing agency (`agencyId`, required).
   */
  async create(p: Principal, body: unknown): Promise<Result<ListingView, ApiError[]>> {
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
    });
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
    return this.execute({
      actor,
      action: 'listing.status',
      listingId: id,
      auditAgencyId: agencyId,
      expectedVersion: parsed.data.baseVersion ?? version,
      next: { ...currentState(current), status: parsed.data.status },
      changeType: 'STATUS',
      dropped: [],
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
    const result = await this.deps.writer.write({
      listingId,
      expectedVersion: command.expectedVersion,
      next: command.next,
      changeType: command.changeType,
      channel: actor.channel,
      actor: actorRef(actor.principal),
      ...(command.restoredFrom !== undefined && { restoredFrom: command.restoredFrom }),
    });
    if (!result.ok) {
      return this.trail.reject(actor, action, target, auditAgencyId, conflictError(result.error));
    }
    const { outcome, listing } = result.value;
    if (outcome === 'unchanged') {
      await this.trail.outcome(actor, action, target, auditAgencyId, 'UNCHANGED');
    } else {
      await this.trail.success(actor, action, target, auditAgencyId);
    }
    return ok(toListingView(listing, this.deps.frontendOrigin, command.dropped));
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
  }
}
