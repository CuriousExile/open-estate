import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3';
import {
  BatchWriteCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  LISTING_VERSIONS_PK_ATTRIBUTE,
  LISTING_VERSIONS_SK_ATTRIBUTE,
  type InMemoryListingVersionStore,
} from '../management/listing-version-store';
import { agencyScope, type MetricCounterIncrement } from '../management/metric-counter-store';
import { snapshotPrefix, type InMemorySnapshotStore } from '../management/snapshot-store';
import { LISTING_COUNTER_CODES } from '../management/versioned-listing-writer';

// Removal of a listing's version history for a deletion request (design: "Löschprozess-
// Erweiterung", Req 6.8, 9.2, 9.5): all `ListingVersions` items (Query + BatchWriteItem) and all
// snapshots under `listings/{id}/` (ListObjectsV2 + DeleteObjects). Diffs are never stored, so
// removing the snapshots removes every diff too. The bucket has no versioning, so a deleted
// object is gone for good.

/** History counted for one owning agency of the listing's versions (Req 14.5). */
export interface HistoryUsage {
  /** Agency the versions were counted for; absent = no agency (`agency#_none`). */
  agencyId?: string;
  /** Number of versions (`history.version_count`). */
  versions: number;
  /** Bytes of the snapshots these versions created (`history.storage_bytes`, `newSnapshot`). */
  storageBytes: number;
}

export interface HistoryPurgeResult {
  /** `true` once neither a version nor a snapshot of the listing exists anymore. */
  complete: boolean;
}

export interface ListingHistoryStore {
  /** Version count and new-snapshot bytes per agency, as the `VersionedListingWriter` counted. */
  usage(listingId: string): Promise<HistoryUsage[]>;
  /**
   * Deletes every version and snapshot of the listing, then checks that none remains. Leftovers
   * (unprocessed batch items, failed object deletes) are not an error: the result is incomplete.
   */
  purge(listingId: string): Promise<HistoryPurgeResult>;
}

/** Live state of the listing whose counters a deletion reverses. */
export interface DeletedListingState {
  /** Absent for items without management data (counted nowhere). */
  status?: string;
  agencyId?: string;
  /** Markierungscodes; a Duplikat_Markierung is counted in `listing.flags.DUPLICATE`. */
  flagCodes?: readonly string[];
}

/**
 * Counter deltas of a deletion, summed per counter: the inventory counter of the listing's agency
 * and status, and per agency the version count and snapshot bytes of its history — exactly the
 * increments the writer made, so counters equal those recomputed from the remaining inventory
 * (Property 26). Daily change counters are history and stay.
 */
export function deletionCounterDecrements(
  listing: DeletedListingState,
  usage: readonly HistoryUsage[],
): MetricCounterIncrement[] {
  const sums = new Map<string, MetricCounterIncrement>();
  const add = (scope: string, code: string, delta: number) => {
    const key = `${scope}|${code}`;
    sums.set(key, { scope, code, delta: (sums.get(key)?.delta ?? 0) + delta });
  };
  if (listing.status !== undefined) {
    add(agencyScope(listing.agencyId), LISTING_COUNTER_CODES.status(listing.status), -1);
  }
  // The writer counted a flagged listing (duplicate-detection Req 14.5).
  if (listing.flagCodes?.includes('DUPLICATE') === true) {
    add(agencyScope(listing.agencyId), LISTING_COUNTER_CODES.duplicateFlags, -1);
  }
  for (const { agencyId, versions, storageBytes } of usage) {
    add(agencyScope(agencyId), LISTING_COUNTER_CODES.versionCount, -versions);
    add(agencyScope(agencyId), LISTING_COUNTER_CODES.storageBytes, -storageBytes);
  }
  return [...sums.values()].filter((increment) => increment.delta !== 0);
}

interface VersionUsageItem {
  agencyId?: string;
  snapshotBytes: number;
  newSnapshot: boolean;
}

