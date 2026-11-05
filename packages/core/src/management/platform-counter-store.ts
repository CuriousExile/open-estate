import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import type { DynamoDbOp, InMemoryOp } from './transaction';

// `PlatformCounters` table (design: "Data Models"): PK `counter`; the item `counter = platform`
// holds `platformAdmins`, changed in the same transaction as the membership (Req 10.9, 10.10).

export const PLATFORM_COUNTERS_KEY_ATTRIBUTE = 'counter';
export const PLATFORM_COUNTER_KEY = 'platform';

const counterItemSchema = z.object({ platformAdmins: z.int().min(0).default(0) });

export interface PlatformCounterStore<Op> {
  /** Strongly consistent; 0 if the counter item does not exist yet. */
  platformAdmins(): Promise<number>;
  /**
   * `platformAdmins += delta` (label `platform.admins`). `+1` creates the item if missing; `-1`
   * requires at least one remaining Plattform_Admin, i.e. `platformAdmins > 1` (Req 10.9).
   */
  adjustPlatformAdminsOp(delta: 1 | -1): Op;
}

/** Fake with transaction semantics via {@link InMemoryTransactor}. */
export class InMemoryPlatformCounterStore implements PlatformCounterStore<InMemoryOp> {
  private admins: number;

  constructor({ platformAdmins = 0 }: { platformAdmins?: number } = {}) {
    this.admins = platformAdmins;
  }

  async platformAdmins(): Promise<number> {
    return this.admins;
  }

  adjustPlatformAdminsOp(delta: 1 | -1): InMemoryOp {
    return {
      label: 'platform.admins',
      target: `PlatformCounters#${PLATFORM_COUNTER_KEY}`,
      check: () => delta > 0 || this.admins > 1,
      apply: () => {
        this.admins += delta;
      },
    };
  }
}

export interface DynamoDbPlatformCounterStoreOptions {
  client: DynamoDBDocumentClient;
  /** `PlatformCounters` table. */
  tableName: string;
}

export class DynamoDbPlatformCounterStore implements PlatformCounterStore<DynamoDbOp> {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor({ client, tableName }: DynamoDbPlatformCounterStoreOptions) {
    this.client = client;
    this.tableName = tableName;
  }

  async platformAdmins(): Promise<number> {
    const out = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { [PLATFORM_COUNTERS_KEY_ATTRIBUTE]: PLATFORM_COUNTER_KEY },
        ConsistentRead: true,
      }),
    );
    return out.Item === undefined ? 0 : counterItemSchema.parse(out.Item).platformAdmins;
  }

  adjustPlatformAdminsOp(delta: 1 | -1): DynamoDbOp {
    return {
      label: 'platform.admins',
      item: {
        Update: {
          TableName: this.tableName,
          Key: { [PLATFORM_COUNTERS_KEY_ATTRIBUTE]: PLATFORM_COUNTER_KEY },
          UpdateExpression: 'ADD #admins :delta',
          ExpressionAttributeNames: { '#admins': 'platformAdmins' },
          ...(delta > 0
            ? { ExpressionAttributeValues: { ':delta': delta } }
            : {
                ConditionExpression: '#admins > :one',
                ExpressionAttributeValues: { ':delta': delta, ':one': 1 },
              }),
        },
      },
    };
  }
}
