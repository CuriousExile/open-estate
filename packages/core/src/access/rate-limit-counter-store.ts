import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export interface CounterIncrement {
  /** `clientId#windowStart` (window start in epoch seconds). */
  counterKey: string;
  /** Maximum number of admitted requests in this window (N). */
  limit: number;
  /** Window end in epoch seconds; used as TTL. */
  expiresAtEpochSeconds: number;
}

/**
 * Fixed-window counters shared by Search_API and MCP_Server (Req 17.1).
 * `tryIncrement` atomically increments the counter iff it is below `limit`; only admitted
 * requests are counted, so at most N requests per window and client are admitted.
 */
export interface RateLimitCounterStore {
  /** `true` = admitted and counted; `false` = limit reached, nothing changed. */
  tryIncrement(input: CounterIncrement): Promise<boolean>;
}

/** Fake for tests; expired windows are dropped lazily on access. */
export class InMemoryRateLimitCounterStore implements RateLimitCounterStore {
  private readonly counters = new Map<string, { count: number; expiresAtEpochSeconds: number }>();

  async tryIncrement({ counterKey, limit, expiresAtEpochSeconds }: CounterIncrement) {
    const current = this.counters.get(counterKey);
    const count = current?.count ?? 0;
    if (count >= limit) return false;
    this.counters.set(counterKey, { count: count + 1, expiresAtEpochSeconds });
    return true;
  }

  /** Admitted requests counted for `counterKey` (0 if none). */
  count(counterKey: string): number {
    return this.counters.get(counterKey)?.count ?? 0;
  }
}

export const RATE_LIMIT_COUNTER_KEY_ATTRIBUTE = 'counterKey';
export const RATE_LIMIT_COUNTER_TTL_ATTRIBUTE = 'expiresAt';

export interface DynamoDbRateLimitCounterStoreOptions {
  client: DynamoDBDocumentClient;
  /** `RateLimitCounters` table. */
  tableName: string;
  /** Partition key attribute. Default `counterKey`. */
  keyAttribute?: string;
  /** TTL attribute (epoch seconds) configured on the table. Default `expiresAt`. */
  ttlAttribute?: string;
}

/**
 * Conditional `UpdateItem`: `ADD count 1` only if `count` does not exist or is `< N`;
 * a `ConditionalCheckFailedException` means the limit is reached. The TTL is set to the
 * window end so DynamoDB removes old windows.
 */
export class DynamoDbRateLimitCounterStore implements RateLimitCounterStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly keyAttribute: string;
  private readonly ttlAttribute: string;

  constructor({
    client,
    tableName,
    keyAttribute = RATE_LIMIT_COUNTER_KEY_ATTRIBUTE,
    ttlAttribute = RATE_LIMIT_COUNTER_TTL_ATTRIBUTE,
  }: DynamoDbRateLimitCounterStoreOptions) {
    this.client = client;
    this.tableName = tableName;
    this.keyAttribute = keyAttribute;
    this.ttlAttribute = ttlAttribute;
  }

  async tryIncrement({ counterKey, limit, expiresAtEpochSeconds }: CounterIncrement) {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { [this.keyAttribute]: counterKey },
          // `count` and `ttl` are DynamoDB reserved words, hence attribute name placeholders.
          UpdateExpression: 'ADD #count :one SET #ttl = :ttl',
          ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
          ExpressionAttributeNames: { '#count': 'count', '#ttl': this.ttlAttribute },
          ExpressionAttributeValues: { ':one': 1, ':limit': limit, ':ttl': expiresAtEpochSeconds },
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }
}
