import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  DELETION_REQUESTS_KEY_ATTRIBUTE,
  LISTINGS_BY_SOURCE_INDEX,
  type DeletionListingStore,
  type TargetPageRequest,
} from '@open-estate/core';
import type { Listing } from '@open-estate/shared';
import type { DeletionTarget, TargetPage } from './deletion-model';
import type { InMemoryDeletionRequestStore } from './deletion-request-store';

export type { DeletionListingStore, TargetPageRequest };

/** Key data of a stored listing; a `Map<string, Listing>` is accepted as backing store too. */
export type StoredListingKey = Pick<Listing, 'id' | 'source'>;

export interface InMemoryDeletionListingStoreOptions {
  /** Request store whose `removedCount` is incremented on removal. */
  requests: InMemoryDeletionRequestStore;
  /** Backing map keyed by id; pass a map shared with other fakes to observe removals there. */
  listings?: Map<string, StoredListingKey>;
}

/** Fake for tests and in-process runs. The cursor is the last returned id. */
export class InMemoryDeletionListingStore implements DeletionListingStore {
  readonly listings: Map<string, StoredListingKey>;
  private readonly requests: InMemoryDeletionRequestStore;

  constructor({ requests, listings = new Map() }: InMemoryDeletionListingStoreOptions) {
    this.requests = requests;
    this.listings = listings;
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

  async removeForRequest(listingId: string, requestId: string): Promise<boolean> {
    if (!this.requests.has(requestId)) throw new Error(`Deletion request ${requestId} not found`);
    if (!this.listings.delete(listingId)) return false;
    this.requests.incrementRemoved(requestId);
    return true;
  }
}

export interface DynamoDbDeletionListingStoreOptions {
  client: DynamoDBDocumentClient;
  /** `Listings` table; partition key `id`, GSI {@link LISTINGS_BY_SOURCE_INDEX}. */
  listingsTable: string;
  /** `DeletionRequests` table; its `removedCount` is incremented with each removal. */
  deletionRequestsTable: string;
}

const DELETE_INDEX = 0;

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
 * ADD removedCount 1)`, so the count is exact even when a step is retried. The deletion
 * propagates to OpenSearch via DynamoDB Streams.
 */
export class DynamoDbDeletionListingStore implements DeletionListingStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly listingsTable: string;
  private readonly deletionRequestsTable: string;

  constructor({
    client,
    listingsTable,
    deletionRequestsTable,
  }: DynamoDbDeletionListingStoreOptions) {
    this.client = client;
    this.listingsTable = listingsTable;
    this.deletionRequestsTable = deletionRequestsTable;
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

  async removeForRequest(listingId: string, requestId: string): Promise<boolean> {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
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
          ],
        }),
      );
      return true;
    } catch (error) {
      if (cancellationCodes(error)?.[DELETE_INDEX] === 'ConditionalCheckFailed') return false;
      throw error;
    }
  }
}

/** Per-item cancellation codes of a `TransactionCanceledException`, otherwise `undefined`. */
function cancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') return undefined;
  const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return reasons?.map((reason) => reason.Code);
}
