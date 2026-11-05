import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import type { DynamoDbOp, InMemoryOp } from './transaction';

// `ListingKeys` table (design: "DynamoDB-Tabellen"): uniqueness of a Custom_Id within an agency
// (Req 4.11, 4.12). PK `customKey` = `agencyId#customId`, attribute `listingId`.

export const LISTING_KEYS_PK_ATTRIBUTE = 'customKey';

/**
 * Partition key value of a Custom_Id. Agency ids are platform-assigned and contain no `#`, so the
 * first `#` separates agency and Custom_Id unambiguously.
 */
export function listingKey(agencyId: string, customId: string): string {
  return `${agencyId}#${customId}`;
}

const listingKeyItemSchema = z.object({ listingId: z.string().min(1) });

export interface ListingKeyStore<Op> {
  /** Listing id the Custom_Id of this agency is assigned to, or `null`. */
  get(agencyId: string, customId: string): Promise<string | null>;
  /**
   * Assigns the Custom_Id to `listingId` (label `listingKey.assign`); fails if it belongs to
   * another listing of the agency (`CUSTOM_ID_TAKEN`, Req 4.12). Holds for the same listing.
   */
  assignOp(agencyId: string, customId: string, listingId: string): Op;
  /** Releases a Custom_Id (label `listingKey.release`); fails unless assigned to `listingId`. */
  releaseOp(agencyId: string, customId: string, listingId: string): Op;
}

/** Fake with transaction semantics via `InMemoryTransactor`. */
export class InMemoryListingKeyStore implements ListingKeyStore<InMemoryOp> {
  private readonly keys = new Map<string, string>();

  async get(agencyId: string, customId: string): Promise<string | null> {
    return this.keys.get(listingKey(agencyId, customId)) ?? null;
  }

  assignOp(agencyId: string, customId: string, listingId: string): InMemoryOp {
    const key = listingKey(agencyId, customId);
    return {
      label: 'listingKey.assign',
      target: `ListingKeys#${key}`,
      check: () => {
        const current = this.keys.get(key);
        return current === undefined || current === listingId;
      },
      apply: () => {
        this.keys.set(key, listingId);
      },
    };
  }

  releaseOp(agencyId: string, customId: string, listingId: string): InMemoryOp {
    const key = listingKey(agencyId, customId);
    return {
      label: 'listingKey.release',
      target: `ListingKeys#${key}`,
      check: () => this.keys.get(key) === listingId,
      apply: () => {
        this.keys.delete(key);
      },
    };
  }

  /** All assignments `agencyId#customId → listingId` (for assertions in tests). */
  entries(): [string, string][] {
    return [...this.keys.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
}

export interface DynamoDbListingKeyStoreOptions {
  client: DynamoDBDocumentClient;
  /** `ListingKeys` table; partition key `customKey`. */
  tableName: string;
}

export class DynamoDbListingKeyStore implements ListingKeyStore<DynamoDbOp> {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor({ client, tableName }: DynamoDbListingKeyStoreOptions) {
    this.client = client;
    this.tableName = tableName;
  }

  async get(agencyId: string, customId: string): Promise<string | null> {
    const out = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { [LISTING_KEYS_PK_ATTRIBUTE]: listingKey(agencyId, customId) },
        ConsistentRead: true,
      }),
    );
    return out.Item === undefined ? null : listingKeyItemSchema.parse(out.Item).listingId;
  }

  assignOp(agencyId: string, customId: string, listingId: string): DynamoDbOp {
    return {
      label: 'listingKey.assign',
      item: {
        Put: {
          TableName: this.tableName,
          Item: { [LISTING_KEYS_PK_ATTRIBUTE]: listingKey(agencyId, customId), listingId },
          ConditionExpression: 'attribute_not_exists(#pk) OR #listingId = :listingId',
          ExpressionAttributeNames: { '#pk': LISTING_KEYS_PK_ATTRIBUTE, '#listingId': 'listingId' },
          ExpressionAttributeValues: { ':listingId': listingId },
        },
      },
    };
  }

  releaseOp(agencyId: string, customId: string, listingId: string): DynamoDbOp {
    return {
      label: 'listingKey.release',
      item: {
        Delete: {
          TableName: this.tableName,
          Key: { [LISTING_KEYS_PK_ATTRIBUTE]: listingKey(agencyId, customId) },
          ConditionExpression: '#listingId = :listingId',
          ExpressionAttributeNames: { '#listingId': 'listingId' },
          ExpressionAttributeValues: { ':listingId': listingId },
        },
      },
    };
  }
}
