import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  DELETION_REQUESTS_KEY_ATTRIBUTE,
  DynamoDbListingKeyStore,
  DynamoDbMetricCounterStore,
  LISTINGS_BY_SOURCE_INDEX,
  type DeletionListingStore,
  type InMemoryListingKeyStore,
  type InMemoryMetricCounterStore,
  type InMemoryOp,
  type MetricCounterIncrement,
  type TargetPageRequest,
  type TransactWriteItem,
} from '@open-estate/core';
import type { Listing } from '@open-estate/shared';
import type { DeletionTarget, TargetPage } from './deletion-model';
import type { InMemoryDeletionRequestStore } from './deletion-request-store';

export type { DeletionListingStore, TargetPageRequest };

/** Management data of a listing that a complete deletion needs (Req 6.8, 9.2, 9.3). */
export interface DeletionListingState extends DeletionTarget {
  /** Listing_Status; absent for items without management data. */
  status?: string;
  agencyId?: string;
  customId?: string;
}

/** Custom_Id key of the `ListingKeys` table: `{owner}#{customId}`, owner `_none` without agency. */
export interface CustomIdKey {
  owner: string;
  customId: string;
}

/** Writes that go into the same transaction as the removal of the listing. */
export interface ListingRemoval {
  /** Releases the listing's Custom_Id (Req 9.3). */
  customKey?: CustomIdKey;
  /** Inventory and history counter decrements (`deletionCounterDecrements`). */
  counters?: readonly MetricCounterIncrement[];
}

/** {@link DeletionListingStore} of the versioned deletion workflow. */
export interface VersionedDeletionListingStore extends DeletionListingStore {
  /** Key data plus status, agency and Custom_Id (strongly consistent), or `null`. */
  inspect(listingId: string): Promise<DeletionListingState | null>;
  /**
   * Removes the listing, counts it on the request and applies `removal`, atomically. `false` if
   * the listing no longer exists; then nothing is written.
   */
  removeForRequest(
    listingId: string,
    requestId: string,
    removal?: ListingRemoval,
  ): Promise<boolean>;
}

/** Key data of a stored listing; a `Map<string, Listing>` is accepted as backing store too. */
export type StoredListingKey = Pick<Listing, 'id' | 'source'> &
  Partial<Pick<DeletionListingState, 'status' | 'agencyId' | 'customId'>>;

export interface InMemoryDeletionListingStoreOptions {
  /** Request store whose `removedCount` is incremented on removal. */
  requests: InMemoryDeletionRequestStore;
  /** Backing map keyed by id; pass a map shared with other fakes to observe removals there. */
  listings?: Map<string, StoredListingKey>;
  /** Custom_Id keys released on removal (shared with the writer's fake). */
  keys?: InMemoryListingKeyStore;
  /** Counters decremented on removal (shared with the writer's fake). */
  counters?: InMemoryMetricCounterStore;
}

/** Fake for tests and in-process runs. The cursor is the last returned id. */
export class InMemoryDeletionListingStore implements VersionedDeletionListingStore {
  readonly listings: Map<string, StoredListingKey>;
  private readonly requests: InMemoryDeletionRequestStore;
  private readonly keys: InMemoryListingKeyStore | undefined;
  private readonly counters: InMemoryMetricCounterStore | undefined;

  constructor({
    requests,
    listings = new Map(),
    keys,
    counters,
  }: InMemoryDeletionListingStoreOptions) {
    this.requests = requests;
    this.listings = listings;
    this.keys = keys;
    this.counters = counters;
  }

  put(listing: StoredListingKey): void {
    this.listings.set(listing.id, listing);
  }

  async find(listingId: string): Promise<DeletionTarget | null> {
    const listing = this.listings.get(listingId);
    return listing === undefined ? null : { listingId: listing.id, source: listing.source };
  }

  async listBySource(source: string, { limit, cursor }: TargetPageRequest): Promise<TargetPage> {
    const ids = [...this.listings.values()]
      .filter(
        (listing) => listing.source === source && (cursor === undefined || listing.id > cursor),
      )
      .map((listing) => listing.id)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const page = ids.slice(0, limit);
    const last = page.at(-1);
    return {
      targets: page.map((listingId) => ({ listingId, source })),
      ...(ids.length > limit && last !== undefined && { nextCursor: last }),
    };
  }

