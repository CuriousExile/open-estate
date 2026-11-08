import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  EntityId,
  IsoDateTime,
  LISTING_BOUNDS,
  VersionNumber,
  type MatchProfile,
} from '@open-estate/shared';
import { z } from 'zod';
import {
  isConditionalCheckFailed,
  type DynamoDbOp,
  type InMemoryOp,
} from '../management/transaction';
import {
  scanCursor,
  scanInMemory,
  scanParameters,
  type ScanPage,
  type ScanRequest,
} from './scan-segment';

// `DuplicateIndex` table (duplicate-detection design: "Duplikat_Index"). One table, three kinds of
// items:
//
//   Profil           pk `L#{listingId}`            sk `P`            Merkmalsprofil, scope, …
//   Block            pk `L#{listingId}`            sk `B#{blockKey}`  gsiBlock, gsiSk
//   Exakt-Schlüssel  pk `X#{scope}#{exactKey}`     sk `X`            listingId (owner)
//   Treffer-Verweis  pk `L#{listingId}`            sk `R#{reportId}`  (deletion of Treffer)
//
// GSI `byBlock` (pk `gsiBlock`, sk `gsiSk` = `{scope}#{createdAt}#{listingId}`, KEYS_ONLY) finds
// the candidates of a block key, inside one Prüfbereich with `begins_with(gsiSk, scope#)` or
// across all of them without. Every write goes through the listing's transaction
// (`VersionedListingWriter`), so the index never lags behind the listing itself — only the GSI
// is eventually consistent, which the strongly consistent exact key covers for Exakt_Duplikate.

export const DUPLICATE_INDEX_PK = 'pk';
export const DUPLICATE_INDEX_SK = 'sk';
export const DUPLICATE_INDEX_BY_BLOCK = 'byBlock';
export const DUPLICATE_INDEX_BLOCK_ATTRIBUTE = 'gsiBlock';
export const DUPLICATE_INDEX_BLOCK_SK_ATTRIBUTE = 'gsiSk';

const PROFILE_SK = 'P';
const EXACT_SK = 'X';
const REPORT_REF_PREFIX = 'R#';
const listingPk = (listingId: string) => `L#${listingId}`;
const blockSk = (key: string) => `B#${key}`;
const reportRefSk = (reportId: string) => `${REPORT_REF_PREFIX}${reportId}`;
const exactPk = (scope: string, exactKey: string) => `X#${scope}#${exactKey}`;
const blockSortKey = (scope: string, createdAt: string, listingId: string) =>
  `${scope}#${createdAt}#${listingId}`;

/** Stored Merkmalsprofil of a listing with what the detector and the Abgleich need around it. */
export interface StoredProfile {
  listingId: string;
  /** Prüfbereich: `agencyScope(agencyId)` (`agency#{id}`, `agency#_none` without agency). */
  scope: string;
  /** Anlagezeitpunkt of the listing (Req 4.3). */
  createdAt: string;
  /** Listing version the profile was written with; the Abgleich conditions on it (Req 10.5). */
  listingVersion: number;
  profile: MatchProfile;
  /** `blockKeys(profile)` at write time; the next write removes exactly these items. */
  blockKeys: string[];
  /** Listings this listing was released against: never Treffer of each other (Req 8.3). */
  dismissed: string[];
  /**
   * The listing owns the exact key of its profile in its Prüfbereich; a write that changes the
   * key or the Prüfbereich releases it. Absent = `false`.
   */
  exactClaimed?: boolean;
  /**
   * Write counter of the profile item, set by `syncOps`. A guarded write only applies while the
   * stored profile is still the one it was based on (the profile also changes without a listing
   * version: Verwerfung, Duplikat_Abgleich).
   */
  revision?: number;
}

/** An item of the Duplikat_Index, as the Duplikat_Abgleich scans it. */
export type DuplicateIndexEntry =
  | { kind: 'profile'; profile: StoredProfile }
  | { kind: 'block'; listingId: string; key: string }
  | { kind: 'exact'; scope: string; exactKey: string; listingId: string }
  | { kind: 'reportRef'; listingId: string; reportId: string };

export interface SyncOptions {
  /**
   * Condition the profile write on the stored profile being `before` (same revision; none for
   * `before = null`); a concurrent change fails the transaction (label `duplicateIndex.profile`).
   */
  guard?: boolean;
}

/** A block hit of the candidate search. */
export interface CandidateRef {
  listingId: string;
  scope: string;
  /** Block key that produced the hit (decides the priority under the candidate limit). */
  key: string;
}

