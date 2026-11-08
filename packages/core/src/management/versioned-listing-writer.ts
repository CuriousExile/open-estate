import { isDeepStrictEqual } from 'node:util';
import {
  blockKeys,
  changedContentPaths,
  CONTENT_FIELDS,
  contentHash,
  contentPaths,
  deriveProvenance,
  err,
  ok,
  publicDetailUrl,
  type ActorRef,
  type ChangeType,
  type Channel,
  type FieldSource,
  type FieldSources,
  type Listing,
  type ListingContent,
  type ListingFlag,
  type Origin,
  type Result,
  type StatusReason,
  type VersionedState,
} from '@open-estate/shared';
import type { Clock } from '../access/ttl-cache';
import {
  customIdBlocklistKey,
  type DeletionBlocklistCheck,
} from '../deletion/deletion-blocklist-check';
import type { DuplicateAssessment, DuplicateDetector } from '../duplicates/duplicate-detector';
import type { DuplicateIndexStore, StoredProfile } from '../duplicates/duplicate-index-store';
import type { IdempotencyRecord, IdempotencyStore } from '../duplicates/idempotency-store';
import {
  creationTime,
  toManagedListingItem,
  type ListingManagement,
} from '../search/listings-table';
import type { ListingKeyStore } from './listing-key-store';
import type { ManagedListing, ManagedListingStore } from './listing-store';
import type {
  ListingVersionRecord,
  ListingVersionStore,
  VersionChangedPath,
} from './listing-version-store';
import {
  agencyScope,
  NO_AGENCY_SCOPE_ID,
  type MetricCounterIncrement,
  type MetricCounterStore,
} from './metric-counter-store';
import type { SnapshotStore } from './snapshot-store';
import type { Transactor } from './transaction';

// Shared write path of Management_API, admin agency assignment and import (design:
// "ListingCommandService und VersionedListingWriter"): every change of content, status, Custom_Id
// or owning agency becomes exactly one version, written atomically with the listing, the
// Custom_Id key, the deletion blocklist checks and the inventory/history counters (Req 7.1).

/** One requested change; `next` is the complete versioned state after it. */
export interface StateChange {
  listingId: string;
  /** Version the change is based on; `null` = new listing (Req 4.8). */
  expectedVersion: number | null;
  /** Content in the internal representation, already prepared and validated. */
  next: VersionedState;
  changeType: ChangeType;
  channel: Channel;
  /** For `IMPORT` a connector; its `runId` becomes `lastRunId` (Req 4.16). */
  actor: ActorRef;
  restoredFrom?: number;
  /** Markierungen after the change; `undefined` keeps the stored ones (duplicate-detection Req 7). */
  flags?: ListingFlag[];
  /** Why the stored status differs from the requested one; version 1 only (Req 5.4). */
  statusReason?: StatusReason;
  /** Listings to record Verwerfungen against, added to the stored ones (Req 8.1, 8.2). */
  dismiss?: readonly string[];
  /**
   * Duplikat_Prüfung of `next.content`: its profile is stored as is, and the exact key is claimed
   * when the assessment found no owner (Req 9.1). Without it the profile is computed here and a
   * held claim is kept only if the exact key did not change.
   */
  assessment?: Pick<DuplicateAssessment, 'profile' | 'exactOwner'>;
  /** Idempotenzschlüssel record of the creating request, stored atomically (Req 9.2). */
  idempotency?: { record: IdempotencyRecord; nowSeconds: number };
  /**
   * `disabled`: the Duplikat-Erkennung is switched off (design: "Ein- und Ausschalten"). The
   * Duplikat_Index is not maintained — the next Duplikat_Abgleich after switching it on again
   * rebuilds it — except that `dismiss` is still recorded on a stored profile, so a release stays
   * a release. Default: maintained.
   */
  duplicateDetection?: 'disabled';
  /**
   * Anlagezeitpunkt of a new listing, when the Duplikat_Prüfung decided with it: the stored value
   * must be the one the decision used, or two concurrent creations could each see the other as
   * younger (Req 4.3, 9.1). Ignored for existing listings; default: the time of the write.
   */
  createdAt?: string;
}