  async inspect(listingId: string): Promise<DeletionListingState | null> {
    const listing = this.listings.get(listingId);
    if (listing === undefined) return null;
    return {
      listingId: listing.id,
      source: listing.source,
      ...(listing.status !== undefined && { status: listing.status }),
      ...(listing.agencyId !== undefined && { agencyId: listing.agencyId }),
      ...(listing.customId !== undefined && { customId: listing.customId }),
    };
  }

  async removeForRequest(
    listingId: string,
    requestId: string,
    removal: ListingRemoval = {},
  ): Promise<boolean> {
    if (!this.requests.has(requestId)) throw new Error(`Deletion request ${requestId} not found`);
    if (!this.listings.has(listingId)) return false;
    const ops = this.removalOps(listingId, removal);
    const failed = ops.filter((op) => !op.check()).map((op) => op.label);
    if (failed.length > 0) {
      throw new Error(`Inconsistent removal of listing ${listingId}: ${failed.join(', ')}`);
    }
    this.listings.delete(listingId);
    for (const op of ops) op.apply();
    this.requests.incrementRemoved(requestId);
    return true;
  }

  private removalOps(
    listingId: string,
    { customKey, counters = [] }: ListingRemoval,
  ): InMemoryOp[] {
    const ops: InMemoryOp[] = [];
    if (customKey !== undefined) {
      if (this.keys === undefined) throw new Error('No ListingKeys fake configured');
      ops.push(this.keys.releaseOp(customKey.owner, customKey.customId, listingId));
    }
    if (counters.length > 0) {
      const store = this.counters;
      if (store === undefined) throw new Error('No MetricCounters fake configured');
      ops.push(...counters.map((increment) => store.addOp(increment)));
    }
    return ops;
  }
}

export interface DynamoDbDeletionListingStoreOptions {
  client: DynamoDBDocumentClient;
  /** `Listings` table; partition key `id`, GSI {@link LISTINGS_BY_SOURCE_INDEX}. */
  listingsTable: string;
  /** `DeletionRequests` table; its `removedCount` is incremented with each removal. */
  deletionRequestsTable: string;
  /** `ListingKeys` table; required to release a Custom_Id. */
  listingKeysTable?: string;
  /** `MetricCounters` table; required to decrement counters. */
  metricCountersTable?: string;
}

const DELETE_INDEX = 0;

/** At most 100 operations per `TransactWriteItems`. */
const MAX_TRANSACTION_ITEMS = 100;