export interface DuplicateIndexStore<Op> {
  /** Profile of a listing, strongly consistent; `null` if none is stored. */
  getProfile(listingId: string): Promise<StoredProfile | null>;
  /**
   * Profiles of several listings, eventually consistent unless `consistent`; unknown ids are
   * absent.
   */
  getProfiles(
    listingIds: readonly string[],
    options?: { consistent?: boolean },
  ): Promise<Map<string, StoredProfile>>;
  /**
   * Listings stored under any of `keys`, via the eventually consistent GSI. With `scope` only
   * listings of that Prüfbereich; without, all of them (agenturübergreifend, Req 11).
   */
  candidates(keys: readonly string[], scope?: string): Promise<CandidateRef[]>;
  /** Owner of an exact key in a Prüfbereich, strongly consistent; `null` if unclaimed. */
  exactOwner(scope: string, exactKey: string): Promise<string | null>;
  /**
   * Operations turning the stored state `before` into `after` (labels `duplicateIndex.profile`,
   * `duplicateIndex.block`): profile put, puts of added or moved blocks, deletes of dropped ones.
   * `after = null` removes the listing's profile and blocks. Exact keys are separate operations.
   */
  syncOps(before: StoredProfile | null, after: StoredProfile | null, options?: SyncOptions): Op[];
  /** Claims an exact key (label `duplicateIndex.exactClaim`); fails if another listing owns it. */
  claimExactOp(scope: string, exactKey: string, listingId: string): Op;
  /** Releases an owned exact key (label `duplicateIndex.exactRelease`); fails unless owned. */
  releaseExactOp(scope: string, exactKey: string, listingId: string): Op;
  /**
   * Removes everything of a deleted listing (duplicate-detection Req 12.3): profile, blocks,
   * Treffer-Verweise and the exact key it owns. Idempotent; `complete` = nothing of the listing is
   * left. Remove the Treffer named by {@link reportRefs} first.
   */
  purgeListing(listingId: string): Promise<{ complete: boolean }>;
  /** Treffer-Verweis of a listing (label `duplicateIndex.reportRef`), for its deletion. */
  reportRefOp(listingId: string, reportId: string): Op;
  /** Treffer the listing is part of, strongly consistent (Req 12.3). */
  reportRefs(listingId: string): Promise<string[]>;
  /** Removes one Treffer-Verweis; idempotent. */
  deleteReportRef(listingId: string, reportId: string): Promise<void>;
  /**
   * Removes an exact key if `listingId` still owns it (Duplikat_Abgleich: the owner is gone or no
   * longer claims it); `false` if another listing owns it or it is gone.
   */
  releaseExact(scope: string, exactKey: string, listingId: string): Promise<boolean>;
  /** One page of a parallel scan over all items (Duplikat_Abgleich, Req 10.4, 12.4). */
  scan(request: ScanRequest): Promise<ScanPage<DuplicateIndexEntry>>;
}

// ---------------------------------------------------------------------------------------------
// Validation of stored items
// ---------------------------------------------------------------------------------------------

const hash = z.string().regex(/^[0-9a-f]+$/);
const ListingIdSchema = z.string().min(LISTING_BOUNDS.id.min).max(LISTING_BOUNDS.id.max);

const MatchProfileSchema: z.ZodType<MatchProfile> = z.object({
  rules: hash,
  country: z.string(),
  postalCode: z.string(),
  group: z.string(),
  listingType: z.string(),
  offers: z.array(
    z.object({
      type: z.enum(['SALE', 'RENT']),
      amountMinor: z.int().min(0),
      currency: z.string(),
    }),
  ),
  areaMinor: z.int().min(0),
  rooms: z.number(),
  addressHash: hash.optional(),
  unitHash: hash.optional(),
  parcelHash: hash.optional(),
  floor: z.int().optional(),
  totalFloors: z.int().optional(),
  yearBuilt: z.int().optional(),
  plotAreaMinor: z.int().optional(),
  bedrooms: z.int().optional(),
  bathrooms: z.int().optional(),
  geo: z.object({ lat: z.number(), lon: z.number() }).optional(),
  sourceUrlHash: hash.optional(),
  mediaHashes: z.array(hash),
  titleSig: hash,
  descriptionSig: hash,
  exactKey: hash,
}) as z.ZodType<MatchProfile>;

