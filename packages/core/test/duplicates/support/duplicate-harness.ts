import {
  agencyScope,
  contentRules,
  creationTime,
  DuplicateDetector,
  DuplicateReportService,
  DuplicateSweep,
  InMemoryAgencyStore,
  InMemoryDuplicateReportStore,
  InMemoryAuditService,
  InMemoryDeletionBlocklistCheck,
  InMemoryDuplicateIndexStore,
  InMemoryIdempotencyStore,
  InMemoryListingKeyStore,
  InMemoryListingVersionStore,
  InMemoryManagedListingStore,
  InMemoryMetricCounterStore,
  InMemorySnapshotStore,
  InMemoryTransactor,
  ListingCommandService,
  manualContentSchema,
  runDuplicateSweep,
  StaticDuplicateDetectionSetting,
  VersionedListingWriter,
  type AgencyRecord,
  type ManagedListing,
  type SweepSummary,
} from '@open-estate/core';
import {
  blockKeys,
  buildProfile,
  DEFAULT_DUPLICATE_CONFIG,
  duplicateFlagOf,
  publicDetailUrl,
  scoreMatch,
  type DuplicateConfig,
  type DuplicateMatch,
  type Principal,
} from '@open-estate/shared';
import fc from 'fast-check';
import {
  arbRealisticInput,
  arbVariantOptions,
  formattingVariant,
  TAXONOMY,
} from '../../../../shared/test/arbitraries/duplicates';

// Test platform for the Duplikat-Erkennung: every in-memory store of the listing write path,
// the writer with Duplikat_Index and Idempotenzschlüssel, the detector and the command service,
// wired as in production. Plus a brute-force reference model of Req 4 over the whole stock.

export const ORIGIN = 'https://estate.example';
export const AGENCY_IDS = ['agy-a', 'agy-b'] as const;

const agency = (agencyId: string): AgencyRecord => ({
  agencyId,
  displayName: agencyId,
  state: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00.000Z',
  agencyAdmins: 1,
});

/** Agency member with every listing permission of its role. */
export const member = (agencyId: string, userId = `usr-${agencyId}`): Principal => ({
  kind: 'user',
  userId,
  displayName: userId,
  role: 'AGENCY_MEMBER',
  agencyId,
});

/** Machine access with the listing permissions. */
export const machine = (agencyId: string, keyId = `mk-${agencyId}`): Principal => ({
  kind: 'machine',
  keyId,
  label: keyId,
  agencyId,
  permissions: ['listing:read', 'listing:write', 'listing:status', 'version:restore'],
});

export const platformAdmin: Principal = {
  kind: 'user',
  userId: 'usr-admin',
  displayName: 'Admin',
  role: 'PLATFORM_ADMIN',
};

export interface PlatformOptions {
  /** GSI of the Duplikat_Index lags behind the table until `index.flushIndex()`. */
  lagging?: boolean;
  config?: DuplicateConfig;
  /** Ein/Aus of the Duplikat-Erkennung at start; default on. */
  enabled?: boolean;
}