/** Groups version items per agency (stable order: first appearance). */
function summarize(items: Iterable<VersionUsageItem>): HistoryUsage[] {
  const byAgency = new Map<string | undefined, HistoryUsage>();
  for (const { agencyId, snapshotBytes, newSnapshot } of items) {
    const usage = byAgency.get(agencyId) ?? {
      ...(agencyId !== undefined && { agencyId }),
      versions: 0,
      storageBytes: 0,
    };
    usage.versions += 1;
    if (newSnapshot) usage.storageBytes += snapshotBytes;
    byAgency.set(agencyId, usage);
  }
  return [...byAgency.values()];
}

// ---------------------------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------------------------

/** Fake over the in-memory version and snapshot stores the writer uses. */
export class InMemoryListingHistoryStore implements ListingHistoryStore {
  private readonly versions: InMemoryListingVersionStore;
  private readonly snapshots: InMemorySnapshotStore;

  constructor({
    versions,
    snapshots,
  }: {
    versions: InMemoryListingVersionStore;
    snapshots: InMemorySnapshotStore;
  }) {
    this.versions = versions;
    this.snapshots = snapshots;
  }

  async usage(listingId: string): Promise<HistoryUsage[]> {
    return summarize(this.versions.all().filter((record) => record.listingId === listingId));
  }

  async purge(listingId: string): Promise<HistoryPurgeResult> {
    this.versions.removeListing(listingId);
    this.snapshots.removePrefix(snapshotPrefix(listingId));
    return { complete: await this.isEmpty(listingId) };
  }

  private async isEmpty(listingId: string): Promise<boolean> {
    const prefix = snapshotPrefix(listingId);
    const versions = this.versions.all().some((record) => record.listingId === listingId);
    return !versions && !this.snapshots.keys().some((key) => key.startsWith(prefix));
  }
}

// ---------------------------------------------------------------------------------------------
// DynamoDB + S3
// ---------------------------------------------------------------------------------------------

/** `BatchWriteItem` accepts at most 25 requests. */
const BATCH_WRITE_LIMIT = 25;
/** Attempts per batch for `UnprocessedItems` (throttling) before the purge counts incomplete. */
const MAX_BATCH_ATTEMPTS = 4;

type VersionKey = Record<string, unknown>;

export interface DynamoDbS3ListingHistoryStoreOptions {
  client: DynamoDBDocumentClient;
  /** `ListingVersions` table; PK `listingId`, SK `version`. */
  versionsTable: string;
  /** `VersionSnapshots` bucket. */
  bucketName: string;
  /** Defaults to a client of the Lambda's region (the caller need not depend on the S3 SDK). */
  s3?: S3Client;
  /** Base delay between `UnprocessedItems` retries (linear backoff); 0 in tests. */
  retryDelayMs?: number;
}