/** `unchanged`: hash, status, Custom_Id and agency equal the current state; no version. */
export type WriteOutcome = 'created' | 'updated' | 'unchanged';

export interface WriteSuccess {
  outcome: WriteOutcome;
  /** Stored listing after the write. */
  listing: ManagedListing;
}

export type WriteConflict =
  /** Stale `expectedVersion` or a concurrent write (Req 4.8). */
  | { code: 'VERSION_CONFLICT'; currentVersion: number }
  /** `expectedVersion` set, but the listing does not exist (anymore). */
  | { code: 'NOT_FOUND' }
  /** Id or Custom_Id is on the deletion blocklist (Req 4.9). */
  | { code: 'DELETION_BLOCKED' }
  /** Custom_Id belongs to another listing of the agency (Req 4.12). */
  | { code: 'CUSTOM_ID_TAKEN' }
  /**
   * A concurrent write claimed the exact key first: the listing is an Exakt_Duplikat of `owner`
   * (duplicate-detection Req 9.1). The caller assesses again and writes with a Markierung.
   */
  | { code: 'EXACT_CLAIMED'; owner: string | null }
  /** A concurrent request stored the same Idempotenzschlüssel first (Req 9.2). */
  | { code: 'IDEMPOTENCY_RACE' };

export type WriteResult = Result<WriteSuccess, WriteConflict>;

/** Counter codes written by the writer (design: "Monitoring und Kennzahlenkatalog"). */
export const LISTING_COUNTER_CODES = {
  status: (status: string) => `listing.status.${status}`,
  changes: (channel: Channel) => `listing.changes.${channel}`,
  versionCount: 'history.version_count',
  storageBytes: 'history.storage_bytes',
  /** Listings with a Duplikat_Markierung per agency (duplicate-detection Req 14.5). */
  duplicateFlags: 'listing.flags.DUPLICATE',
} as const;

export interface VersionedListingWriterDeps<Op> {
  listings: ManagedListingStore<Op>;
  versions: ListingVersionStore<Op>;
  keys: ListingKeyStore<Op>;
  blocklist: DeletionBlocklistCheck<Op>;
  counters: MetricCounterStore<Op>;
  snapshots: SnapshotStore;
  transactor: Transactor<Op>;
  clock: Clock;
  /**
   * Duplikat_Index maintenance (duplicate-detection design: "VersionedListingWriter-Erweiterung").
   * Every production wiring sets it, so each version keeps the index in step with the listing.
   */
  duplicates?: WriterDuplicates<Op>;
  /** Idempotenzschlüssel of creations (Req 9.2); required once a change carries a record. */
  idempotency?: Pick<IdempotencyStore<Op>, 'putOp'>;
}

export interface WriterDuplicates<Op> {
  index: Pick<
    DuplicateIndexStore<Op>,
    'getProfile' | 'exactOwner' | 'syncOps' | 'claimExactOp' | 'releaseExactOp'
  >;
  /** Profiles and block keys under the same rules as the Duplikat_Prüfung. */
  detector: Pick<DuplicateDetector, 'profileOf' | 'config'>;
  /** Frontend origin of the Öffentliche_Detail_URL, so a derived source URL is not compared. */
  frontendOrigin?: string;
}

/** Change of the Markierungen only (Verwerfung, Duplikat_Abgleich): no version (Req 7.3). */
export interface FlagChange {
  listingId: string;
  /** The flags are only replaced while the listing still has this version (Req 10.5). */
  expectedVersion: number;
  /**
   * Markierungen the caller decided on; the change only applies while they are still stored, so
   * a concurrent Verwerfung or Abgleich is not undone. Default: those read by `setFlags`.
   */
  expectedFlags?: readonly ListingFlag[];
  flags: ListingFlag[];
  /** Listings to record Verwerfungen against (Req 8.2). */
  dismiss?: readonly string[];
}

/** Attempts of a write whose only failed condition was a concurrent change of the stored profile. */
const PROFILE_RACE_ATTEMPTS = 3;

/** Owner part of Custom_Id keys; listings without agency share the `_none` namespace. */
const keyOwner = (agencyId: string | undefined) => agencyId ?? NO_AGENCY_SCOPE_ID;