export function duplicatePlatform(options: PlatformOptions = {}) {
  const config = options.config ?? DEFAULT_DUPLICATE_CONFIG;
  let now = Date.parse('2026-03-01T10:00:00.000Z');
  const clock = () => (now += 1000);
  const listings = new InMemoryManagedListingStore();
  const versions = new InMemoryListingVersionStore();
  const snapshots = new InMemorySnapshotStore();
  const counters = new InMemoryMetricCounterStore();
  const keys = new InMemoryListingKeyStore();
  const index = new InMemoryDuplicateIndexStore({ lagging: options.lagging ?? false });
  const blocklist = new InMemoryDeletionBlocklistCheck();
  const idempotency = new InMemoryIdempotencyStore();
  const audit = new InMemoryAuditService();
  const reports = new InMemoryDuplicateReportStore();
  const transactor = new InMemoryTransactor();
  const detector = new DuplicateDetector({ index, taxonomy: TAXONOMY, config });
  const detection = new StaticDuplicateDetectionSetting(options.enabled ?? true);
  const writer = new VersionedListingWriter({
    listings,
    versions,
    keys,
    blocklist,
    counters,
    snapshots,
    transactor,
    clock,
    duplicates: { index, detector, frontendOrigin: ORIGIN },
    idempotency,
  });
  const commands = new ListingCommandService({
    listings,
    versions,
    snapshots,
    agencies: new InMemoryAgencyStore(AGENCY_IDS.map(agency)),
    writer,
    audit,
    frontendOrigin: ORIGIN,
    contentSchema: manualContentSchema(TAXONOMY),
    rules: contentRules({ tourProviders: { providers: [] }, taxonomy: TAXONOMY }),
    duplicates: detector,
    detection,
    idempotency,
    clock,
  });

  let sweeps = 0;
  const sweepStarts: string[] = [];
  /** Duplikat_Abgleich under `sweepConfig` (default: the platform's), small pages and segments. */
  const sweepDeps = (sweepConfig: DuplicateConfig = config) => ({
    listings,
    index,
    reports,
    counters,
    transactor,
    writer,
    detector: new DuplicateDetector({ index, taxonomy: TAXONOMY, config: sweepConfig }),
    audit,
    clock,
    frontendOrigin: ORIGIN,
    pageSize: 3,
  });
  const sweepFor = (sweepConfig: DuplicateConfig = config) =>
    new DuplicateSweep(sweepDeps(sweepConfig));
  const reportService = new DuplicateReportService({
    reports,
    counters,
    transactor,
    audit,
    clock,
    starter: {
      start: async () => {
        sweeps += 1;
        sweepStarts.push(`manual-${sweeps}`);
        return { executionName: `manual-${sweeps}`, alreadyRunning: false };
      },
    },
    detection,
  });

  return {
    config,
    listings,
    reports,
    reportService,
    transactor,
    sweepDeps,
    sweepFor,
    /** A complete Duplikat_Abgleich in this process. */
    sweep: (sweepConfig?: DuplicateConfig, segments = 2): Promise<SweepSummary> => {
      sweeps += 1;
      return runDuplicateSweep(
        sweepFor(sweepConfig),
        { sweepId: `sweep-${sweeps}`, startedAt: new Date(now).toISOString() },
        segments,
      );
    },
    versions,
    snapshots,
    keys,
    blocklist,
    counters,
    index,
    idempotency,
    audit,
    detector,
    /** Ein/Aus of the Duplikat-Erkennung (shared by commands and report service). */
    detection,
    /** Executions started through the report service. */
    sweepStarts,
    writer,
    commands,
    clock,
    /** Current platform time (epoch ms) without advancing it. */
    time: () => now,
    /** Moves the platform clock forward, e.g. past the 24 h of an Idempotenzschlüssel. */
    advance: (ms: number) => {
      now += ms;
    },
    /** Strongly consistent read of one listing. */
    get: (id: string) => listings.get(id),
    /** All listings read through the store (validated split into listing and management). */
    all: async (): Promise<ManagedListing[]> => {
      const ids = listings
        .all()
        .map((item) => item.id)
        .sort();
      const found = await Promise.all(ids.map((id) => listings.get(id)));
      return found.filter((l): l is ManagedListing => l !== null);
    },
  };
}

export type DuplicatePlatform = ReturnType<typeof duplicatePlatform>;

/** Merkmalsprofil of a stored listing under the platform's rules (or `config`). */
export function profileOfStored(
  platform: DuplicatePlatform,
  stored: ManagedListing,
  config: DuplicateConfig = platform.config,
) {
  return buildProfile(stored.listing, {
    taxonomy: TAXONOMY,
    config,
    derivedSourceUrl: publicDetailUrl(ORIGIN, stored.listing.id),
  });
}