export class DynamoDbS3ListingHistoryStore implements ListingHistoryStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly versionsTable: string;
  private readonly bucketName: string;
  private readonly s3: S3Client;
  private readonly retryDelayMs: number;

  constructor(options: DynamoDbS3ListingHistoryStoreOptions) {
    this.client = options.client;
    this.versionsTable = options.versionsTable;
    this.bucketName = options.bucketName;
    this.s3 = options.s3 ?? new S3Client({});
    this.retryDelayMs = options.retryDelayMs ?? 100;
  }

  async usage(listingId: string): Promise<HistoryUsage[]> {
    const items: VersionUsageItem[] = [];
    for await (const page of this.versionPages(listingId, '#agencyId, #bytes, #new')) {
      for (const item of page) {
        const agencyId = item['agencyId'];
        items.push({
          ...(typeof agencyId === 'string' && { agencyId }),
          snapshotBytes: Number(item['snapshotBytes'] ?? 0),
          newSnapshot: item['newSnapshot'] === true,
        });
      }
    }
    return summarize(items);
  }

  async purge(listingId: string): Promise<HistoryPurgeResult> {
    let complete = await this.deleteVersions(listingId);
    complete = (await this.deleteSnapshots(listingId)) && complete;
    // Verify instead of trusting the delete responses: a version written concurrently before the
    // block, or an object listed after a page boundary, must not be missed (Req 9.5).
    return { complete: complete && (await this.isEmpty(listingId)) };
  }

  /** Pages of version items (keys plus `extraProjection`), strongly consistent. */
  private async *versionPages(
    listingId: string,
    extraProjection?: string,
  ): AsyncGenerator<Record<string, unknown>[]> {
    let startKey: VersionKey | undefined;
    do {
      const out = await this.client.send(
        new QueryCommand({
          TableName: this.versionsTable,
          KeyConditionExpression: '#pk = :pk',
          ProjectionExpression: `#pk, #sk${extraProjection === undefined ? '' : `, ${extraProjection}`}`,
          ExpressionAttributeNames: {
            '#pk': LISTING_VERSIONS_PK_ATTRIBUTE,
            '#sk': LISTING_VERSIONS_SK_ATTRIBUTE,
            ...(extraProjection !== undefined && {
              '#agencyId': 'agencyId',
              '#bytes': 'snapshotBytes',
              '#new': 'newSnapshot',
            }),
          },
          ExpressionAttributeValues: { ':pk': listingId },
          ConsistentRead: true,
          ...(startKey !== undefined && { ExclusiveStartKey: startKey }),
        }),
      );
      yield out.Items ?? [];
      startKey = out.LastEvaluatedKey;
    } while (startKey !== undefined);
  }

  /** `false` if some versions could not be deleted (still unprocessed after the retries). */
  private async deleteVersions(listingId: string): Promise<boolean> {
    let complete = true;
    for await (const page of this.versionPages(listingId)) {
      for (let i = 0; i < page.length; i += BATCH_WRITE_LIMIT) {
        const keys = page.slice(i, i + BATCH_WRITE_LIMIT).map((item) => ({
          [LISTING_VERSIONS_PK_ATTRIBUTE]: item[LISTING_VERSIONS_PK_ATTRIBUTE],
          [LISTING_VERSIONS_SK_ATTRIBUTE]: item[LISTING_VERSIONS_SK_ATTRIBUTE],
        }));
        complete = (await this.batchDelete(keys)) && complete;
      }
    }
    return complete;
  }

  private async batchDelete(keys: VersionKey[]): Promise<boolean> {
    let pending = keys.map((Key) => ({ DeleteRequest: { Key } }));
    for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt += 1) {
      const out = await this.client.send(
        new BatchWriteCommand({ RequestItems: { [this.versionsTable]: pending } }),
      );
      const unprocessed = out.UnprocessedItems?.[this.versionsTable] ?? [];
      if (unprocessed.length === 0) return true;
      pending = unprocessed as typeof pending;
      if (attempt < MAX_BATCH_ATTEMPTS && this.retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempt));
      }
    }
    return false;
  }

  /** `false` if `DeleteObjects` reported errors for some keys. */
  private async deleteSnapshots(listingId: string): Promise<boolean> {
    const prefix = snapshotPrefix(listingId);
    let complete = true;
    let token: string | undefined;
    do {
      const out = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: prefix,
          ...(token !== undefined && { ContinuationToken: token }),
        }),
      );
      // A page holds at most 1,000 keys, the limit of one `DeleteObjects`.
      const objects: ObjectIdentifier[] = (out.Contents ?? []).flatMap((object) =>
        object.Key === undefined ? [] : [{ Key: object.Key }],
      );
      if (objects.length > 0) {
        const deleted = await this.s3.send(
          new DeleteObjectsCommand({
            Bucket: this.bucketName,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
        if ((deleted.Errors ?? []).length > 0) complete = false;
      }
      token = out.IsTruncated === true ? out.NextContinuationToken : undefined;
    } while (token !== undefined);
    return complete;
  }

  private async isEmpty(listingId: string): Promise<boolean> {
    const versions = await this.client.send(
      new QueryCommand({
        TableName: this.versionsTable,
        KeyConditionExpression: '#pk = :pk',
        ProjectionExpression: '#pk',
        ExpressionAttributeNames: { '#pk': LISTING_VERSIONS_PK_ATTRIBUTE },
        ExpressionAttributeValues: { ':pk': listingId },
        ConsistentRead: true,
        Limit: 1,
      }),
    );
    if ((versions.Items ?? []).length > 0) return false;
    const objects = await this.s3.send(
      new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: snapshotPrefix(listingId),
        MaxKeys: 1,
      }),
    );
    return (objects.Contents ?? []).length === 0;
  }
}
