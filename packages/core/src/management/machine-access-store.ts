import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { EntityId, IsoDateTime, MANAGEMENT_BOUNDS, PermissionSchema } from '@open-estate/shared';
import { z } from 'zod';
import { pageBySortKey, queryIndexPage, type KeyPage, type KeyPageRequest } from './key-page';
import { isConditionalCheckFailed } from './transaction';

// `MachineAccess` table (design: "Data Models"): PK `keyId`; GSI `byAgency` (PK `agencyId`,
// SK `keyId`, projection ALL). Only `SHA-256(secret)` is stored (Req 3.2).

export const MACHINE_ACCESS_KEY_ATTRIBUTE = 'keyId';
export const MACHINE_ACCESS_BY_AGENCY_INDEX = 'byAgency';
export const MACHINE_ACCESS_BY_AGENCY_PK_ATTRIBUTE = 'agencyId';
export const MACHINE_ACCESS_BY_AGENCY_SK_ATTRIBUTE = 'keyId';

/** Default minimum interval between two `lastUsedAt` writes (design: "Authenticator"). */
export const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/** Stored machine access; everything of Req 3.7 plus the secret hash. */
export const machineAccessRecordSchema = z.object({
  keyId: EntityId,
  agencyId: EntityId,
  label: z
    .string()
    .min(MANAGEMENT_BOUNDS.machineAccessLabel.min)
    .max(MANAGEMENT_BOUNDS.machineAccessLabel.max),
  keyHash: z.string().min(1),
  permissions: z.array(PermissionSchema),
  /** `userId` of the creating user. */
  createdBy: EntityId,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime.optional(),
  revokedAt: IsoDateTime.optional(),
  lastUsedAt: IsoDateTime.optional(),
});

export type MachineAccessRecord = z.infer<typeof machineAccessRecordSchema>;

export interface MachineAccessStore {
  /** `null` if unknown. */
  get(keyId: string): Promise<MachineAccessRecord | null>;
  /** Machine accesses of an agency (revoked ones included), ordered by `keyId`. */
  listByAgency(agencyId: string, page: KeyPageRequest): Promise<KeyPage<MachineAccessRecord>>;
  /** Stores a new machine access; throws if the `keyId` exists. */
  create(record: MachineAccessRecord): Promise<void>;
  /** Sets `revokedAt` once (idempotent, the first time is kept); `null` if unknown. */
  revoke(keyId: string, revokedAt: string): Promise<MachineAccessRecord | null>;
  /**
   * Sets `lastUsedAt = now` iff it is unset or at least `minIntervalMs` old; `true` if written.
   * Timestamps are written via `toISOString()`, so they compare lexicographically.
   */
  touchLastUsed(keyId: string, now: number, minIntervalMs?: number): Promise<boolean>;
}

export class InMemoryMachineAccessStore implements MachineAccessStore {
  private readonly accesses = new Map<string, MachineAccessRecord>();

  constructor(records: readonly MachineAccessRecord[] = []) {
    for (const record of records) {
      this.accesses.set(record.keyId, machineAccessRecordSchema.parse(record));
    }
  }

  async get(keyId: string): Promise<MachineAccessRecord | null> {
    const record = this.accesses.get(keyId);
    return record === undefined ? null : copy(record);
  }

  async listByAgency(
    agencyId: string,
    page: KeyPageRequest,
  ): Promise<KeyPage<MachineAccessRecord>> {
    const matching = [...this.accesses.values()].filter((record) => record.agencyId === agencyId);
    const result = pageBySortKey(matching, (record) => record.keyId, 'keyId', page);
    return { ...result, items: result.items.map(copy) };
  }

  async create(record: MachineAccessRecord): Promise<void> {
    if (this.accesses.has(record.keyId)) {
      throw new Error(`Machine access ${record.keyId} already exists`);
    }
    this.accesses.set(record.keyId, machineAccessRecordSchema.parse(record));
  }