/** Restricts to the content fields and drops absent ones (as `contentHash` does). */
function toContent(source: ListingContent | Listing): ListingContent {
  const record = source as Record<string, unknown>;
  return Object.fromEntries(
    CONTENT_FIELDS.flatMap((field) =>
      record[field] === undefined ? [] : [[field, record[field]]],
    ),
  ) as ListingContent;
}

/** `deriveProvenance` with the connector run of an import actor as `lastRunId` (Req 4.16, 4.17). */
function provenanceOf(
  origin: Origin,
  source: string,
  agencyId: string | undefined,
  write: { channel: Channel; version: number; at: string },
  actor: ActorRef,
) {
  return deriveProvenance(
    { origin, source, ...(agencyId !== undefined && { agencyId }) },
    { ...write, ...(actor.kind === 'connector' && { runId: actor.runId }) },
  );
}

export class VersionedListingWriter<Op> {
  private readonly deps: VersionedListingWriterDeps<Op>;

  constructor(deps: VersionedListingWriterDeps<Op>) {
    this.deps = deps;
  }

  async write(change: StateChange): Promise<WriteResult> {
    for (let attempt = 1; ; attempt += 1) {
      const result = await this.writeOnce(change);
      // Only the Duplikat_Index profile changed meanwhile (Duplikat_Abgleich): the listing did
      // not, so the same change is written again on the fresh profile.
      if (result !== PROFILE_RACE) return result;
      if (attempt >= PROFILE_RACE_ATTEMPTS)
        return err(await this.versionConflict(change.listingId));
    }
  }

  private async writeOnce(change: StateChange): Promise<WriteResult | typeof PROFILE_RACE> {
    const current = await this.deps.listings.get(change.listingId);
    if (current === null && change.expectedVersion !== null) return err({ code: 'NOT_FOUND' });
    if (current !== null && change.expectedVersion !== current.management.version) {
      return err({ code: 'VERSION_CONFLICT', currentVersion: current.management.version });
    }

    const at = new Date(this.deps.clock()).toISOString();
    const content = toContent(change.next.content);
    const hash = contentHash(content);
    if (current !== null && isUnchanged(current.management, hash, change.next)) {
      return this.unchanged(current, change, at);
    }
    return this.writeVersion(current, change, content, hash, at);
  }

  /** No version (Req 4.7, 6.9, 7.3); an import run only refreshes the provenance (Req 4.16). */
  private async unchanged(
    current: ManagedListing,
    change: StateChange,
    at: string,
  ): Promise<WriteResult> {
    if (change.channel !== 'IMPORT') return ok({ outcome: 'unchanged', listing: current });
    const { version, origin, agencyId } = current.management;
    const { lastImportedAt, lastRunId } = provenanceOf(
      origin,
      current.listing.source,
      agencyId,
      { channel: change.channel, version, at },
      change.actor,
    );
    const touch = { lastImportedAt, lastRunId };
    const result = await this.deps.transactor.transact([
      this.deps.listings.touchProvenanceOp(change.listingId, version, touch),
    ]);
    if (!result.ok) return err(await this.versionConflict(change.listingId));
    return ok({
      outcome: 'unchanged',
      listing: { listing: { ...current.listing, ...touch }, management: current.management },
    });
  }