/**
 * Reference model of Req 4 by brute force over the whole stock: the Treffer of `listing` are all
 * other listings of its Prüfbereich that `scoreMatch` calls duplicates and that no Verwerfung
 * separates; the expected Markierung follows with the pure `duplicateFlag`.
 */
export async function expectedMatches(
  platform: DuplicatePlatform,
  listing: ManagedListing,
  config: DuplicateConfig = platform.config,
): Promise<DuplicateMatch[]> {
  const all = await platform.all();
  const own = await platform.index.getProfile(listing.listing.id);
  const scope = agencyScope(listing.management.agencyId);
  const profile = profileOfStored(platform, listing, config);
  const matches: DuplicateMatch[] = [];
  for (const other of all) {
    if (other.listing.id === listing.listing.id) continue;
    if (agencyScope(other.management.agencyId) !== scope) continue;
    const otherStored = await platform.index.getProfile(other.listing.id);
    const dismissed =
      (own?.dismissed ?? []).includes(other.listing.id) ||
      (otherStored?.dismissed ?? []).includes(listing.listing.id);
    if (dismissed) continue;
    const result = scoreMatch(profile, profileOfStored(platform, other, config), config);
    if (!result.duplicate) continue;
    matches.push({
      listingId: other.listing.id,
      createdAt: creationTime(other),
      score: result.score,
      reasons: result.reasons,
    });
  }
  return matches;
}

/**
 * Whether `listing` should carry a Duplikat_Markierung and with which Original (Req 4.3, 4.4),
 * written out independently of `duplicateFlag`: a Treffer counts if it was created earlier, or at
 * the same time with a smaller id; the Original is the earliest of those.
 */
export async function expectedOriginal(
  platform: DuplicatePlatform,
  listing: ManagedListing,
  config: DuplicateConfig = platform.config,
): Promise<string | null> {
  const own = { id: listing.listing.id, at: Date.parse(creationTime(listing)) };
  const older = (await expectedMatches(platform, listing, config))
    .map((match) => ({ id: match.listingId, at: Date.parse(match.createdAt) }))
    .filter((match) => match.at < own.at || (match.at === own.at && match.id < own.id))
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  return older[0]?.id ?? null;
}

/** Original named by the stored Markierung, `null` without one. */
export const storedOriginal = (listing: ManagedListing): string | null =>
  duplicateFlagOf(listing.management.flags ?? [])?.originalId ?? null;

