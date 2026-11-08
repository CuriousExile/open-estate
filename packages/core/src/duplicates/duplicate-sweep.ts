import { isDeepStrictEqual } from 'node:util';
import {
  blockKeys,
  duplicateFlag,
  duplicateFlagOf,
  isOlder,
  publicDetailUrl,
  withDuplicateFlag,
  type ActorRef,
  type DuplicateFlag,
  type ListingFlag,
} from '@open-estate/shared';
import type { Clock } from '../access/ttl-cache';
import type { AuditService } from '../management/audit-service';
import type {
  ListingSweepSource,
  ManagedListing,
  ManagedListingStore,
} from '../management/listing-store';
import { CROSS_AGENCY_OPEN_COUNTER } from '../management/metric-resolvers';
import {
  agencyScope,
  PLATFORM_SCOPE,
  type MetricCounterStore,
} from '../management/metric-counter-store';
import type { Transactor } from '../management/transaction';
import type { VersionedListingWriter } from '../management/versioned-listing-writer';
import { creationTime } from '../search/listings-table';
import { flagDetails, sameFlag } from './duplicate-decision';
import type { CrossMatch, DuplicateDetector } from './duplicate-detector';
import {
  parseStoredProfile,
  scopeAgency,
  type DuplicateIndexEntry,
  type DuplicateIndexStore,
  type StoredProfile,
} from './duplicate-index-store';
import {
  duplicateReportId,
  type DuplicateReport,
  type DuplicateReportStore,
} from './duplicate-report-store';

// Duplikat_Abgleich (duplicate-detection design: "Duplikat_Abgleich", Req 10, 11, 12.4). A run is
// split into phases; each phase but the last works on `segments` parts of a table in parallel, and
// each part is processed in steps that end after a time budget and return a cursor, so a Step
// Functions Map can drive it without any Lambda running longer than allowed:
//
//   INDEX   scan `Listings`: store the Merkmalsprofil under the current rules where the stored
//           one is missing or differs (listings written outside the writer, changed rules).
//   ORPHAN  scan the Duplikat_Index: remove the data of listings that no longer exist, exact keys
//           nobody owns, and Verwerfungen naming missing listings.
//   MATCH   scan the profiles: the Duplikat_Markierung as the write paths would set it (detected
//           by `SWEEP`), missing exact-key owners, and Agenturübergreifende_Treffer.
//   RESOLVE `OPEN` Treffer the MATCH phase did not see again become `RESOLVED` (Req 11.6).
//
// Every write is conditioned on the state it was decided on (listing version and Markierungen,
// profile revision, report revision): a listing changed during the run keeps what its writer set
// and is checked again in the next run (Req 10.5). The Abgleich never changes a status and never
// writes a version (Req 10.3); Treffer never touch listings (Req 11.2).

export const SWEEP_PHASES = ['INDEX', 'ORPHAN', 'MATCH', 'RESOLVE'] as const;
export type SweepPhase = (typeof SWEEP_PHASES)[number];

/** Phases over `segments` parallel parts; RESOLVE is a single part. */
export const SEGMENTED_PHASES = ['INDEX', 'ORPHAN', 'MATCH'] as const;

/** What a run did; summed over all steps (Req 10.7). No values of Inhaltsfeldern. */
export interface SweepCounts {
  /** Listings whose Markierung was determined (MATCH). */
  checked: number;
  /** Profiles written because they were missing or differed (INDEX). */
  indexed: number;
  /**
   * Listings whose Duplikat_Index data was removed because they no longer exist (ORPHAN): all of
   * a listing's items at once, when the scan meets the first of them.
   */
  orphansRemoved: number;
  /** Exact keys released (owner gone or no longer claiming) or claimed (oldest listing). */
  exactReleased: number;
  exactClaimed: number;
  /** Listing ids removed from Verwerfungen because those listings no longer exist. */
  dismissalsPruned: number;
  flagsSet: number;
  flagsUpdated: number;
  flagsRemoved: number;
  /** Treffer created or reopened, and resolved. */
  reportsNew: number;
  reportsResolved: number;
  /** Listings checked with the candidate limit reached (Req 5.7). */
  truncated: number;
  /** Decisions not written because the listing, profile or Treffer changed meanwhile (Req 10.5). */
  skipped: number;
  /** Items of `Listings` that are no readable managed listing. */
  invalid: number;
}

