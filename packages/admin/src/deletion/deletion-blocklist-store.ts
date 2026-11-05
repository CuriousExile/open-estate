import { DeleteCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DELETION_BLOCKLIST_KEY_ATTRIBUTE, type DeletionBlocklistStore } from '@open-estate/core';
import type { DeletionBlocklistEntry } from './deletion-model';

export type { DeletionBlocklistStore };

/**
 * Id set the in-memory store mirrors its changes into. `InMemoryDeletionBlocklist` of
 * `@open-estate/ingestion` satisfies it, so pipeline and deletion share one blocklist in tests.
 */
export interface BlocklistIdMirror {
  add(listingId: string): void;
  remove(listingId: string): void;
}

/** Fake for tests and in-process runs; also readable via `has` like the pipeline's port. */
export class InMemoryDeletionBlocklistStore implements DeletionBlocklistStore {
  private readonly entries = new Map<string, DeletionBlocklistEntry>();

  constructor(private readonly mirror?: BlocklistIdMirror) {}

  async block(entry: DeletionBlocklistEntry): Promise<void> {
    if (this.entries.has(entry.listingId)) return;
    this.entries.set(entry.listingId, { ...entry });
    this.mirror?.add(entry.listingId);
  }

  async unblock(listingId: string): Promise<boolean> {
    const removed = this.entries.delete(listingId);
    if (removed) this.mirror?.remove(listingId);
    return removed;
  }

  async has(listingId: string): Promise<boolean> {
    return this.entries.has(listingId);
  }

  get(listingId: string): DeletionBlocklistEntry | undefined {
    const entry = this.entries.get(listingId);
    return entry === undefined ? undefined : { ...entry };
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }
}

export interface DynamoDbDeletionBlocklistStoreOptions {
  client: DynamoDBDocumentClient;
  /** `DeletionBlocklist` table; partition key {@link DELETION_BLOCKLIST_KEY_ATTRIBUTE}. */
  tableName: string;
}

const KEY = DELETION_BLOCKLIST_KEY_ATTRIBUTE;

/** `PutItem` with `attribute_not_exists`, so re-runs keep the first entry; `DeleteItem` to lift. */
export class DynamoDbDeletionBlocklistStore implements DeletionBlocklistStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor({ client, tableName }: DynamoDbDeletionBlocklistStoreOptions) {
    this.client = client;
    this.tableName = tableName;
  }

  async block({ listingId, source, deletedAt, requestId }: DeletionBlocklistEntry): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { [KEY]: listingId, source, deletedAt, requestId },
          ConditionExpression: 'attribute_not_exists(#key)',
          ExpressionAttributeNames: { '#key': KEY },
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return;
      throw error;
    }
  }

  async unblock(listingId: string): Promise<boolean> {
    const out = await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { [KEY]: listingId },
        ReturnValues: 'ALL_OLD',
      }),
    );
    return out.Attributes !== undefined;
  }
}