const StoredProfileSchema: z.ZodType<StoredProfile> = z.object({
  listingId: ListingIdSchema,
  scope: z.string().regex(/^agency#/),
  createdAt: IsoDateTime,
  listingVersion: VersionNumber,
  profile: MatchProfileSchema,
  blockKeys: z.array(z.string().min(1)),
  dismissed: z.array(ListingIdSchema),
  exactClaimed: z.boolean().optional(),
  revision: z.int().min(1).optional(),
}) as z.ZodType<StoredProfile>;

/**
 * Validates a profile before it is stored or after it is read; malformed data throws. Unknown
 * attributes such as the table keys `pk`/`sk` are stripped.
 */
export const parseStoredProfile = (value: unknown): StoredProfile =>
  StoredProfileSchema.parse(value);

/** Profile as written by `syncOps`: the next revision after `before`. */
function nextRevision(before: StoredProfile | null, after: StoredProfile): StoredProfile {
  return parseStoredProfile({ ...after, revision: (before?.revision ?? 0) + 1 });
}

/** `X#{scope}#{exactKey}` → parts; scopes are `agency#{id}` and ids contain no `#`. */
function parseExactPk(pk: string): { scope: string; exactKey: string } | null {
  const parts = pk.split('#');
  if (parts.length !== 4 || parts[0] !== 'X') return null;
  return { scope: `${parts[1]}#${parts[2]}`, exactKey: String(parts[3]) };
}

/** Agency of a scope, as written by `agencyScope` (`undefined` for `agency#_none`). */
export function scopeAgency(scope: string): string | undefined {
  const agency = scope.slice('agency#'.length);
  return agency === '_none' ? undefined : EntityId.parse(agency);
}

// ---------------------------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------------------------

interface BlockEntry {
  listingId: string;
  scope: string;
  sortKey: string;
}

/**
 * Fake with transaction semantics via `InMemoryTransactor`. With `lagging: true` the candidate
 * search sees block changes only after {@link flushIndex}, like the eventually consistent GSI —
 * Property 15 relies on that to exercise the exact-key guard against concurrent creations.
 */
export class InMemoryDuplicateIndexStore implements DuplicateIndexStore<InMemoryOp> {
  private readonly profiles = new Map<string, StoredProfile>();
  /** Table truth: block key → listing id → entry. */
  private readonly blocks = new Map<string, Map<string, BlockEntry>>();
  /** What the GSI shows; equal to `blocks` unless lagging. */
  private visibleBlocks = new Map<string, Map<string, BlockEntry>>();
  private readonly exact = new Map<string, string>();
  /** Listing id → ids of the Treffer it is part of. */
  private readonly reportRefsOf = new Map<string, Set<string>>();
  private readonly lagging: boolean;

  constructor(options: { lagging?: boolean } = {}) {
    this.lagging = options.lagging ?? false;
  }

  async getProfile(listingId: string): Promise<StoredProfile | null> {
    const stored = this.profiles.get(listingId);
    return stored === undefined ? null : structuredClone(stored);
  }

  /** The fake's table is always consistent; `options.consistent` changes nothing here. */
  async getProfiles(listingIds: readonly string[]): Promise<Map<string, StoredProfile>> {
    const found = new Map<string, StoredProfile>();
    for (const id of new Set(listingIds)) {
      const stored = this.profiles.get(id);
      if (stored !== undefined) found.set(id, structuredClone(stored));
    }
    return found;
  }

  async candidates(keys: readonly string[], scope?: string): Promise<CandidateRef[]> {
    const refs: CandidateRef[] = [];
    for (const key of new Set(keys)) {
      const entries = [...(this.visibleBlocks.get(key)?.values() ?? [])].sort((a, b) =>
        a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0,
      );
      for (const entry of entries) {
        if (scope === undefined || entry.scope === scope) {
          refs.push({ listingId: entry.listingId, scope: entry.scope, key });
        }
      }
    }
    return refs;
  }

  async exactOwner(scope: string, exactKey: string): Promise<string | null> {
    return this.exact.get(exactPk(scope, exactKey)) ?? null;
  }

  syncOps(
    before: StoredProfile | null,
    after: StoredProfile | null,
    options: SyncOptions = {},
  ): InMemoryOp[] {
    const listingId = after?.listingId ?? before?.listingId;
    if (listingId === undefined) return [];
    const stored = after === null ? null : structuredClone(nextRevision(before, after));
    const ops: InMemoryOp[] = [
      {
        label: 'duplicateIndex.profile',
        target: `DuplicateIndex#${listingPk(listingId)}#${PROFILE_SK}`,
        check: () => {
          if (options.guard !== true) return true;
          const current = this.profiles.get(listingId);
          return before === null
            ? current === undefined
            : current !== undefined && current.revision === before.revision;
        },
        apply: () => {
          if (stored === null) this.profiles.delete(listingId);
          else this.profiles.set(listingId, stored);
        },
      },
    ];
    for (const change of blockChanges(before, after)) {
      ops.push({
        label: 'duplicateIndex.block',
        target: `DuplicateIndex#${listingPk(listingId)}#${blockSk(change.key)}`,
        check: () => true,
        apply: () => {
          const entries = this.blocks.get(change.key) ?? new Map<string, BlockEntry>();
          if (change.entry === null) entries.delete(listingId);
          else entries.set(listingId, change.entry);
          if (entries.size === 0) this.blocks.delete(change.key);
          else this.blocks.set(change.key, entries);
          if (!this.lagging) this.flushIndex();
        },
      });
    }
    return ops;
  }

  claimExactOp(scope: string, exactKey: string, listingId: string): InMemoryOp {
    const key = exactPk(scope, exactKey);
    return {
      label: 'duplicateIndex.exactClaim',
      target: `DuplicateIndex#${key}#${EXACT_SK}`,
      check: () => {
        const owner = this.exact.get(key);
        return owner === undefined || owner === listingId;
      },
      apply: () => {
        this.exact.set(key, listingId);
      },
    };
  }

  releaseExactOp(scope: string, exactKey: string, listingId: string): InMemoryOp {
    const key = exactPk(scope, exactKey);
    return {
      label: 'duplicateIndex.exactRelease',
      target: `DuplicateIndex#${key}#${EXACT_SK}`,
      check: () => this.exact.get(key) === listingId,
      apply: () => {
        this.exact.delete(key);
      },
    };
  }

  async purgeListing(listingId: string): Promise<{ complete: boolean }> {
    const stored = this.profiles.get(listingId);
    if (stored?.exactClaimed === true) {
      const key = exactPk(stored.scope, stored.profile.exactKey);
      if (this.exact.get(key) === listingId) this.exact.delete(key);
    }
    this.profiles.delete(listingId);
    for (const [key, entries] of this.blocks) {
      entries.delete(listingId);
      if (entries.size === 0) this.blocks.delete(key);
    }
    this.reportRefsOf.delete(listingId);
    if (!this.lagging) this.flushIndex();
    return { complete: true };
  }

  reportRefOp(listingId: string, reportId: string): InMemoryOp {
    return {
      label: 'duplicateIndex.reportRef',
      target: `DuplicateIndex#${listingPk(listingId)}#${reportRefSk(reportId)}`,
      check: () => true,
      apply: () => {
        const refs = this.reportRefsOf.get(listingId) ?? new Set<string>();
        refs.add(reportId);
        this.reportRefsOf.set(listingId, refs);
      },
    };
  }

  async reportRefs(listingId: string): Promise<string[]> {
    return [...(this.reportRefsOf.get(listingId) ?? [])].sort();
  }

  async deleteReportRef(listingId: string, reportId: string): Promise<void> {
    const refs = this.reportRefsOf.get(listingId);
    refs?.delete(reportId);
    if (refs?.size === 0) this.reportRefsOf.delete(listingId);
  }

  async releaseExact(scope: string, exactKey: string, listingId: string): Promise<boolean> {
    const key = exactPk(scope, exactKey);
    if (this.exact.get(key) !== listingId) return false;
    this.exact.delete(key);
    return true;
  }

  async scan(request: ScanRequest): Promise<ScanPage<DuplicateIndexEntry>> {
    const entries: { key: string; entry: DuplicateIndexEntry }[] = [];
    for (const profile of this.profiles.values()) {
      entries.push({
        key: `${listingPk(profile.listingId)}|${PROFILE_SK}`,
        entry: { kind: 'profile', profile: structuredClone(profile) },
      });
    }
    for (const [key, listings] of this.blocks) {
      for (const listingId of listings.keys()) {
        entries.push({
          key: `${listingPk(listingId)}|${blockSk(key)}`,
          entry: { kind: 'block', listingId, key },
        });
      }
    }
    for (const [pk, listingId] of this.exact) {
      const parsed = parseExactPk(pk);
      if (parsed !== null) {
        entries.push({ key: `${pk}|${EXACT_SK}`, entry: { kind: 'exact', ...parsed, listingId } });
      }
    }
    for (const [listingId, refs] of this.reportRefsOf) {
      for (const reportId of refs) {
        entries.push({
          key: `${listingPk(listingId)}|${reportRefSk(reportId)}`,
          entry: { kind: 'reportRef', listingId, reportId },
        });
      }
    }
    const page = scanInMemory(
      entries,
      (item) => item.key,
      request,
      (item) => item.key.slice(0, item.key.indexOf('|')),
    );
    return {
      items: page.items.map((item) => item.entry),
      ...(page.cursor !== undefined && { cursor: page.cursor }),
    };
  }

  /** Makes every block change visible to the candidate search (the GSI caught up). */
  flushIndex(): void {
    this.visibleBlocks = new Map(
      [...this.blocks].map(([key, entries]) => [key, new Map(entries)] as const),
    );
  }

  /** Everything stored, for assertions in tests. */
  snapshot(): {
    profiles: StoredProfile[];
    blocks: { key: string; listingId: string; scope: string }[];
    exact: { key: string; listingId: string }[];
    reportRefs: { listingId: string; reportId: string }[];
  } {
    const byKey = <T extends { key: string }>(a: T, b: T) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    return {
      reportRefs: [...this.reportRefsOf]
        .flatMap(([listingId, refs]) => [...refs].map((reportId) => ({ listingId, reportId })))
        .sort((a, b) =>
          a.listingId === b.listingId
            ? a.reportId < b.reportId
              ? -1
              : 1
            : a.listingId < b.listingId
              ? -1
              : 1,
        ),
      profiles: [...this.profiles.values()]
        .map((profile) => structuredClone(profile))
        .sort((a, b) => (a.listingId < b.listingId ? -1 : 1)),
      blocks: [...this.blocks]
        .flatMap(([key, entries]) =>
          [...entries.values()].map(({ listingId, scope }) => ({ key, listingId, scope })),
        )
        .sort((a, b) => byKey(a, b) || (a.listingId < b.listingId ? -1 : 1)),
      exact: [...this.exact].map(([key, listingId]) => ({ key, listingId })).sort(byKey),
    };
  }
}

/** Block entry of a stored state. */
const blockEntry = (state: StoredProfile): BlockEntry => ({
  listingId: state.listingId,
  scope: state.scope,
  sortKey: blockSortKey(state.scope, state.createdAt, state.listingId),
});

/**
 * Block puts (entry) and deletes (`null`) between two stored states. A key kept with the same
 * sort key needs no write — which also keeps every item at most once per transaction.
 */
function blockChanges(
  before: StoredProfile | null,
  after: StoredProfile | null,
): { key: string; entry: BlockEntry | null }[] {
  const previousKeys = new Set(before?.blockKeys ?? []);
  const nextKeys = new Set(after?.blockKeys ?? []);
  const changes: { key: string; entry: BlockEntry | null }[] = [];
  if (after !== null) {
    const entry = blockEntry(after);
    const moved = before === null || blockEntry(before).sortKey !== entry.sortKey;
    for (const key of nextKeys) {
      if (moved || !previousKeys.has(key)) changes.push({ key, entry });
    }
  }
  for (const key of previousKeys) if (!nextKeys.has(key)) changes.push({ key, entry: null });
  return changes;
}

// ---------------------------------------------------------------------------------------------
// DynamoDB
// ---------------------------------------------------------------------------------------------

/** Condition of a guarded profile write: the stored profile is still `before`. */
function profileGuard(before: StoredProfile | null): {
  ConditionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
} {
  if (before === null) {
    return {
      ConditionExpression: 'attribute_not_exists(#pk)',
      ExpressionAttributeNames: { '#pk': DUPLICATE_INDEX_PK },
    };
  }
  if (before.revision === undefined) {
    return {
      ConditionExpression: 'attribute_exists(#pk) AND attribute_not_exists(#revision)',
      ExpressionAttributeNames: { '#pk': DUPLICATE_INDEX_PK, '#revision': 'revision' },
    };
  }
  return {
    ConditionExpression: '#revision = :revision',
    ExpressionAttributeNames: { '#revision': 'revision' },
    ExpressionAttributeValues: { ':revision': before.revision },
  };
}

/** Scanned item → entry; unknown layouts are skipped. */
function indexEntryOf(item: Record<string, unknown>): DuplicateIndexEntry | null {
  const pk = String(item[DUPLICATE_INDEX_PK] ?? '');
  const sk = String(item[DUPLICATE_INDEX_SK] ?? '');
  if (pk.startsWith('X#') && sk === EXACT_SK) {
    const parsed = parseExactPk(pk);
    return parsed === null
      ? null
      : { kind: 'exact', ...parsed, listingId: ListingIdSchema.parse(item['listingId']) };
  }
  if (!pk.startsWith('L#')) return null;
  const listingId = pk.slice('L#'.length);
  if (sk === PROFILE_SK) return { kind: 'profile', profile: parseStoredProfile(item) };
  if (sk.startsWith('B#')) return { kind: 'block', listingId, key: sk.slice('B#'.length) };
  if (sk.startsWith(REPORT_REF_PREFIX)) {
    return { kind: 'reportRef', listingId, reportId: sk.slice(REPORT_REF_PREFIX.length) };
  }
  return null;
}

export interface DynamoDbDuplicateIndexStoreOptions {
  client: DynamoDBDocumentClient;
  /** `DuplicateIndex` table; keys `pk`/`sk`, GSI `byBlock`. */
  tableName: string;
}

/** BatchGetItem reads at most 100 keys per request. */
const BATCH_GET_LIMIT = 100;
/** Retries of unprocessed keys before giving up (throttling). */
const MAX_BATCH_RETRIES = 5;
/** BatchWriteItem accepts at most 25 requests. */
const BATCH_WRITE_LIMIT = 25;

export class DynamoDbDuplicateIndexStore implements DuplicateIndexStore<DynamoDbOp> {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor({ client, tableName }: DynamoDbDuplicateIndexStoreOptions) {
    this.client = client;
    this.tableName = tableName;
  }

  async getProfile(listingId: string): Promise<StoredProfile | null> {
    const out = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { [DUPLICATE_INDEX_PK]: listingPk(listingId), [DUPLICATE_INDEX_SK]: PROFILE_SK },
        ConsistentRead: true,
      }),
    );
    return out.Item === undefined ? null : parseStoredProfile(out.Item);
  }

  async getProfiles(
    listingIds: readonly string[],
    options: { consistent?: boolean } = {},
  ): Promise<Map<string, StoredProfile>> {
    const found = new Map<string, StoredProfile>();
    const ids = [...new Set(listingIds)];
    for (let start = 0; start < ids.length; start += BATCH_GET_LIMIT) {
      let keys: Record<string, unknown>[] = ids
        .slice(start, start + BATCH_GET_LIMIT)
        .map((id) => ({ [DUPLICATE_INDEX_PK]: listingPk(id), [DUPLICATE_INDEX_SK]: PROFILE_SK }));
      for (let attempt = 0; keys.length > 0; attempt += 1) {
        if (attempt > MAX_BATCH_RETRIES) throw new Error('DuplicateIndex: unprocessed keys remain');
        const out = await this.client.send(
          new BatchGetCommand({
            RequestItems: {
              [this.tableName]: {
                Keys: keys,
                ...(options.consistent === true && { ConsistentRead: true }),
              },
            },
          }),
        );
        for (const item of out.Responses?.[this.tableName] ?? []) {
          const profile = parseStoredProfile(item);
          found.set(profile.listingId, profile);
        }
        keys = (out.UnprocessedKeys?.[this.tableName]?.Keys ?? []) as Record<string, unknown>[];
      }
    }
    return found;
  }

  async candidates(keys: readonly string[], scope?: string): Promise<CandidateRef[]> {
    const results = await Promise.all([...new Set(keys)].map((key) => this.queryBlock(key, scope)));
    return results.flat();
  }

  /** Every hit of one block key, all pages. */
  private async queryBlock(key: string, scope: string | undefined): Promise<CandidateRef[]> {
    const refs: CandidateRef[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const out = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: DUPLICATE_INDEX_BY_BLOCK,
          KeyConditionExpression:
            scope === undefined
              ? '#block = :block'
              : '#block = :block AND begins_with(#sk, :scope)',
          ExpressionAttributeNames: {
            '#block': DUPLICATE_INDEX_BLOCK_ATTRIBUTE,
            ...(scope !== undefined && { '#sk': DUPLICATE_INDEX_BLOCK_SK_ATTRIBUTE }),
          },
          ExpressionAttributeValues: {
            ':block': key,
            ...(scope !== undefined && { ':scope': `${scope}#` }),
          },
          ...(startKey !== undefined && { ExclusiveStartKey: startKey }),
        }),
      );
      for (const item of out.Items ?? []) {
        const pk = String(item[DUPLICATE_INDEX_PK] ?? '');
        const sortKey = String(item[DUPLICATE_INDEX_BLOCK_SK_ATTRIBUTE] ?? '');
        // `agency#{id}#…`: the scope is the first two segments (agency ids contain no `#`).
        const itemScope = sortKey.split('#').slice(0, 2).join('#');
        refs.push({ listingId: pk.slice('L#'.length), scope: itemScope, key });
      }
      startKey = out.LastEvaluatedKey;
    } while (startKey !== undefined);
    return refs;
  }

  async exactOwner(scope: string, exactKey: string): Promise<string | null> {
    const out = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { [DUPLICATE_INDEX_PK]: exactPk(scope, exactKey), [DUPLICATE_INDEX_SK]: EXACT_SK },
        ConsistentRead: true,
      }),
    );
    return out.Item === undefined
      ? null
      : z.object({ listingId: ListingIdSchema }).parse(out.Item).listingId;
  }

  syncOps(
    before: StoredProfile | null,
    after: StoredProfile | null,
    options: SyncOptions = {},
  ): DynamoDbOp[] {
    const listingId = after?.listingId ?? before?.listingId;
    if (listingId === undefined) return [];
    const pk = listingPk(listingId);
    const guard = options.guard === true ? profileGuard(before) : {};
    const ops: DynamoDbOp[] = [
      after === null
        ? {
            label: 'duplicateIndex.profile',
            item: {
              Delete: {
                TableName: this.tableName,
                Key: { [DUPLICATE_INDEX_PK]: pk, [DUPLICATE_INDEX_SK]: PROFILE_SK },
                ...guard,
              },
            },
          }
        : {
            label: 'duplicateIndex.profile',
            item: {
              Put: {
                TableName: this.tableName,
                Item: {
                  [DUPLICATE_INDEX_PK]: pk,
                  [DUPLICATE_INDEX_SK]: PROFILE_SK,
                  ...nextRevision(before, after),
                },
                ...guard,
              },
            },
          },
    ];
    for (const change of blockChanges(before, after)) {
      const key = { [DUPLICATE_INDEX_PK]: pk, [DUPLICATE_INDEX_SK]: blockSk(change.key) };
      ops.push(
        change.entry === null
          ? {
              label: 'duplicateIndex.block',
              item: { Delete: { TableName: this.tableName, Key: key } },
            }
          : {
              label: 'duplicateIndex.block',
              item: {
                Put: {
                  TableName: this.tableName,
                  Item: {
                    ...key,
                    [DUPLICATE_INDEX_BLOCK_ATTRIBUTE]: change.key,
                    [DUPLICATE_INDEX_BLOCK_SK_ATTRIBUTE]: change.entry.sortKey,
                  },
                },
              },
            },
      );
    }
    return ops;
  }

  async purgeListing(listingId: string): Promise<{ complete: boolean }> {
    const pk = listingPk(listingId);
    const items = await this.itemsOf(pk);
    // The exact key first: if the purge stops midway, the profile that names it is still there.
    const profile = items.find((item) => item[DUPLICATE_INDEX_SK] === PROFILE_SK);
    if (profile !== undefined) {
      const stored = parseStoredProfile(profile);
      if (stored.exactClaimed === true) {
        try {
          await this.client.send(
            new DeleteCommand({
              TableName: this.tableName,
              Key: {
                [DUPLICATE_INDEX_PK]: exactPk(stored.scope, stored.profile.exactKey),
                [DUPLICATE_INDEX_SK]: EXACT_SK,
              },
              ConditionExpression: '#listingId = :listingId',
              ExpressionAttributeNames: { '#listingId': 'listingId' },
              ExpressionAttributeValues: { ':listingId': listingId },
            }),
          );
        } catch (error) {
          // Owned by another listing meanwhile, or already gone: nothing of ours to remove.
          if (!isConditionalCheckFailed(error)) throw error;
        }
      }
    }
    const keys = items.map((item) => ({
      [DUPLICATE_INDEX_PK]: pk,
      [DUPLICATE_INDEX_SK]: String(item[DUPLICATE_INDEX_SK]),
    }));
    for (let start = 0; start < keys.length; start += BATCH_WRITE_LIMIT) {
      let requests = keys
        .slice(start, start + BATCH_WRITE_LIMIT)
        .map((Key) => ({ DeleteRequest: { Key } }));
      for (let attempt = 0; requests.length > 0 && attempt <= MAX_BATCH_RETRIES; attempt += 1) {
        const out = await this.client.send(
          new BatchWriteCommand({ RequestItems: { [this.tableName]: requests } }),
        );
        requests = (out.UnprocessedItems?.[this.tableName] ?? []) as typeof requests;
      }
    }
    return { complete: (await this.itemsOf(pk, 1)).length === 0 };
  }

  /** Items of one listing partition (strongly consistent), at most `limit` if given. */
  private async itemsOf(pk: string, limit?: number): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const out = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': DUPLICATE_INDEX_PK },
          ExpressionAttributeValues: { ':pk': pk },
          ConsistentRead: true,
          ...(limit !== undefined && { Limit: limit }),
          ...(startKey !== undefined && { ExclusiveStartKey: startKey }),
        }),
      );
      items.push(...(out.Items ?? []));
      startKey = limit !== undefined && items.length >= limit ? undefined : out.LastEvaluatedKey;
    } while (startKey !== undefined);
    return items;
  }

  reportRefOp(listingId: string, reportId: string): DynamoDbOp {
    return {
      label: 'duplicateIndex.reportRef',
      item: {
        Put: {
          TableName: this.tableName,
          Item: {
            [DUPLICATE_INDEX_PK]: listingPk(listingId),
            [DUPLICATE_INDEX_SK]: reportRefSk(reportId),
          },
        },
      },
    };
  }

  async reportRefs(listingId: string): Promise<string[]> {
    const ids: string[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const out = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
          ExpressionAttributeNames: { '#pk': DUPLICATE_INDEX_PK, '#sk': DUPLICATE_INDEX_SK },
          ExpressionAttributeValues: { ':pk': listingPk(listingId), ':prefix': REPORT_REF_PREFIX },
          ConsistentRead: true,
          ...(startKey !== undefined && { ExclusiveStartKey: startKey }),
        }),
      );
      for (const item of out.Items ?? []) {
        ids.push(String(item[DUPLICATE_INDEX_SK]).slice(REPORT_REF_PREFIX.length));
      }
      startKey = out.LastEvaluatedKey;
    } while (startKey !== undefined);
    return ids;
  }

  async deleteReportRef(listingId: string, reportId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          [DUPLICATE_INDEX_PK]: listingPk(listingId),
          [DUPLICATE_INDEX_SK]: reportRefSk(reportId),
        },
      }),
    );
  }

  async releaseExact(scope: string, exactKey: string, listingId: string): Promise<boolean> {
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { [DUPLICATE_INDEX_PK]: exactPk(scope, exactKey), [DUPLICATE_INDEX_SK]: EXACT_SK },
          ConditionExpression: '#listingId = :listingId',
          ExpressionAttributeNames: { '#listingId': 'listingId' },
          ExpressionAttributeValues: { ':listingId': listingId },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailed(error)) return false;
      throw error;
    }
  }

  async scan(request: ScanRequest): Promise<ScanPage<DuplicateIndexEntry>> {
    const out = await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
        ConsistentRead: true,
        ...scanParameters(request),
      }),
    );
    const items: DuplicateIndexEntry[] = [];
    for (const item of out.Items ?? []) {
      const entry = indexEntryOf(item);
      if (entry !== null) items.push(entry);
    }
    return { items, ...scanCursor(out.LastEvaluatedKey) };
  }

  claimExactOp(scope: string, exactKey: string, listingId: string): DynamoDbOp {
    return {
      label: 'duplicateIndex.exactClaim',
      item: {
        Put: {
          TableName: this.tableName,
          Item: {
            [DUPLICATE_INDEX_PK]: exactPk(scope, exactKey),
            [DUPLICATE_INDEX_SK]: EXACT_SK,
            listingId,
          },
          ConditionExpression: 'attribute_not_exists(#pk) OR #listingId = :listingId',
          ExpressionAttributeNames: { '#pk': DUPLICATE_INDEX_PK, '#listingId': 'listingId' },
          ExpressionAttributeValues: { ':listingId': listingId },
        },
      },
    };
  }

  releaseExactOp(scope: string, exactKey: string, listingId: string): DynamoDbOp {
    return {
      label: 'duplicateIndex.exactRelease',
      item: {
        Delete: {
          TableName: this.tableName,
          Key: { [DUPLICATE_INDEX_PK]: exactPk(scope, exactKey), [DUPLICATE_INDEX_SK]: EXACT_SK },
          ConditionExpression: '#listingId = :listingId',
          ExpressionAttributeNames: { '#listingId': 'listingId' },
          ExpressionAttributeValues: { ':listingId': listingId },
        },
      },
    };
  }
}
