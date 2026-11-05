import {
  changedContentPaths,
  CONTENT_FIELDS,
  contentHash,
  contentPaths,
  deriveProvenance,
  err,
  ok,
  type ActorRef,
  type ChangeType,
  type Channel,
  type FieldSource,
  type FieldSources,
  type Listing,
  type ListingContent,
  type Origin,
  type Result,
  type VersionedState,
} from '@open-estate/shared';
import type { Clock } from '../access/ttl-cache';
import {
  customIdBlocklistKey,
  type DeletionBlocklistCheck,
} from '../deletion/deletion-blocklist-check';
import { toManagedListingItem, type ListingManagement } from '../search/listings-table';
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
  | { code: 'CUSTOM_ID_TAKEN' };

export type WriteResult = Result<WriteSuccess, WriteConflict>;

/** Counter codes written by the writer (design: "Monitoring und Kennzahlenkatalog"). */
export const LISTING_COUNTER_CODES = {
  status: (status: string) => `listing.status.${status}`,
  changes: (channel: Channel) => `listing.changes.${channel}`,
  versionCount: 'history.version_count',
  storageBytes: 'history.storage_bytes',
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
}

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
  ): Promise<WriteResult> {
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
    const management: ListingManagement = {
      status: next.status,
      origin,
      version,
      contentHash: hash,
      fieldSources,
      updatedAt: at,
      ...(next.agencyId !== undefined && { agencyId: next.agencyId }),
      ...(next.customId !== undefined && { customId: next.customId }),
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
    };

    const ops: Op[] = [
      this.deps.listings.putOp(toManagedListingItem(listing, management), change.expectedVersion),
      this.deps.versions.putOp(record),
      this.deps.blocklist.notBlockedOp(listingId),
      ...this.customIdOps(current, change),
      ...counterIncrements(current, change, snapshot, at).map((i) => this.deps.counters.addOp(i)),
    ];
    const result = await this.deps.transactor.transact(ops);
    if (!result.ok) return err(await this.conflict(listingId, result.error.failed));
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
  private async conflict(listingId: string, failed: readonly string[]): Promise<WriteConflict> {
    if (failed.includes('deletionBlocklist.check')) return { code: 'DELETION_BLOCKED' };
    if (failed.includes('listing.put') || failed.includes('listingVersion.put')) {
      return this.versionConflict(listingId);
    }
    if (failed.includes('listingKey.assign')) return { code: 'CUSTOM_ID_TAKEN' };
    // Only the release of the previous Custom_Id failed: the stored key does not point to this
    // listing although the listing carries the Custom_Id — an invariant violation, not a conflict.
    throw new Error(`Inconsistent Custom_Id key of listing ${listingId}: ${failed.join(', ')}`);
  }

  private async versionConflict(listingId: string): Promise<WriteConflict> {
    const latest = await this.deps.listings.get(listingId);
    return latest === null
      ? { code: 'NOT_FOUND' }
      : { code: 'VERSION_CONFLICT', currentVersion: latest.management.version };
  }
}

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
function counterIncrements(
  current: ManagedListing | null,
  { next, channel }: StateChange,
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
  add(scope, LISTING_COUNTER_CODES.versionCount, 1);
  if (snapshot.created) add(scope, LISTING_COUNTER_CODES.storageBytes, snapshot.bytes);
  add(scope, LISTING_COUNTER_CODES.changes(channel), 1, at.slice(0, 10));
  return [...sums.values()].filter((increment) => increment.delta !== 0);
}