export const SWEEP_COUNT_KEYS = [
  'checked',
  'indexed',
  'orphansRemoved',
  'exactReleased',
  'exactClaimed',
  'dismissalsPruned',
  'flagsSet',
  'flagsUpdated',
  'flagsRemoved',
  'reportsNew',
  'reportsResolved',
  'truncated',
  'skipped',
  'invalid',
] as const satisfies readonly (keyof SweepCounts)[];

export const emptySweepCounts = (): SweepCounts =>
  Object.fromEntries(SWEEP_COUNT_KEYS.map((key) => [key, 0])) as unknown as SweepCounts;

export function addSweepCounts(a: SweepCounts, b: Partial<SweepCounts>): SweepCounts {
  const sum = { ...a };
  for (const key of SWEEP_COUNT_KEYS) sum[key] += b[key] ?? 0;
  return sum;
}

/** Identity of a run: `sweepId` is the Step Functions execution name. */
export interface SweepRun {
  sweepId: string;
  startedAt: string;
}

export interface SweepStep {
  phase: SweepPhase;
  /** 0-based part; RESOLVE always 0 of 1. */
  segment: number;
  segments: number;
  cursor?: string;
}

export interface SweepStepResult {
  /** Absent when the part is done. */
  cursor?: string;
  counts: SweepCounts;
}

/** `SKIPPED`: the Duplikat-Erkennung was switched off when the run started; nothing was read. */
export type SweepStatus = 'SUCCEEDED' | 'FAILED' | 'SKIPPED';

/** Log line and result of a finished run (Req 10.7). */
export interface SweepSummary extends SweepCounts {
  event: 'duplicate.sweep';
  sweepId: string;
  status: SweepStatus;
  startedAt: string;
  endedAt: string;
}

export interface DuplicateSweepDeps<Op> {
  listings: Pick<ManagedListingStore<Op>, 'checkOp'> & ListingSweepSource;
  index: DuplicateIndexStore<Op>;
  reports: DuplicateReportStore<Op>;
  counters: Pick<MetricCounterStore<Op>, 'addOp'>;
  transactor: Transactor<Op>;
  /** Markierungen without a version, with the `listing.flags.*` counters (Req 10.3). */
  writer: Pick<VersionedListingWriter<Op>, 'setFlags'>;
  /** Built with the configuration read at the start of the run (Req 10.6). */
  detector: DuplicateDetector;
  audit: Pick<AuditService, 'append'>;
  clock: Clock;
  /** Frontend origin, so a derived source URL is ignored like in the Management_API (Req 3.1). */
  frontendOrigin?: string;
  /** Items per scan page; default {@link SWEEP_PAGE_SIZE}. */
  pageSize?: number;
}

export const SWEEP_PAGE_SIZE = 100;

/** The system actor of a run (audit entries of Markierungen, Req 7.7). */
export const sweepActor = (sweepId: string): ActorRef => ({
  kind: 'system',
  job: 'duplicate-sweep',
  runId: sweepId,
});

/** Profile without its store-managed revision, normalized for comparison. */
function comparable(profile: StoredProfile): StoredProfile {
  const parsed = parseStoredProfile(profile);
  delete parsed.revision;
  if (parsed.exactClaimed !== true) delete parsed.exactClaimed;
  return parsed;
}

export class DuplicateSweep<Op> {
  private readonly deps: DuplicateSweepDeps<Op>;

  constructor(deps: DuplicateSweepDeps<Op>) {
    this.deps = deps;
  }

  /**
   * Processes one part of a phase from `step.cursor` until it is done or `outOfTime()` — checked
   * after each page, so every step makes progress.
   */
  async step(
    run: SweepRun,
    step: SweepStep,
    outOfTime: () => boolean = () => false,
  ): Promise<SweepStepResult> {
    let counts = emptySweepCounts();
    let cursor = step.cursor;
    do {
      const page = await this.page(run, { ...step, ...(cursor !== undefined && { cursor }) });
      counts = addSweepCounts(counts, page.counts);
      cursor = page.cursor;
    } while (cursor !== undefined && !outOfTime());
    return { counts, ...(cursor !== undefined && { cursor }) };
  }

  /** Summary of a finished run; the caller logs it. */
  summary(run: SweepRun, counts: SweepCounts, status: SweepStatus): SweepSummary {
    return {
      event: 'duplicate.sweep',
      sweepId: run.sweepId,
      status,
      startedAt: run.startedAt,
      endedAt: this.now(),
      ...counts,
    };
  }

