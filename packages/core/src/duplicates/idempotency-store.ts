import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { IsoDateTime, LISTING_BOUNDS } from '@open-estate/shared';
import { z } from 'zod';
import type { DynamoDbOp, InMemoryOp } from '../management/transaction';

// `IdempotencyKeys` table (duplicate-detection design: "Idempotenzschlüssel", Req 9.2–9.6).
// PK `key` = `{actorKey}#{keyHash}`; TTL attribute `expiresAt` (epoch seconds). DynamoDB removes
// expired items only eventually, so every read and the conditional put compare `expiresAt` with
// the current time themselves. GSI `byListing` (PK `listingId`) lets a deletion request remove
// the records of a listing (Req 12.3).

export const IDEMPOTENCY_KEYS_PK = 'key';
export const IDEMPOTENCY_KEYS_TTL_ATTRIBUTE = 'expiresAt';
export const IDEMPOTENCY_KEYS_BY_LISTING = 'byListing';
export const IDEMPOTENCY_KEYS_LISTING_ATTRIBUTE = 'listingId';

/** Akteur part of the key (Req 9.4): `user:{userId}` or `mk:{keyId}`. */
export type IdempotencyActorKey = `user:${string}` | `mk:${string}`;

export interface IdempotencyRecord {
  actorKey: IdempotencyActorKey;
  /** `idempotencyKeyHash(key)`. */
  keyHash: string;
  listingId: string;
  /** `idempotencyRequestHash(body)` of the request that created the listing. */
  requestHash: string;
  createdAt: string;
  /** Epoch seconds; after that the key is free again. */
  expiresAt: number;
}

const recordKey = (actorKey: string, keyHash: string) => `${actorKey}#${keyHash}`;

const KEY_HASH_LENGTH = 64;

/** Inverse of {@link recordKey}. */
function splitRecordKey(key: string): { actorKey: string; keyHash: string } {
  return {
    actorKey: key.slice(0, -(KEY_HASH_LENGTH + 1)),
    keyHash: key.slice(-KEY_HASH_LENGTH),
  };
}

const recordSchema: z.ZodType<IdempotencyRecord> = z.object({
  actorKey: z.string().regex(/^(user|mk):.+$/),
  keyHash: z.string().regex(/^[0-9a-f]{64}$/),
  listingId: z.string().min(LISTING_BOUNDS.id.min).max(LISTING_BOUNDS.id.max),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: IsoDateTime,
  expiresAt: z.int().min(0),
}) as z.ZodType<IdempotencyRecord>;

export interface IdempotencyStore<Op> {
  /** Record of a key that has not expired at `nowSeconds`; `null` otherwise. Strongly consistent. */
  get(
    actorKey: IdempotencyActorKey,
    keyHash: string,
    nowSeconds: number,
  ): Promise<IdempotencyRecord | null>;
  /**
   * Stores a record (label `idempotency.put`) unless an unexpired record of the same key exists —
   * then a concurrent request with the same key won and the caller re-reads it.
   */
  putOp(record: IdempotencyRecord, nowSeconds: number): Op;
  /** Keys of every record pointing at a listing, for the deletion request (Req 12.3). */
  keysOfListing(listingId: string): Promise<{ actorKey: string; keyHash: string }[]>;
  /**
   * Removes every record of a deleted listing (Req 12.3): the request hash is derived from the
   * request body, which may have held personal data. Idempotent; `complete` = none is left.
   */
  purgeListing(listingId: string): Promise<{ complete: boolean }>;
}

// ---------------------------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------------------------

export class InMemoryIdempotencyStore implements IdempotencyStore<InMemoryOp> {
  private readonly records = new Map<string, IdempotencyRecord>();

  async get(
    actorKey: IdempotencyActorKey,
    keyHash: string,
    nowSeconds: number,
  ): Promise<IdempotencyRecord | null> {
    const record = this.records.get(recordKey(actorKey, keyHash));
    return record === undefined || record.expiresAt <= nowSeconds ? null : { ...record };
  }

  putOp(record: IdempotencyRecord, nowSeconds: number): InMemoryOp {
    const stored = recordSchema.parse(record);
    const key = recordKey(record.actorKey, record.keyHash);
    return {
      label: 'idempotency.put',
      target: `IdempotencyKeys#${key}`,
      check: () => {
        const existing = this.records.get(key);
        return existing === undefined || existing.expiresAt <= nowSeconds;
      },
      apply: () => {
        this.records.set(key, stored);
      },
    };
  }