  private async writeVersion(
    current: ManagedListing | null,
    change: StateChange,
    content: ListingContent,
    hash: string,
    at: string,
  ): Promise<WriteResult | typeof PROFILE_RACE> {
    const { listingId, next, channel, actor } = change;
    const version = (current?.management.version ?? 0) + 1;
    const origin: Origin =
      current?.management.origin ?? (channel === 'IMPORT' ? 'IMPORT' : 'MANUAL');
    const source = current?.listing.source ?? initialSource(change);

    const { fieldSources, changedPaths } = nextFieldSources(current, content, {
      channel,
      actor,
      version,
    });
    const provenance = provenanceOf(origin, source, next.agencyId, { channel, version, at }, actor);
    const listing = { ...content, id: listingId, ...provenance } as Listing;
    // Anlagezeitpunkt: set with version 1 and kept afterwards (duplicate-detection Req 4.3).
    const createdAt = current === null ? (change.createdAt ?? at) : creationTime(current);
    const flags = change.flags ?? current?.management.flags ?? [];
    const management: ListingManagement = {
      status: next.status,
      origin,
      version,
      contentHash: hash,
      fieldSources,
      updatedAt: at,
      createdAt,
      ...(next.agencyId !== undefined && { agencyId: next.agencyId }),
      ...(next.customId !== undefined && { customId: next.customId }),
      ...(flags.length > 0 && { flags }),
    };

    // Before the transaction: a failed transaction leaves at most an unreferenced snapshot under
    // the listing's prefix, which is removed with the listing (design, step 3).
    const snapshot = await this.deps.snapshots.put(listingId, hash, content);
    const record: ListingVersionRecord = {
      listingId,
      version,
      changeType: change.changeType,
      channel,
      actor,
      createdAt: at,
      status: next.status,
      contentHash: hash,
      snapshotBytes: snapshot.bytes,
      newSnapshot: snapshot.created,
      changedPaths,
      ...(next.customId !== undefined && { customId: next.customId }),
      ...(next.agencyId !== undefined && { agencyId: next.agencyId }),
      ...(change.restoredFrom !== undefined && { restoredFrom: change.restoredFrom }),
      ...(change.statusReason !== undefined && { statusReason: change.statusReason }),
    };

    const duplicate = await this.duplicateIndexOps(change, content, version, createdAt);
    const ops: Op[] = [
      this.deps.listings.putOp(
        toManagedListingItem(listing, management),
        change.expectedVersion,
        // Markierungen change without a version; the flags counter delta below is based on these.
        current === null ? undefined : (current.management.flags ?? []),
      ),
      this.deps.versions.putOp(record),
      this.deps.blocklist.notBlockedOp(listingId),
      ...this.customIdOps(current, change),
      ...duplicate.ops,
      ...this.idempotencyOps(change),
      ...counterIncrements(current, change, flags, snapshot, at).map((i) =>
        this.deps.counters.addOp(i),
      ),
    ];
    const result = await this.deps.transactor.transact(ops);
    if (!result.ok) {
      const { failed } = result.error;
      if (failed.length > 0 && failed.every((label) => label === PROFILE_LABEL)) {
        return PROFILE_RACE;
      }
      return err(await this.conflict(change, duplicate.after, failed));
    }
    return ok({
      outcome: current === null ? 'created' : 'updated',
      listing: { listing, management },
    });
  }

  /** Blocklist check of the new Custom_Id; key assignment/release if agency or Custom_Id changed. */
  private customIdOps(current: ManagedListing | null, { listingId, next }: StateChange): Op[] {
    const ops: Op[] = [];
    const after =
      next.customId === undefined
        ? undefined
        : { owner: keyOwner(next.agencyId), id: next.customId };
    const previousId = current?.management.customId;
    const before =
      previousId === undefined
        ? undefined
        : { owner: keyOwner(current?.management.agencyId), id: previousId };
    if (after !== undefined) {
      ops.push(this.deps.blocklist.notBlockedOp(customIdBlocklistKey(after.owner, after.id)));
    }
    if (after?.owner === before?.owner && after?.id === before?.id) return ops;
    if (after !== undefined) ops.push(this.deps.keys.assignOp(after.owner, after.id, listingId));
    if (before !== undefined)
      ops.push(this.deps.keys.releaseOp(before.owner, before.id, listingId));
    return ops;
  }