/** Recomputed index state of the stock, for Properties 10 and 17. */
export async function expectedIndex(
  platform: DuplicatePlatform,
  config: DuplicateConfig = platform.config,
) {
  const all = await platform.all();
  return all.map((listing) => {
    const profile = profileOfStored(platform, listing, config);
    return {
      listingId: listing.listing.id,
      scope: agencyScope(listing.management.agencyId),
      listingVersion: listing.management.version,
      profile,
      blockKeys: blockKeys(profile, config),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Operation sequences (Properties 10, 11, 22): creations, edits, status changes, releases,
// dismissals, agency assignments and restores over a small pool of contents, so duplicates
// occur often.
// ---------------------------------------------------------------------------------------------

export type Operation =
  | { kind: 'create'; agency: number; content: number; status: 'ACTIVE' | 'INACTIVE' }
  | { kind: 'edit'; listing: number; content: number }
  | { kind: 'status'; listing: number; status: 'ACTIVE' | 'INACTIVE' }
  | { kind: 'dismiss'; listing: number }
  | { kind: 'assign'; listing: number; agency: number }
  | { kind: 'restore'; listing: number };

export const arbOperation: fc.Arbitrary<Operation> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('create' as const),
      agency: fc.nat(),
      content: fc.nat(),
      status: fc.constantFrom('ACTIVE' as const, 'INACTIVE' as const),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('edit' as const),
      listing: fc.nat(),
      content: fc.nat(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('status' as const),
      listing: fc.nat(),
      status: fc.constantFrom('ACTIVE' as const, 'INACTIVE' as const),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('dismiss' as const), listing: fc.nat() }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('assign' as const),
      listing: fc.nat(),
      agency: fc.nat(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('restore' as const), listing: fc.nat() }) },
);

/** A pool of 1–3 base contents plus spelling variants of them (API representation, no source URL). */
export const arbContentPool: fc.Arbitrary<Record<string, unknown>[]> = fc
  .array(arbRealisticInput(), { minLength: 1, maxLength: 3 })
  .chain((bases) =>
    fc.array(
      fc.tuple(fc.constantFrom(...bases), arbVariantOptions).map(([base, options]) => {
        const { sourceUrl: _ignored, ...rest } = formattingVariant(base, options);
        void _ignored;
        return rest as Record<string, unknown>;
      }),
      { minLength: 1, maxLength: 6 },
    ),
  );

export interface Applied {
  /** Listing the operation wrote, if it succeeded. */
  listingId?: string;
  operation: Operation;
}

/** Applies one operation through the command service; failed commands are skipped. */
export async function applyOperation(
  platform: DuplicatePlatform,
  pool: readonly Record<string, unknown>[],
  operation: Operation,
): Promise<Applied> {
  const ids = platform.listings
    .all()
    .map((item) => item.id)
    .sort();
  const pick = <T>(items: readonly T[], n: number): T | undefined =>
    items[n % Math.max(1, items.length)];
  const contentOf = (n: number) => pick(pool, n) ?? {};
  const byId = async (n: number) => {
    const id = pick(ids, n);
    return id === undefined ? null : platform.get(id);
  };
  const actorFor = (agencyId: string | undefined) =>
    agencyId === undefined ? platformAdmin : member(agencyId);
  const { commands } = platform;

  switch (operation.kind) {
    case 'create': {
      const agencyId = pick(AGENCY_IDS, operation.agency) ?? 'agy-a';
      const result = await commands.create(member(agencyId), {
        content: contentOf(operation.content),
        status: operation.status,
      });
      return { operation, ...(result.ok && { listingId: result.value.id }) };
    }
    case 'edit': {
      const current = await byId(operation.listing);
      if (current === null) return { operation };
      const result = await commands.replaceContent(
        actorFor(current.management.agencyId),
        current.listing.id,
        { content: contentOf(operation.content), baseVersion: current.management.version },
      );
      return { operation, ...(result.ok && { listingId: result.value.id }) };
    }
    case 'status': {
      const current = await byId(operation.listing);
      if (current === null) return { operation };
      const result = await commands.setStatus(
        actorFor(current.management.agencyId),
        current.listing.id,
        { status: operation.status },
      );
      return { operation, ...(result.ok && { listingId: result.value.id }) };
    }
    case 'dismiss': {
      const current = await byId(operation.listing);
      if (current === null) return { operation };
      const result = await commands.dismissFlag(
        actorFor(current.management.agencyId),
        current.listing.id,
        'DUPLICATE',
      );
      return { operation, ...(result.ok && { listingId: result.value.id }) };
    }
    case 'assign': {
      const current = await byId(operation.listing);
      if (current === null) return { operation };
      const agencyId = pick(AGENCY_IDS, operation.agency) ?? 'agy-a';
      const result = await commands.assignAgency(platformAdmin, current.listing.id, {
        agencyId,
        baseVersion: current.management.version,
      });
      return { operation, ...(result.ok && { listingId: result.value.id }) };
    }
    case 'restore': {
      const current = await byId(operation.listing);
      if (current === null) return { operation };
      const result = await commands.restore(
        actorFor(current.management.agencyId),
        current.listing.id,
        { version: 1, baseVersion: current.management.version },
      );
      return { operation, ...(result.ok && { listingId: result.value.id }) };
    }
  }
}