const encodeCursor = (key: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');

function decodeCursor(cursor: string): Record<string, unknown> {
  const key: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (typeof key !== 'object' || key === null || Array.isArray(key)) {
    throw new Error('Invalid deletion target cursor');
  }
  return key as Record<string, unknown>;
}

/**
 * Reads only the key attributes `id`/`source` (always projected into `bySource`). The removal is
 * one `TransactWriteItems`: `Delete(Listings, attribute_exists(id))` + `Update(DeletionRequests,
 * ADD removedCount 1)` + optionally `Delete(ListingKeys)` of the Custom_Id and the `ADD`s on
 * `MetricCounters`, so count, key and counters are exact even when a step is retried. The
 * deletion propagates to OpenSearch via DynamoDB Streams.
 */
export class DynamoDbDeletionListingStore implements VersionedDeletionListingStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly listingsTable: string;
  private readonly deletionRequestsTable: string;
  private readonly keys: DynamoDbListingKeyStore | undefined;
  private readonly counters: DynamoDbMetricCounterStore | undefined;

  constructor({
    client,
    listingsTable,
    deletionRequestsTable,
    listingKeysTable,
    metricCountersTable,
  }: DynamoDbDeletionListingStoreOptions) {
    this.client = client;
    this.listingsTable = listingsTable;
    this.deletionRequestsTable = deletionRequestsTable;
    this.keys =
      listingKeysTable === undefined
        ? undefined
        : new DynamoDbListingKeyStore({ client, tableName: listingKeysTable });
    this.counters =
      metricCountersTable === undefined
        ? undefined
        : new DynamoDbMetricCounterStore({ client, tableName: metricCountersTable });
  }

  async inspect(listingId: string): Promise<DeletionListingState | null> {
    const out = await this.client.send(
      new GetCommand({
        TableName: this.listingsTable,
        Key: { id: listingId },
        ProjectionExpression: '#id, #source, #status, #agencyId, #customId',
        ExpressionAttributeNames: {
          '#id': 'id',
          '#source': 'source',
          '#status': 'status',
          '#agencyId': 'agencyId',
          '#customId': 'customId',
        },
        ConsistentRead: true,
      }),
    );
    const item = out.Item;
    if (item === undefined) return null;
    const optional = (name: string) =>
      typeof item[name] === 'string' ? { [name]: item[name] as string } : {};
    return {
      listingId,
      source: String(item['source']),
      ...optional('status'),
      ...optional('agencyId'),
      ...optional('customId'),
    };
  }

  async find(listingId: string): Promise<DeletionTarget | null> {
    const out = await this.client.send(
      new GetCommand({
        TableName: this.listingsTable,
        Key: { id: listingId },
        ProjectionExpression: '#id, #source',
        ExpressionAttributeNames: { '#id': 'id', '#source': 'source' },
        ConsistentRead: true,
      }),
    );
    const item = out.Item;
    return item === undefined ? null : { listingId, source: String(item['source']) };
  }

  async listBySource(source: string, { limit, cursor }: TargetPageRequest): Promise<TargetPage> {
    const out = await this.client.send(
      new QueryCommand({
        TableName: this.listingsTable,
        IndexName: LISTINGS_BY_SOURCE_INDEX,
        KeyConditionExpression: '#source = :source',
        ProjectionExpression: '#id, #source',
        ExpressionAttributeNames: { '#id': 'id', '#source': 'source' },
        ExpressionAttributeValues: { ':source': source },
        Limit: limit,
        ...(cursor !== undefined && { ExclusiveStartKey: decodeCursor(cursor) }),
      }),
    );
    const last = out.LastEvaluatedKey;
    return {
      targets: (out.Items ?? []).map((item) => ({ listingId: String(item['id']), source })),
      ...(last !== undefined && { nextCursor: encodeCursor(last) }),
    };
  }

  async removeForRequest(
    listingId: string,
    requestId: string,
    removal: ListingRemoval = {},
  ): Promise<boolean> {
    const items: TransactWriteItem[] = [
      {
        Delete: {
          TableName: this.listingsTable,
          Key: { id: listingId },
          ConditionExpression: 'attribute_exists(#id)',
          ExpressionAttributeNames: { '#id': 'id' },
        },
      },
      {
        Update: {
          TableName: this.deletionRequestsTable,
          Key: { [DELETION_REQUESTS_KEY_ATTRIBUTE]: requestId },
          UpdateExpression: 'ADD #removedCount :one',
          ConditionExpression: 'attribute_exists(#key)',
          ExpressionAttributeNames: {
            '#removedCount': 'removedCount',
            '#key': DELETION_REQUESTS_KEY_ATTRIBUTE,
          },
          ExpressionAttributeValues: { ':one': 1 },
        },
      },
      ...this.removalItems(listingId, removal),
    ];
    if (items.length > MAX_TRANSACTION_ITEMS) {
      throw new Error(`Removal of listing ${listingId} exceeds ${MAX_TRANSACTION_ITEMS} writes`);
    }
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: items }));
      return true;
    } catch (error) {
      if (cancellationCodes(error)?.[DELETE_INDEX] === 'ConditionalCheckFailed') return false;
      throw error;
    }
  }

  private removalItems(listingId: string, { customKey, counters = [] }: ListingRemoval) {
    const items: TransactWriteItem[] = [];
    if (customKey !== undefined) {
      if (this.keys === undefined) throw new Error('listingKeysTable is not configured');
      items.push(this.keys.releaseOp(customKey.owner, customKey.customId, listingId).item);
    }
    if (counters.length > 0) {
      const store = this.counters;
      if (store === undefined) throw new Error('metricCountersTable is not configured');
      items.push(...counters.map((increment) => store.addOp(increment).item));
    }
    return items;
  }
}

/** Per-item cancellation codes of a `TransactionCanceledException`, otherwise `undefined`. */
function cancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') return undefined;
  const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return reasons?.map((reason) => reason.Code);
}