  /**
   * Maps failed operation labels (from `CancellationReasons`) to a conflict. A blocklist hit is
   * final and wins; a failed listing/version condition means a concurrent write.
   */
  private async conflict(
    { listingId }: StateChange,
    duplicate: StoredProfile | null,
    failed: readonly string[],
  ): Promise<WriteConflict> {
    if (failed.includes('deletionBlocklist.check')) return { code: 'DELETION_BLOCKED' };
    if (
      failed.includes('listing.put') ||
      failed.includes('listingVersion.put') ||
      failed.includes(PROFILE_LABEL)
    ) {
      return this.versionConflict(listingId);
    }
    if (failed.includes('listingKey.assign')) return { code: 'CUSTOM_ID_TAKEN' };
    if (failed.includes('idempotency.put')) return { code: 'IDEMPOTENCY_RACE' };
    if (failed.includes('duplicateIndex.exactClaim') && duplicate !== null) {
      const owner = await this.deps.duplicates?.index.exactOwner(
        duplicate.scope,
        duplicate.profile.exactKey,
      );
      return { code: 'EXACT_CLAIMED', owner: owner ?? null };
    }
    // Only the release of the previous Custom_Id failed: the stored key does not point to this
    // listing although the listing carries the Custom_Id — an invariant violation, not a conflict.
    throw new Error(`Inconsistent Custom_Id key of listing ${listingId}: ${failed.join(', ')}`);
  }

  /**
   * Duplikat_Index operations of one version (duplicate-detection design: "VersionedListingWriter-
   * Erweiterung"): the stored profile follows the listing (content, Prüfbereich, version), the
   * block items move with it, Verwerfungen are added, and the exact key is claimed when the
   * assessment saw no owner, kept while the key stays, and released when it changes.
   */
  private async duplicateIndexOps(
    change: StateChange,
    content: ListingContent,
    version: number,
    createdAt: string,
  ): Promise<{ ops: Op[]; after: StoredProfile | null }> {
    const duplicates = this.deps.duplicates;
    if (duplicates === undefined) return { ops: [], after: null };
    if (change.duplicateDetection === 'disabled') {
      return { ops: await this.dismissalOps(duplicates, change), after: null };
    }
    const { index, detector, frontendOrigin } = duplicates;
    const { listingId, next } = change;
    const before = await index.getProfile(listingId);
    const derived =
      frontendOrigin === undefined ? undefined : publicDetailUrl(frontendOrigin, listingId);
    const profile = change.assessment?.profile ?? detector.profileOf(content, derived);
    const scope = agencyScope(next.agencyId);

    const sameKey =
      before !== null && before.scope === scope && before.profile.exactKey === profile.exactKey;
    const keep = sameKey && before.exactClaimed === true;
    const owner = change.assessment?.exactOwner;
    const claim = keep || (owner !== undefined && (owner === null || owner === listingId));
    const dismissed = [...new Set([...(before?.dismissed ?? []), ...(change.dismiss ?? [])])];
    const after: StoredProfile = {
      listingId,
      scope,
      createdAt,
      listingVersion: version,
      profile,
      blockKeys: blockKeys(profile, detector.config),
      dismissed,
      ...(claim && { exactClaimed: true }),
    };

    // Guarded by `before`: a concurrent change of the profile (Verwerfung, Abgleich) fails the
    // transaction instead of being overwritten.
    const ops = index.syncOps(before, after, { guard: true });
    if (before?.exactClaimed === true && !keep) {
      ops.push(index.releaseExactOp(before.scope, before.profile.exactKey, listingId));
    }
    if (claim && !keep) ops.push(index.claimExactOp(scope, profile.exactKey, listingId));
    return { ops, after };
  }

  /**
   * With the Duplikat-Erkennung switched off: only the Verwerfungen of a release, on the stored
   * profile (guarded like every profile change). Without a stored profile there is nothing to
   * record them on; the released listing carries no Markierung any more either way.
   */
  private async dismissalOps(duplicates: WriterDuplicates<Op>, change: StateChange): Promise<Op[]> {
    if ((change.dismiss?.length ?? 0) === 0) return [];
    const before = await duplicates.index.getProfile(change.listingId);
    if (before === null) return [];
    const dismissed = [...new Set([...before.dismissed, ...(change.dismiss ?? [])])];
    if (dismissed.length === before.dismissed.length) return [];
    return duplicates.index.syncOps(before, { ...before, dismissed }, { guard: true });
  }

  /** Idempotenzschlüssel of the creating request, in the same transaction (Req 9.2). */
  private idempotencyOps(change: StateChange): Op[] {
    if (change.idempotency === undefined) return [];
    const store = this.deps.idempotency;
    if (store === undefined) throw new Error('Idempotency record without an idempotency store');
    return [store.putOp(change.idempotency.record, change.idempotency.nowSeconds)];
  }

