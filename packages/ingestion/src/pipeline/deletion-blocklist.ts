import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DELETION_BLOCKLIST_KEY_ATTRIBUTE } from '@open-estate/core';

/** Partition key attribute of the `DeletionBlocklist` table; defined in core, re-exported here. */
export { DELETION_BLOCKLIST_KEY_ATTRIBUTE };

/**
 * Listing ids removed by a deletion request (Req 18.6). The import pipeline refuses every record
 * whose id is listed (Req 18.7); the atomic upsert re-checks the list in the same transaction.
 */
export interface DeletionBlocklist {
  has(listingId: string): Promise<boolean>;
}

/**
 * Thrown by a `ListingWriter` when the id is on the deletion blocklist at write time, i.e. it was
 * blocked after the pipeline's pre-check. The pipeline records it as rejected („Löschsperre“).
 */
export class DeletionBlockedError extends Error {
  constructor(readonly listingId: string) {
    super(`Listing ${listingId} is on the deletion blocklist`);
    this.name = 'DeletionBlockedError';
  }
}

/** In-memory blocklist for tests and local runs. */
export class InMemoryDeletionBlocklist implements DeletionBlocklist {
  private readonly ids: Set<string>;

  constructor(ids: Iterable<string> = []) {
    this.ids = new Set(ids);
  }

  add(listingId: string): void {
    this.ids.add(listingId);
  }

  remove(listingId: string): void {
    this.ids.delete(listingId);
  }

  has(listingId: string): Promise<boolean> {
    return Promise.resolve(this.ids.has(listingId));
  }
}

export interface DynamoDbDeletionBlocklistOptions {
  client: DynamoDBDocumentClient;
  /** `DeletionBlocklist` table; partition key {@link DELETION_BLOCKLIST_KEY_ATTRIBUTE}. */
  tableName: string;
}

/** Strongly consistent lookup, so an entry written by a just-finished deletion is seen. */
export class DynamoDbDeletionBlocklist implements DeletionBlocklist {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor({ client, tableName }: DynamoDbDeletionBlocklistOptions) {
    this.client = client;
    this.tableName = tableName;
  }

  async has(listingId: string): Promise<boolean> {
    const out = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { [DELETION_BLOCKLIST_KEY_ATTRIBUTE]: listingId },
        ProjectionExpression: '#key',
        ExpressionAttributeNames: { '#key': DELETION_BLOCKLIST_KEY_ATTRIBUTE },
        ConsistentRead: true,
      }),
    );
    return out.Item !== undefined;
  }
}