  private now(): string {
    return new Date(this.deps.clock()).toISOString();
  }

  private get pageSize(): number {
    return this.deps.pageSize ?? SWEEP_PAGE_SIZE;
  }

  private async page(run: SweepRun, step: SweepStep): Promise<SweepStepResult> {
    const request = {
      segment: step.segment,
      segments: step.segments,
      limit: this.pageSize,
      ...(step.cursor !== undefined && { cursor: step.cursor }),
    };
    switch (step.phase) {
      case 'INDEX': {
        const page = await this.deps.listings.scan(request);
        return { counts: await this.indexListings(page.items), ...cursorOf(page.cursor) };
      }
      case 'ORPHAN': {
        const page = await this.deps.index.scan(request);
        return { counts: await this.removeOrphans(page.items), ...cursorOf(page.cursor) };
      }
      case 'MATCH': {
        const page = await this.deps.index.scan(request);
        return { counts: await this.matchProfiles(run, page.items), ...cursorOf(page.cursor) };
      }
      case 'RESOLVE': {
        const page = await this.deps.reports.list(
          { state: 'OPEN' },
          { limit: this.pageSize, ...(step.cursor !== undefined && { cursor: step.cursor }) },
        );
        return { counts: await this.resolveReports(run, page.items), ...cursorOf(page.nextCursor) };
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // INDEX (Req 10.4, 10.6)
  // -------------------------------------------------------------------------------------------

  private async indexListings(
    items: readonly (ManagedListing | { invalid: string })[],
  ): Promise<SweepCounts> {
    const counts = emptySweepCounts();
    const listings = items.filter((item): item is ManagedListing => !('invalid' in item));
    counts.invalid = items.length - listings.length;
    const stored = await this.deps.index.getProfiles(
      listings.map((managed) => managed.listing.id),
      { consistent: true },
    );
    for (const managed of listings) {
      const id = managed.listing.id;
      const before = stored.get(id) ?? null;
      const expected = this.expectedProfile(managed, before);
      if (before !== null && isDeepStrictEqual(comparable(before), comparable(expected))) continue;
      const { index, listings: store } = this.deps;
      const ops = [
        store.checkOp(id, managed.management.version),
        ...index.syncOps(before, expected, { guard: true }),
      ];
      // A claim that no longer fits the profile (other key or Prüfbereich) is released.
      if (before?.exactClaimed === true && expected.exactClaimed !== true) {
        const owner = await index.exactOwner(before.scope, before.profile.exactKey);
        if (owner === id) ops.push(index.releaseExactOp(before.scope, before.profile.exactKey, id));
      }
      const result = await this.deps.transactor.transact(ops);
      if (result.ok) counts.indexed += 1;
      else counts.skipped += 1;
    }
    return counts;
  }

  /** The profile the writer would store for the listing's current version. */
  private expectedProfile(managed: ManagedListing, before: StoredProfile | null): StoredProfile {
    const { listing, management } = managed;
    const { detector, frontendOrigin } = this.deps;
    const derived =
      frontendOrigin === undefined ? undefined : publicDetailUrl(frontendOrigin, listing.id);
    const profile = detector.profileOf(listing, derived);
    const scope = agencyScope(management.agencyId);
    const keep =
      before?.exactClaimed === true &&
      before.scope === scope &&
      before.profile.exactKey === profile.exactKey;
    return {
      listingId: listing.id,
      scope,
      createdAt: creationTime(managed),
      listingVersion: management.version,
      profile,
      blockKeys: blockKeys(profile, detector.config),
      dismissed: before?.dismissed ?? [],
      ...(keep && { exactClaimed: true }),
    };
  }

  // -------------------------------------------------------------------------------------------
  // ORPHAN (Req 12.4)
  // -------------------------------------------------------------------------------------------

  private async removeOrphans(entries: readonly DuplicateIndexEntry[]): Promise<SweepCounts> {
    const counts = emptySweepCounts();
    const referenced = new Set<string>();
    for (const entry of entries) {
      referenced.add(entry.kind === 'profile' ? entry.profile.listingId : entry.listingId);
      if (entry.kind === 'profile') for (const id of entry.profile.dismissed) referenced.add(id);
    }
    const existing = await this.deps.listings.existing([...referenced]);

    const purged = new Set<string>();
    const owners: { scope: string; exactKey: string; listingId: string }[] = [];
    for (const entry of entries) {
      if (entry.kind === 'exact') {
        owners.push(entry);
        continue;
      }
      const listingId = entry.kind === 'profile' ? entry.profile.listingId : entry.listingId;
      if (existing.has(listingId)) {
        if (entry.kind === 'profile') await this.pruneDismissals(entry.profile, existing, counts);
        continue;
      }
      if (purged.has(listingId)) continue;
      purged.add(listingId);
      await this.purgeOrphan(listingId);
      counts.orphansRemoved += 1;
    }

    // Exact keys: only a listing whose profile claims the key may own it.
    const profiles = await this.deps.index.getProfiles(
      owners.map((owner) => owner.listingId).filter((id) => existing.has(id)),
      { consistent: true },
    );
    for (const owner of owners) {
      const profile = profiles.get(owner.listingId);
      const claimed =
        existing.has(owner.listingId) &&
        profile?.exactClaimed === true &&
        profile.scope === owner.scope &&
        profile.profile.exactKey === owner.exactKey;
      if (claimed) continue;
      if (await this.deps.index.releaseExact(owner.scope, owner.exactKey, owner.listingId)) {
        counts.exactReleased += 1;
      }
    }
    return counts;
  }

  /** Verwerfungen naming listings that no longer exist are removed (Req 12.4). */
  private async pruneDismissals(
    profile: StoredProfile,
    existing: ReadonlySet<string>,
    counts: SweepCounts,
  ): Promise<void> {
    const kept = profile.dismissed.filter((id) => existing.has(id));
    if (kept.length === profile.dismissed.length) return;
    const result = await this.deps.transactor.transact(
      this.deps.index.syncOps(profile, { ...profile, dismissed: kept }, { guard: true }),
    );
    if (result.ok) counts.dismissalsPruned += profile.dismissed.length - kept.length;
    else counts.skipped += 1;
  }

  /** Everything the Duplikat-Erkennung holds about a listing that no longer exists. */
  private async purgeOrphan(listingId: string): Promise<void> {
    await purgeListingReports(this.deps, listingId);
    await this.deps.index.purgeListing(listingId);
  }

  // -------------------------------------------------------------------------------------------
  // MATCH (Req 10.3, 10.5, 11.1)
  // -------------------------------------------------------------------------------------------

  private async matchProfiles(
    run: SweepRun,
    entries: readonly DuplicateIndexEntry[],
  ): Promise<SweepCounts> {
    const counts = emptySweepCounts();
    const profiles = entries.flatMap((entry) => (entry.kind === 'profile' ? [entry.profile] : []));
    if (profiles.length === 0) return counts;
    const listings = await this.deps.listings.getMany(profiles.map((p) => p.listingId));
    for (const profile of profiles) {
      const managed = listings.get(profile.listingId);
      // Gone (the next ORPHAN phase removes it) or changed since the INDEX phase (its writer
      // maintained the profile; checked again in the next run).
      if (managed === undefined) continue;
      if (managed.management.version !== profile.listingVersion) {
        counts.skipped += 1;
        continue;
      }
      await this.matchOne(run, profile, managed, counts);
    }
    return counts;
  }

  private async matchOne(
    run: SweepRun,
    stored: StoredProfile,
    managed: ManagedListing,
    counts: SweepCounts,
  ): Promise<void> {
    const { listing } = managed;
    const { frontendOrigin } = this.deps;
    const result = await this.deps.detector.assessAcross({
      listingId: listing.id,
      scope: stored.scope,
      createdAt: stored.createdAt,
      content: listing,
      ...(frontendOrigin !== undefined && {
        derivedSourceUrl: publicDetailUrl(frontendOrigin, listing.id),
      }),
      dismissed: stored.dismissed,
    });
    counts.checked += 1;
    if (result.truncated) counts.truncated += 1;

    await this.updateFlag(run, stored, managed, result.assessment.matches, counts);
    await this.updateExactClaim(stored, managed, result, counts);
    for (const match of result.crossMatches) {
      // Each pair once, from the listing with the smaller id.
      if (listing.id < match.listingId) await this.upsertReport(run, stored, match, counts);
    }
  }

  /** Markierung as Property 11's reference model, detected by `SWEEP` (Req 10.3). */
  private async updateFlag(
    run: SweepRun,
    stored: StoredProfile,
    managed: ManagedListing,
    matches: Parameters<typeof duplicateFlag>[1],
    counts: SweepCounts,
  ): Promise<void> {
    const { listing, management } = managed;
    const current = management.flags ?? [];
    const before = duplicateFlagOf(current);
    const computed = duplicateFlag(
      { listingId: listing.id, createdAt: stored.createdAt },
      matches,
      'SWEEP',
      this.now(),
    );
    if (sameFlag(before ?? null, computed)) return;
    const flags: ListingFlag[] = withDuplicateFlag(current, computed);
    const written = await this.deps.writer.setFlags({
      listingId: listing.id,
      expectedVersion: management.version,
      expectedFlags: current,
      flags,
    });
    if (!written.ok) {
      counts.skipped += 1;
      return;
    }
    const action =
      computed === null
        ? 'listing.flag.remove'
        : before === undefined
          ? 'listing.flag.set'
          : 'listing.flag.update';
    if (computed === null) counts.flagsRemoved += 1;
    else if (before === undefined) counts.flagsSet += 1;
    else counts.flagsUpdated += 1;
    await this.auditFlag(
      run,
      listing.id,
      management.agencyId,
      action,
      (computed ?? before) as DuplicateFlag,
    );
  }

  private async auditFlag(
    run: SweepRun,
    listingId: string,
    agencyId: string | undefined,
    action: string,
    flag: DuplicateFlag,
  ): Promise<void> {
    await this.deps.audit.append({
      category: 'management',
      actor: sweepActor(run.sweepId),
      action,
      target: `listing/${listingId}`,
      ...(agencyId !== undefined && { agencyId }),
      result: 'SUCCESS',
      details: flagDetails(flag),
    });
  }

  /**
   * Exact keys without owner go to the oldest listing with that key in the Prüfbereich; a claim
   * the index no longer backs is dropped from the profile.
   */
  private async updateExactClaim(
    stored: StoredProfile,
    managed: ManagedListing,
    result: Awaited<ReturnType<DuplicateDetector['assessAcross']>>,
    counts: SweepCounts,
  ): Promise<void> {
    const id = stored.listingId;
    const owner = result.assessment.exactOwner;
    const self = { listingId: id, createdAt: stored.createdAt };
    const oldest = !result.exactPeers.some((peer) => peer.listingId !== id && isOlder(peer, self));
    const claim = owner === id || (owner === null && oldest);
    const claimed = stored.exactClaimed === true;
    if (claim === claimed && !(claim && owner === null)) return;
    const { index, listings } = this.deps;
    const next: StoredProfile = { ...stored };
    if (claim) next.exactClaimed = true;
    else delete next.exactClaimed;
    const ops = [
      listings.checkOp(id, managed.management.version),
      ...(claim ? [index.claimExactOp(stored.scope, stored.profile.exactKey, id)] : []),
      ...index.syncOps(stored, next, { guard: true }),
    ];
    const written = await this.deps.transactor.transact(ops);
    if (!written.ok) counts.skipped += 1;
    else if (claim && owner === null) counts.exactClaimed += 1;
  }

  /** Agenturübergreifender_Treffer of the pair (Req 11.1, 11.5); never touches the listings. */
  private async upsertReport(
    run: SweepRun,
    stored: StoredProfile,
    match: CrossMatch,
    counts: SweepCounts,
  ): Promise<void> {
    const { reports, index, listings, counters } = this.deps;
    const reportId = duplicateReportId(stored.listingId, match.listingId);
    const existing = await reports.get(reportId);
    const now = this.now();
    const agencyA = scopeAgency(stored.scope);
    const agencyB = scopeAgency(match.scope);
    const state = existing?.state === 'DISMISSED' ? 'DISMISSED' : 'OPEN';
    const next: DuplicateReport = {
      reportId,
      listingA: stored.listingId,
      listingB: match.listingId,
      ...(agencyA !== undefined && { agencyA }),
      ...(agencyB !== undefined && { agencyB }),
      score: match.score,
      reasons: match.reasons,
      state,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      lastSweepId: run.sweepId,
      ...(existing?.dismissedAt !== undefined && { dismissedAt: existing.dismissedAt }),
    };
    const opened = state === 'OPEN' && existing?.state !== 'OPEN';
    const ops = [
      // Both listings must still exist: a deletion removes the listing before its Treffer.
      listings.checkOp(stored.listingId),
      listings.checkOp(match.listingId),
      reports.putOp(next, existing),
      index.reportRefOp(stored.listingId, reportId),
      index.reportRefOp(match.listingId, reportId),
      ...(opened ? [counters.addOp(openReportsDelta(1))] : []),
    ];
    const written = await this.deps.transactor.transact(ops);
    if (!written.ok) counts.skipped += 1;
    else if (opened) counts.reportsNew += 1;
  }

  // -------------------------------------------------------------------------------------------
  // RESOLVE (Req 11.6)
  // -------------------------------------------------------------------------------------------

  private async resolveReports(
    run: SweepRun,
    open: readonly DuplicateReport[],
  ): Promise<SweepCounts> {
    const counts = emptySweepCounts();
    for (const report of open) {
      if (report.lastSweepId === run.sweepId) continue;
      const written = await this.deps.transactor.transact([
        this.deps.reports.putOp({ ...report, state: 'RESOLVED' }, report),
        this.deps.counters.addOp(openReportsDelta(-1)),
      ]);
      if (written.ok) counts.reportsResolved += 1;
      else counts.skipped += 1;
    }
    return counts;
  }
}

const cursorOf = (cursor: string | undefined): { cursor?: string } =>
  cursor === undefined ? {} : { cursor };

/** Change of `duplicate.cross_agency_open` (platform scope, Req 14.5). */
export const openReportsDelta = (delta: number) => ({
  scope: PLATFORM_SCOPE,
  code: CROSS_AGENCY_OPEN_COUNTER,
  delta,
});

/**
 * Removes the Agenturübergreifenden_Treffer of a listing (deletion request, Req 12.3, and the
 * ORPHAN phase): each Treffer with the `OPEN` counter, then the partner's Verweis. The listing's
 * own Verweise go with its index partition. Idempotent; `complete` = no Treffer is left.
 */
export async function purgeListingReports<Op>(
  deps: {
    index: Pick<DuplicateIndexStore<Op>, 'reportRefs' | 'deleteReportRef'>;
    reports: Pick<DuplicateReportStore<Op>, 'get' | 'deleteOp'>;
    counters: Pick<MetricCounterStore<Op>, 'addOp'>;
    transactor: Transactor<Op>;
  },
  listingId: string,
): Promise<{ complete: boolean }> {
  let complete = true;
  for (const reportId of await deps.index.reportRefs(listingId)) {
    const report = await deps.reports.get(reportId);
    if (report !== null) {
      const partner = report.listingA === listingId ? report.listingB : report.listingA;
      const removed = await deps.transactor.transact([
        deps.reports.deleteOp(report),
        ...(report.state === 'OPEN' ? [deps.counters.addOp(openReportsDelta(-1))] : []),
      ]);
      if (!removed.ok) {
        complete = false;
        continue;
      }
      await deps.index.deleteReportRef(partner, reportId);
    }
  }
  return { complete };
}

/** Sum of the counts of several steps (e.g. the Map results of Step Functions). */
export function sumSweepCounts(parts: readonly Partial<SweepCounts>[]): SweepCounts {
  return parts.reduce<SweepCounts>((sum, part) => addSweepCounts(sum, part), emptySweepCounts());
}

/**
 * Runs a whole Duplikat_Abgleich in this process (dev server, tests): the phases in order, each
 * part until done. Equivalent to the state machine without the time budget.
 */
export async function runDuplicateSweep<Op>(
  sweep: DuplicateSweep<Op>,
  run: SweepRun,
  segments: number,
): Promise<SweepSummary> {
  let counts = emptySweepCounts();
  for (const phase of SEGMENTED_PHASES) {
    for (let segment = 0; segment < segments; segment += 1) {
      let cursor: string | undefined;
      do {
        const result = await sweep.step(run, {
          phase,
          segment,
          segments,
          ...(cursor !== undefined && { cursor }),
        });
        counts = addSweepCounts(counts, result.counts);
        cursor = result.cursor;
      } while (cursor !== undefined);
    }
  }
  let cursor: string | undefined;
  do {
    const result = await sweep.step(run, {
      phase: 'RESOLVE',
      segment: 0,
      segments: 1,
      ...(cursor !== undefined && { cursor }),
    });
    counts = addSweepCounts(counts, result.counts);
    cursor = result.cursor;
  } while (cursor !== undefined);
  return sweep.summary(run, counts, 'SUCCEEDED');
}