  async revoke(keyId: string, revokedAt: string): Promise<MachineAccessRecord | null> {
    const current = this.accesses.get(keyId);
    if (current === undefined) return null;
    const updated = { ...current, revokedAt: current.revokedAt ?? IsoDateTime.parse(revokedAt) };
    this.accesses.set(keyId, updated);
    return copy(updated);
  }

  async touchLastUsed(
    keyId: string,
    now: number,
    minIntervalMs = LAST_USED_WRITE_INTERVAL_MS,
  ): Promise<boolean> {
    const current = this.accesses.get(keyId);
    if (current === undefined) return false;
    const threshold = new Date(now - minIntervalMs).toISOString();
    if (current.lastUsedAt !== undefined && current.lastUsedAt > threshold) return false;
    this.accesses.set(keyId, { ...current, lastUsedAt: new Date(now).toISOString() });
    return true;
  }
}

function copy(record: MachineAccessRecord): MachineAccessRecord {
  return { ...record, permissions: [...record.permissions] };
}

export interface DynamoDbMachineAccessStoreOptions {
  client: DynamoDBDocumentClient;
  /** `MachineAccess` table. */
  tableName: string;
}

/** `MachineAccess` table; malformed items throw instead of granting access. */
export class DynamoDbMachineAccessStore implements MachineAccessStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor({ client, tableName }: DynamoDbMachineAccessStoreOptions) {
    this.client = client;
    this.tableName = tableName;
  }

  async get(keyId: string): Promise<MachineAccessRecord | null> {
    const out = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { keyId }, ConsistentRead: true }),
    );
    return out.Item === undefined ? null : machineAccessRecordSchema.parse(out.Item);
  }

  async listByAgency(
    agencyId: string,
    page: KeyPageRequest,
  ): Promise<KeyPage<MachineAccessRecord>> {
    return queryIndexPage(
      this.client,
      {
        tableName: this.tableName,
        indexName: MACHINE_ACCESS_BY_AGENCY_INDEX,
        partitionAttribute: MACHINE_ACCESS_BY_AGENCY_PK_ATTRIBUTE,
        partitionValue: agencyId,
      },
      page,
      (item) => machineAccessRecordSchema.parse(item),
    );
  }

  async create(record: MachineAccessRecord): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: machineAccessRecordSchema.parse(record),
        ConditionExpression: 'attribute_not_exists(#keyId)',
        ExpressionAttributeNames: { '#keyId': MACHINE_ACCESS_KEY_ATTRIBUTE },
      }),
    );
  }

  async revoke(keyId: string, revokedAt: string): Promise<MachineAccessRecord | null> {
    try {
      const out = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { keyId },
          UpdateExpression: 'SET #revokedAt = if_not_exists(#revokedAt, :revokedAt)',
          ConditionExpression: 'attribute_exists(#keyId)',
          ExpressionAttributeNames: {
            '#revokedAt': 'revokedAt',
            '#keyId': MACHINE_ACCESS_KEY_ATTRIBUTE,
          },
          ExpressionAttributeValues: { ':revokedAt': IsoDateTime.parse(revokedAt) },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return machineAccessRecordSchema.parse(out.Attributes);
    } catch (error) {
      if (isConditionalCheckFailed(error)) return null;
      throw error;
    }
  }

  async touchLastUsed(
    keyId: string,
    now: number,
    minIntervalMs = LAST_USED_WRITE_INTERVAL_MS,
  ): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { keyId },
          UpdateExpression: 'SET #lastUsedAt = :now',
          ConditionExpression:
            'attribute_exists(#keyId) AND (attribute_not_exists(#lastUsedAt) OR #lastUsedAt <= :threshold)',
          ExpressionAttributeNames: {
            '#lastUsedAt': 'lastUsedAt',
            '#keyId': MACHINE_ACCESS_KEY_ATTRIBUTE,
          },
          ExpressionAttributeValues: {
            ':now': new Date(now).toISOString(),
            ':threshold': new Date(now - minIntervalMs).toISOString(),
          },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailed(error)) return false;
      throw error;
    }
  }
}
