import type { DynamoDbOp, InMemoryOp } from '../management/transaction';
import { DELETION_BLOCKLIST_KEY_ATTRIBUTE } from './deletion-tables';

// Transactional check against the `DeletionBlocklist` (design: "VersionedListingWriter", Req 4.9,
// 12.14): the versioned write path verifies in the same `TransactWriteItems` that neither the
// listing id nor its Custom_Id is blocked. Both live in the same partition key attribute
// ({@link DELETION_BLOCKLIST_KEY_ATTRIBUTE}); Custom_Ids use the prefixed key
// `custom#{agencyId}#{customId}`.

/** Blocklist key of a Custom_Id within an agency (design: "DeletionBlocklist (erweitert)"). */
export function customIdBlocklistKey(agencyId: string, customId: string): string {
  return `custom#${agencyId}#${customId}`;
}

export interface DeletionBlocklistCheck<Op> {
  /**
   * Condition-only operation (label `deletionBlocklist.check`) that fails if `key` (a listing id
   * or a {@link customIdBlocklistKey}) is on the blocklist (`DELETION_BLOCKED`).
   */
  notBlockedOp(key: string): Op;
}

/**
 * Fake with transaction semantics via `InMemoryTransactor`. `add`/`remove` match the admin
 * deletion store's id mirror, so deletion workflow and writer can share one blocklist in tests.
 */
export class InMemoryDeletionBlocklistCheck implements DeletionBlocklistCheck<InMemoryOp> {
  private readonly keys: Set<string>;

  constructor(keys: Iterable<string> = []) {
    this.keys = new Set(keys);
  }

  add(key: string): void {
    this.keys.add(key);
  }

  remove(key: string): void {
    this.keys.delete(key);
  }

  notBlockedOp(key: string): InMemoryOp {
    return {
      label: 'deletionBlocklist.check',
      target: `DeletionBlocklist#${key}`,
      check: () => !this.keys.has(key),
      apply: () => undefined,
    };
  }
}

export interface DynamoDbDeletionBlocklistCheckOptions {
  /** `DeletionBlocklist` table; partition key {@link DELETION_BLOCKLIST_KEY_ATTRIBUTE}. */
  tableName: string;
}

export class DynamoDbDeletionBlocklistCheck implements DeletionBlocklistCheck<DynamoDbOp> {
  private readonly tableName: string;

  constructor({ tableName }: DynamoDbDeletionBlocklistCheckOptions) {
    this.tableName = tableName;
  }

  notBlockedOp(key: string): DynamoDbOp {
    return {
      label: 'deletionBlocklist.check',
      item: {
        ConditionCheck: {
          TableName: this.tableName,
          Key: { [DELETION_BLOCKLIST_KEY_ATTRIBUTE]: key },
          ConditionExpression: 'attribute_not_exists(#key)',
          ExpressionAttributeNames: { '#key': DELETION_BLOCKLIST_KEY_ATTRIBUTE },
        },
      },
    };
  }
}
