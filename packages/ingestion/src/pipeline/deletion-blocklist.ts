import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  DELETION_BLOCKLIST_KEY_ATTRIBUTE,
  type DeletionBlocklistCheck,
  type InMemoryOp,
} from '@open-estate/core';

/** Partition key attribute of the `DeletionBlocklist` table; defined in core, re-exported here. */
export { DELETION_BLOCKLIST_KEY_ATTRIBUTE };

/**
 * Listing ids and Custom_Id keys removed by a deletion request (Req 18.6). The import pipeline
 * refuses every record whose id or Custom_Id is listed (Req 18.7, 12.14); the
 * `VersionedListingWriter` re-checks the list in the same transaction.
 */
export interface DeletionBlocklist {
  has(listingId: string): Promise<boolean>;
}

/**
 * In-memory blocklist for tests and local runs. Also the writer's transactional check
 * (`DeletionBlocklistCheck`), so pre-check and write see the same entries.
 */
export class InMemoryDeletionBlocklist
  implements DeletionBlocklist, DeletionBlocklistCheck<InMemoryOp>
{
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

  /** Same label and target as core's `InMemoryDeletionBlocklistCheck`. */
  notBlockedOp(key: string): InMemoryOp {
    return {
      label: 'deletionBlocklist.check',
      target: `DeletionBlocklist#${key}`,
      check: () => !this.ids.has(key),
      apply: () => undefined,
    };
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