  /**
   * Replaces the Markierungen of a listing without a version (duplicate-detection Req 7.3): the
   * Verwerfung (Req 8.2) and the Duplikat_Abgleich (Req 10.3). Only applied while the listing has
   * `expectedVersion`, so a concurrent change wins (Req 10.5).
   */
  async setFlags(change: FlagChange): Promise<Result<ManagedListing, WriteConflict>> {
    const { listings, counters, transactor, duplicates } = this.deps;
    return setListingFlags(
      {
        listings,
        counters,
        transactor,
        ...(duplicates !== undefined && { index: duplicates.index }),
      },
      change,
    );
  }

  private async versionConflict(listingId: string): Promise<WriteConflict> {
    const latest = await this.deps.listings.get(listingId);
    return latest === null
      ? { code: 'NOT_FOUND' }
      : { code: 'VERSION_CONFLICT', currentVersion: latest.management.version };
  }
}

/** Stores {@link setListingFlags} writes through. */
export interface FlagWriteDeps<Op> {
  listings: Pick<ManagedListingStore<Op>, 'get' | 'setFlagsOp'>;
  counters: Pick<MetricCounterStore<Op>, 'addOp'>;
  transactor: Transactor<Op>;
  /** Records the Verwerfungen of `change.dismiss`; required when a change carries some. */
  index?: Pick<DuplicateIndexStore<Op>, 'getProfile' | 'syncOps'>;
}

/**
 * Replaces the Markierungen of a listing without a version (duplicate-detection Req 7.3): the
 * Verwerfung (Req 8.2) and the Duplikat_Abgleich (Req 10.3). Only applied while the listing has
 * `expectedVersion` and the Markierungen the caller decided on, so a concurrent change wins
 * (Req 10.5); `listing.flags.DUPLICATE` follows in the same transaction (Req 14.5).
 */
export async function setListingFlags<Op>(
  deps: FlagWriteDeps<Op>,
  change: FlagChange,
): Promise<Result<ManagedListing, WriteConflict>> {
  const { listingId, expectedVersion, flags } = change;
  const conflict = async (): Promise<WriteConflict> => {
    const latest = await deps.listings.get(listingId);
    return latest === null
      ? { code: 'NOT_FOUND' }
      : { code: 'VERSION_CONFLICT', currentVersion: latest.management.version };
  };
  const current = await deps.listings.get(listingId);
  if (current === null) return err({ code: 'NOT_FOUND' });
  const stored = current.management.flags ?? [];
  if (
    current.management.version !== expectedVersion ||
    (change.expectedFlags !== undefined && !sameFlags(stored, change.expectedFlags))
  ) {
    return err({ code: 'VERSION_CONFLICT', currentVersion: current.management.version });
  }
  const ops: Op[] = [deps.listings.setFlagsOp(listingId, expectedVersion, flags, stored)];
  if ((change.dismiss?.length ?? 0) > 0) {
    if (deps.index === undefined) throw new Error('Verwerfungen without a Duplikat_Index');
    const before = await deps.index.getProfile(listingId);
    if (before !== null) {
      const dismissed = [...new Set([...before.dismissed, ...(change.dismiss ?? [])])];
      ops.push(...deps.index.syncOps(before, { ...before, dismissed }, { guard: true }));
    }
  }
  const scope = agencyScope(current.management.agencyId);
  const delta = flagDelta(stored, flags);
  if (delta !== 0) {
    ops.push(deps.counters.addOp({ scope, code: LISTING_COUNTER_CODES.duplicateFlags, delta }));
  }
  const result = await deps.transactor.transact(ops);
  if (!result.ok) return err(await conflict());
  const management: ListingManagement = { ...current.management, flags };
  if (flags.length === 0) delete management.flags;
  return ok({ listing: current.listing, management });
}

/** Result of an attempt whose only failed condition was the guarded Duplikat_Index profile. */
const PROFILE_RACE = Symbol('profile race');
const PROFILE_LABEL = 'duplicateIndex.profile';

const sameFlags = (a: readonly ListingFlag[], b: readonly ListingFlag[]): boolean =>
  isDeepStrictEqual(a, b);

