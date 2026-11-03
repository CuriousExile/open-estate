import { createHash } from 'node:crypto';
import {
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { rateLimitSchema, type RateLimit } from './access-config';

/** Only `SHA-256(key)` is ever stored or looked up; the plain key never leaves the request. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export const apiKeyRecordSchema = z.object({
  keyId: z.string().min(1),
  keyHash: z.string().min(1),
  status: z.enum(['active', 'revoked']),
  /** ISO-8601 timestamp; the key is expired from this instant on. */
  expiresAt: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), 'invalid timestamp')
    .optional(),
  /** Overrides the global rate limit (Req 17.6). */
  rateLimit: rateLimitSchema.optional(),
});

export type ApiKeyRecord = z.infer<typeof apiKeyRecordSchema>;

/** Valid = created by the admin, not revoked, not expired at `now` (Req 17.4). */
export function isApiKeyValid(record: ApiKeyRecord, now: number): boolean {
  if (record.status !== 'active') return false;
  return record.expiresAt === undefined || now < Date.parse(record.expiresAt);
}

export interface ApiKeyStore {
  /** Returns the key with this SHA-256 hash, regardless of status, or `null`. */
  findByHash(keyHash: string): Promise<ApiKeyRecord | null>;
}

/**
 * Write side used by the Admin-API (Req 17.4, 17.6). Separate from {@link ApiKeyStore} so the
 * AccessGuard (API/MCP Lambdas) only depends on, and is only granted, read access.
 */
export interface ApiKeyAdminStore {
  /** Stores a new key; throws if a key with this `keyId` already exists. */
  create(record: ApiKeyRecord): Promise<void>;
  /** Sets status `revoked` (idempotent); `null` if no key has this id. */
  revoke(keyId: string): Promise<ApiKeyRecord | null>;
  /** Sets the key's own rate limit; `null` if no key has this id. */
  setRateLimit(keyId: string, rateLimit: RateLimit): Promise<ApiKeyRecord | null>;
}

/** Fake for tests; `put` simulates admin changes (create, revoke, set limit). */
export class InMemoryApiKeyStore implements ApiKeyStore, ApiKeyAdminStore {
  private readonly byHash = new Map<string, ApiKeyRecord>();

  constructor(records: readonly ApiKeyRecord[] = []) {
    for (const record of records) this.put(record);
  }

  put(record: ApiKeyRecord): void {
    this.byHash.set(record.keyHash, record);
  }

  async findByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    return this.byHash.get(keyHash) ?? null;
  }

  /** All stored records (for assertions in tests). */
  records(): ApiKeyRecord[] {
    return [...this.byHash.values()];
  }

  async create(record: ApiKeyRecord): Promise<void> {
    if (this.findById(record.keyId) !== undefined) {
      throw new Error(`API key ${record.keyId} already exists`);
    }
    this.put(record);
  }

  async revoke(keyId: string): Promise<ApiKeyRecord | null> {
    return this.update(keyId, (record) => ({ ...record, status: 'revoked' }));
  }

  async setRateLimit(keyId: string, rateLimit: RateLimit): Promise<ApiKeyRecord | null> {
    return this.update(keyId, (record) => ({ ...record, rateLimit: { ...rateLimit } }));
  }

  private findById(keyId: string): ApiKeyRecord | undefined {
    return this.records().find((record) => record.keyId === keyId);
  }

  private update(
    keyId: string,
    change: (record: ApiKeyRecord) => ApiKeyRecord,
  ): ApiKeyRecord | null {
    const current = this.findById(keyId);
    if (current === undefined) return null;
    const updated = change(current);
    this.put(updated);
    return updated;
  }
}

export interface DynamoDbApiKeyStoreOptions {
  client: DynamoDBDocumentClient;
  /** `ApiKeys` table; partition key `keyId`. */
  tableName: string;
  /** GSI with partition key `keyHash` (projection ALL). Default `byHash`. */
  indexName?: string;
}

/**
 * Looks up keys via the `byHash` GSI; malformed items throw instead of granting access.
 * Writes: `PutItem` with `attribute_not_exists(keyId)`; updates are `UpdateItem` with
 * `attribute_exists(keyId)`, so an unknown key yields `null` instead of creating an item.
 */
export class DynamoDbApiKeyStore implements ApiKeyStore, ApiKeyAdminStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly indexName: string;

  constructor({ client, tableName, indexName = 'byHash' }: DynamoDbApiKeyStoreOptions) {
    this.client = client;
    this.tableName = tableName;
    this.indexName = indexName;
  }

  async findByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const out = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: this.indexName,
        KeyConditionExpression: '#keyHash = :keyHash',
        ExpressionAttributeNames: { '#keyHash': 'keyHash' },
        ExpressionAttributeValues: { ':keyHash': keyHash },
        Limit: 1,
      }),
    );
    const item = out.Items?.[0];
    return item === undefined ? null : apiKeyRecordSchema.parse(item);
  }

  async create(record: ApiKeyRecord): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: apiKeyRecordSchema.parse(record),
        ConditionExpression: 'attribute_not_exists(#keyId)',
        ExpressionAttributeNames: { '#keyId': 'keyId' },
      }),
    );
  }

  async revoke(keyId: string): Promise<ApiKeyRecord | null> {
    return this.update(keyId, 'status', 'revoked');
  }

  async setRateLimit(keyId: string, rateLimit: RateLimit): Promise<ApiKeyRecord | null> {
    return this.update(keyId, 'rateLimit', rateLimitSchema.parse(rateLimit));
  }

  private async update(
    keyId: string,
    attribute: 'status' | 'rateLimit',
    value: unknown,
  ): Promise<ApiKeyRecord | null> {
    try {
      const out = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { keyId },
          UpdateExpression: 'SET #attribute = :value',
          ConditionExpression: 'attribute_exists(#keyId)',
          ExpressionAttributeNames: { '#attribute': attribute, '#keyId': 'keyId' },
          ExpressionAttributeValues: { ':value': value },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return apiKeyRecordSchema.parse(out.Attributes);
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return null;
      throw error;
    }
  }
}
