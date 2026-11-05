import {
  diffState,
  err,
  ok,
  type ApiError,
  type DiffEntry,
  type DiffResponse,
  type ListingContent,
  type Result,
  type VersionDetail,
  type VersionedState,
  type VersionEntry,
} from '@open-estate/shared';
import { AgencyAuditTrail, notFound, type AgencyActor, type AgencyAudit } from './agency-audit';
import type { KeyPage, KeyPageRequest } from './key-page';
import {
  listingTarget,
  readableListing,
  type ListingReadAction,
  type ListingReadResult,
} from './listing-query-service';
import type { ManagedListingStore } from './listing-store';
import type { ListingVersionRecord, ListingVersionStore } from './listing-version-store';
import { contentToInput } from './listing-view';
import type { SnapshotStore } from './snapshot-store';

// Version history of a listing (design: "Management_API", "Diff", Req 7.5, 7.6). Version contents
// come from the content-addressed snapshots; diffs are never stored but computed from two
// snapshots (Req 9.2). Reads are audited only when rejected (Req 2.8).

/** History entry of a version record (Req 7.5); the content is not part of the entry. */
export function toVersionEntry(record: ListingVersionRecord): VersionEntry {
  return {
    version: record.version,
    changeType: record.changeType,
    channel: record.channel,
    actor: structuredClone(record.actor),
    createdAt: record.createdAt,
    status: record.status,
    ...(record.customId !== undefined && { customId: record.customId }),
    ...(record.agencyId !== undefined && { agencyId: record.agencyId }),
    changedPaths: structuredClone(record.changedPaths),
    ...(record.restoredFrom !== undefined && { restoredFrom: record.restoredFrom }),
  };
}

export interface VersionServiceDeps {
  listings: Pick<ManagedListingStore<unknown>, 'get'>;
  versions: Pick<ListingVersionStore<unknown>, 'get' | 'list'>;
  snapshots: Pick<SnapshotStore, 'get'>;
  audit: AgencyAudit;
}

const versionTarget = (listingId: string, version: number) =>
  `${listingTarget(listingId)}/version/${version}`;

export class VersionService {
  private readonly deps: VersionServiceDeps;
  private readonly trail: AgencyAuditTrail<ListingReadAction>;

  constructor(deps: VersionServiceDeps) {
    this.deps = deps;
    this.trail = new AgencyAuditTrail<ListingReadAction>(deps.audit);
  }

  /** `GET /listings/{id}/versions`: newest first, paginated (Req 7.5); throws `InvalidCursorError`. */
  async list(
    actor: AgencyActor,
    listingId: string,
    page: KeyPageRequest,
  ): Promise<ListingReadResult<KeyPage<VersionEntry>>> {
    const found = await readableListing(this.deps.listings, actor.principal, listingId);
    if (!found.ok) {
      return this.trail.reject(
        actor,
        'version.list',
        listingTarget(listingId),
        undefined,
        found.error,
      );
    }
    const result = await this.deps.versions.list(listingId, page);
    return ok({ ...result, items: result.items.map(toVersionEntry) });
  }

  /** `GET /listings/{id}/versions/{n}`: entry plus the full Listing_Inhalt of the version. */
  async get(
    actor: AgencyActor,
    listingId: string,
    version: number,
  ): Promise<ListingReadResult<VersionDetail>> {
    const target = versionTarget(listingId, version);
    const loaded = await this.load(actor, listingId, [version]);
    if (!loaded.ok) return this.trail.reject(actor, 'version.get', target, undefined, loaded.error);
    const [state] = loaded.value;
    if (state === undefined) throw new Error('VersionService: version not loaded');
    return ok({ ...toVersionEntry(state.record), content: contentToInput(state.content) });
  }

  /**
   * `GET /listings/{id}/diff?from=&to=`: Diff from version `from` to version `to`, any two versions
   * in either order (Req 7.6). Values are in the API representation (amounts as decimal strings).
   */
  async diff(
    actor: AgencyActor,
    listingId: string,
    from: number,
    to: number,
  ): Promise<ListingReadResult<DiffResponse>> {
    const target = `${listingTarget(listingId)}/diff`;
    const loaded = await this.load(actor, listingId, [from, to]);
    if (!loaded.ok)
      return this.trail.reject(actor, 'version.diff', target, undefined, loaded.error);
    const [a, b] = loaded.value.map(apiState);
    if (a === undefined || b === undefined) throw new Error('VersionService: version not loaded');
    // `diffState` is a structural diff over JSON values; it is applied to the API representation
    // here, so the entries carry decimal strings instead of minor units.
    const entries: DiffEntry[] = diffState(
      a as unknown as VersionedState,
      b as unknown as VersionedState,
    );
    return ok({ from, to, entries });
  }

  /** Authorized listing, then the requested version records with their snapshot contents. */
  private async load(
    actor: AgencyActor,
    listingId: string,
    versions: readonly number[],
  ): Promise<Result<{ record: ListingVersionRecord; content: ListingContent }[], ApiError>> {
    const found = await readableListing(this.deps.listings, actor.principal, listingId);
    if (!found.ok) return found;
    const records: ListingVersionRecord[] = [];
    for (const version of versions) {
      const record = await this.deps.versions.get(listingId, version);
      if (record === null) return err(notFound());
      records.push(record);
    }
    // Equal contents share one snapshot (e.g. status versions), so each hash is read once.
    const contents = new Map<string, ListingContent>();
    for (const { contentHash } of records) {
      if (contents.has(contentHash)) continue;
      const content = await this.deps.snapshots.get(listingId, contentHash);
      // Every version references a snapshot written before its transaction (design, step 3).
      if (content === null) throw new Error(`Snapshot ${contentHash} of listing missing`);
      contents.set(contentHash, content);
    }
    return ok(
      records.map((record) => ({
        record,
        content: contents.get(record.contentHash) as ListingContent,
      })),
    );
  }
}

/** Versioned state of a version in the API representation (Req 7.1: content, status, owner). */
function apiState({ record, content }: { record: ListingVersionRecord; content: ListingContent }) {
  return {
    content: contentToInput(content),
    status: record.status,
    ...(record.customId !== undefined && { customId: record.customId }),
    ...(record.agencyId !== undefined && { agencyId: record.agencyId }),
  };
}