function isUnchanged(current: ListingManagement, hash: string, next: VersionedState): boolean {
  return (
    current.contentHash === hash &&
    current.status === next.status &&
    current.customId === next.customId &&
    current.agencyId === next.agencyId
  );
}

/** `source` of a new listing: the connector for imports; derived from the agency for `MANUAL`. */
function initialSource({ channel, actor }: StateChange): string {
  if (channel !== 'IMPORT') return '';
  if (actor.kind !== 'connector') throw new Error('IMPORT change without connector actor');
  return actor.connectorId;
}

/**
 * Feldherkunft after the change (Req 7.2, 12.11): removed paths are dropped, changed and added
 * paths get the new version's source. Each changed path records its previous source; a path last
 * changed by another channel and now changed by an import is "durch Listenimport überschrieben".
 */
function nextFieldSources(
  current: ManagedListing | null,
  content: ListingContent,
  source: FieldSource,
): { fieldSources: FieldSources; changedPaths: VersionChangedPath[] } {
  const previous = current?.management.fieldSources ?? {};
  const present = new Set(contentPaths(content));
  const changed = changedContentPaths(
    current === null ? undefined : toContent(current.listing),
    content,
  );
  const fieldSources: FieldSources = {};
  for (const [path, value] of Object.entries(previous)) {
    if (present.has(path)) fieldSources[path] = value;
  }
  for (const path of changed) if (present.has(path)) fieldSources[path] = source;
  const changedPaths = changed.map((path): VersionChangedPath => {
    const before = previous[path];
    return {
      path,
      ...(before !== undefined && { previous: before }),
      overwrittenByImport:
        source.channel === 'IMPORT' && before !== undefined && before.channel !== 'IMPORT',
    };
  });
  return { fieldSources, changedPaths };
}

/**
 * Counter deltas of one version, summed per counter (one operation per counter and transaction):
 * inventory per agency and status (moves on creation, status or agency change, Req 13.1, 10.3),
 * history per agency of the version (Req 14.5) and changes per channel and UTC day (Req 13.1).
 */
const hasDuplicateFlag = (flags: readonly ListingFlag[]): boolean =>
  flags.some((flag) => flag.code === 'DUPLICATE');

/** Change of `listing.flags.DUPLICATE` when a listing's flags change within one agency. */
function flagDelta(before: readonly ListingFlag[], after: readonly ListingFlag[]): number {
  return Number(hasDuplicateFlag(after)) - Number(hasDuplicateFlag(before));
}

function counterIncrements(
  current: ManagedListing | null,
  { next, channel }: StateChange,
  flags: readonly ListingFlag[],
  snapshot: { created: boolean; bytes: number },
  at: string,
): MetricCounterIncrement[] {
  const sums = new Map<string, MetricCounterIncrement>();
  const add = (scope: string, code: string, delta: number, day?: string) => {
    const key = `${scope}|${code}|${day ?? ''}`;
    const existing = sums.get(key);
    sums.set(key, {
      scope,
      code,
      delta: (existing?.delta ?? 0) + delta,
      ...(day !== undefined && { day }),
    });
  };
  const scope = agencyScope(next.agencyId);
  if (current !== null) {
    add(
      agencyScope(current.management.agencyId),
      LISTING_COUNTER_CODES.status(current.management.status),
      -1,
    );
  }
  add(scope, LISTING_COUNTER_CODES.status(next.status), 1);
  // Listings with a Duplikat_Markierung, per agency; moves with an agency change (Req 14.5).
  if (current !== null && hasDuplicateFlag(current.management.flags ?? [])) {
    add(agencyScope(current.management.agencyId), LISTING_COUNTER_CODES.duplicateFlags, -1);
  }
  if (hasDuplicateFlag(flags)) add(scope, LISTING_COUNTER_CODES.duplicateFlags, 1);
  add(scope, LISTING_COUNTER_CODES.versionCount, 1);
  if (snapshot.created) add(scope, LISTING_COUNTER_CODES.storageBytes, snapshot.bytes);
  add(scope, LISTING_COUNTER_CODES.changes(channel), 1, at.slice(0, 10));
  return [...sums.values()].filter((increment) => increment.delta !== 0);
}