  async keysOfListing(listingId: string): Promise<{ actorKey: string; keyHash: string }[]> {
    return [...this.records.values()]
      .filter((record) => record.listingId === listingId)
      .map(({ actorKey, keyHash }) => ({ actorKey, keyHash }));
  }

  /** Removes a record (deletion request); unknown keys are ignored. */
  remove(actorKey: string, keyHash: string): void {
    this.records.delete(recordKey(actorKey, keyHash));
  }

  async purgeListing(listingId: string): Promise<{ complete: boolean }> {
    for (const { actorKey, keyHash } of await this.keysOfListing(listingId)) {
      this.remove(actorKey, keyHash);
    }
    return { complete: true };
  }

  /** Every stored record, for assertions in tests. */
  entries(): IdempotencyRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }
}

// ---------------------------------------------------------------------------------------------
// DynamoDB
// ---------------------------------------------------------------------------------------------

export interface DynamoDbIdempotencyStoreOptions {
  client: DynamoDBDocumentClient;
  /** `IdempotencyKeys` table; PK `key`, TTL `expiresAt`, GSI `byListing`. */
  tableName: string;
}

export class DynamoDbIdempotencyStore implements IdempotencyStore<DynamoDbOp> {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor({ client, tableName }: DynamoDbIdempotencyStoreOptions) {
    this.client = client;
    this.tableName = tableName;
  }

  async get(
    actorKey: IdempotencyActorKey,
    keyHash: string,
    nowSeconds: number,
  ): Promise<IdempotencyRecord | null> {
    const out = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { [IDEMPOTENCY_KEYS_PK]: recordKey(actorKey, keyHash) },
        ConsistentRead: true,
      }),
    );
    if (out.Item === undefined) return null;
    // The table key is not part of the record schema, which strips unknown keys.
    const record = recordSchema.parse(out.Item);
    return record.expiresAt <= nowSeconds ? null : record;
  }

  putOp(record: IdempotencyRecord, nowSeconds: number): DynamoDbOp {
    return {
      label: 'idempotency.put',
      item: {
        Put: {
          TableName: this.tableName,
          Item: {
            [IDEMPOTENCY_KEYS_PK]: recordKey(record.actorKey, record.keyHash),
            ...recordSchema.parse(record),
          },
          ConditionExpression: 'attribute_not_exists(#key) OR #expiresAt <= :now',
          ExpressionAttributeNames: {
            '#key': IDEMPOTENCY_KEYS_PK,
            '#expiresAt': IDEMPOTENCY_KEYS_TTL_ATTRIBUTE,
          },
          ExpressionAttributeValues: { ':now': nowSeconds },
        },
      },
    };
  }

  async purgeListing(listingId: string): Promise<{ complete: boolean }> {
    const keys = await this.keysOfListing(listingId);
    for (const { actorKey, keyHash } of keys) {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { [IDEMPOTENCY_KEYS_PK]: recordKey(actorKey, keyHash) },
        }),
      );
    }
    // The GSI may still list deleted records; the table itself is the truth.
    const left = await Promise.all(
      keys.map(({ actorKey, keyHash }) =>
        this.client.send(
          new GetCommand({
            TableName: this.tableName,
            Key: { [IDEMPOTENCY_KEYS_PK]: recordKey(actorKey, keyHash) },
            ConsistentRead: true,
          }),
        ),
      ),
    );
    return { complete: left.every((out) => out.Item === undefined) };
  }

  async keysOfListing(listingId: string): Promise<{ actorKey: string; keyHash: string }[]> {
    const keys: { actorKey: string; keyHash: string }[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const out = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: IDEMPOTENCY_KEYS_BY_LISTING,
          KeyConditionExpression: '#listingId = :listingId',
          ExpressionAttributeNames: { '#listingId': IDEMPOTENCY_KEYS_LISTING_ATTRIBUTE },
          ExpressionAttributeValues: { ':listingId': listingId },
          ...(startKey !== undefined && { ExclusiveStartKey: startKey }),
        }),
      );
      // The index only needs to project the table key: `{actorKey}#{keyHash}` with a fixed-size
      // hash at the end.
      for (const item of out.Items ?? [])
        keys.push(splitRecordKey(String(item[IDEMPOTENCY_KEYS_PK])));
      startKey = out.LastEvaluatedKey;
    } while (startKey !== undefined);
    return keys;
  }
}
