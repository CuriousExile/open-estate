import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  DELETION_REQUESTS_BY_STATUS_INDEX,
  DELETION_REQUESTS_BY_STATUS_PK_ATTRIBUTE,
  DELETION_REQUESTS_BY_STATUS_SK_ATTRIBUTE,
  DELETION_REQUESTS_KEY_ATTRIBUTE,
  type DeletionRequestStore,
  type RequestIdPage,
  type RequestIdPageRequest,
} from '@open-estate/core';
import {
  deletionRequestRecordSchema,
  type DeletionCriterion,
  type DeletionRequestRecord,
} from './deletion-model';

export type { DeletionRequestStore, RequestIdPage, RequestIdPageRequest };

const KEY = DELETION_REQUESTS_KEY_ATTRIBUTE;

/** Drops `undefined` optionals so parsed items satisfy `exactOptionalPropertyTypes`. */
function toRecord(item: unknown): DeletionRequestRecord {
  const { executedAt, notifiedAt, criterion, ...rest } = deletionRequestRecordSchema.parse(item);
  return {
    ...rest,
    criterion: criterion as DeletionCriterion,
    ...(executedAt !== undefined && { executedAt }),
    ...(notifiedAt !== undefined && { notifiedAt }),
  };
}

/** Fake for tests and in-process runs; stores and returns copies. */
export class InMemoryDeletionRequestStore implements DeletionRequestStore {
  private readonly records = new Map<string, DeletionRequestRecord>();

  async create(record: DeletionRequestRecord): Promise<void> {
    if (this.records.has(record.requestId)) {
      throw new Error(`Deletion request ${record.requestId} already exists`);
    }
    this.records.set(record.requestId, structuredClone(record));
  }

  async get(requestId: string): Promise<DeletionRequestRecord | null> {
    const record = this.records.get(requestId);
    return record === undefined ? null : structuredClone(record);
  }

  async markExecuted(requestId: string, executedAt: string): Promise<DeletionRequestRecord | null> {
    const record = this.records.get(requestId);
    if (record === undefined) return null;
    if (record.status === 'OPEN') {
      record.status = 'EXECUTED';
      record.executedAt = executedAt;
    }
    return structuredClone(record);
  }

  /** The cursor is the index of the next id in the sorted result. */
  async listOpenRequestedBefore(
    requestedBefore: string,
    { limit, cursor }: RequestIdPageRequest,
  ): Promise<RequestIdPage> {
    const before = Date.parse(requestedBefore);
    const ids = [...this.records.values()]
      .filter((record) => record.status === 'OPEN' && Date.parse(record.requestedAt) < before)
      .sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt))
      .map((record) => record.requestId);
    const start = cursor === undefined ? 0 : Number(cursor);
    const end = start + limit;
    return {
      requestIds: ids.slice(start, end),
      ...(end < ids.length && { nextCursor: String(end) }),
    };
  }

  async markNotified(requestId: string, notifiedAt: string): Promise<boolean> {
    const record = this.records.get(requestId);
    if (record?.status !== 'OPEN' || record.notifiedAt !== undefined) return false;
    record.notifiedAt = notifiedAt;
    return true;
  }

  /**
   * Counts one removed listing; called by {@link InMemoryDeletionListingStore} in the same
   * synchronous step as the removal (the DynamoDB adapter uses one transaction).
   */
  incrementRemoved(requestId: string): void {
    const record = this.records.get(requestId);
    if (record === undefined) throw new Error(`Deletion request ${requestId} not found`);
    record.removedCount += 1;
  }

  has(requestId: string): boolean {
    return this.records.has(requestId);
  }

  /** All records (copies), in creation order. */
  all(): DeletionRequestRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }
}

export interface DynamoDbDeletionRequestStoreOptions {
  client: DynamoDBDocumentClient;
  /** `DeletionRequests` table; partition key {@link DELETION_REQUESTS_KEY_ATTRIBUTE}. */
  tableName: string;
}

const isConditionFailure = (error: unknown) =>
  error instanceof Error && error.name === 'ConditionalCheckFailedException';

/**
 * `PutItem` with `attribute_not_exists(requestId)`; strongly consistent reads; the status change
 * is an `UpdateItem` conditioned on `status = OPEN`, so a re-run cannot overwrite `executedAt`.
 */
export class DynamoDbDeletionRequestStore implements DeletionRequestStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor({ client, tableName }: DynamoDbDeletionRequestStoreOptions) {
    this.client = client;
    this.tableName = tableName;
  }

  async create(record: DeletionRequestRecord): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: toRecord(record),
        ConditionExpression: 'attribute_not_exists(#key)',
        ExpressionAttributeNames: { '#key': KEY },
      }),
    );
  }

  async get(requestId: string): Promise<DeletionRequestRecord | null> {
    const out = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { [KEY]: requestId },
        ConsistentRead: true,
      }),
    );
    return out.Item === undefined ? null : toRecord(out.Item);
  }

  async markExecuted(requestId: string, executedAt: string): Promise<DeletionRequestRecord | null> {
    try {
      const out = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { [KEY]: requestId },
          UpdateExpression: 'SET #status = :executed, #executedAt = :executedAt',
          ConditionExpression: 'attribute_exists(#key) AND #status = :open',
          ExpressionAttributeNames: {
            '#key': KEY,
            '#status': 'status',
            '#executedAt': 'executedAt',
          },
          ExpressionAttributeValues: {
            ':executed': 'EXECUTED',
            ':open': 'OPEN',
            ':executedAt': executedAt,
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return toRecord(out.Attributes);
    } catch (error) {
      // Missing or already executed: report the current state.
      if (isConditionFailure(error)) return this.get(requestId);
      throw error;
    }
  }

  /**
   * `Query` on GSI {@link DELETION_REQUESTS_BY_STATUS_INDEX}; reads only the table key, so any
   * GSI projection works. `requestedAt` is compared as string, which is chronological because it
   * is always written as `Date#toISOString()` (UTC, fixed width).
   */
  async listOpenRequestedBefore(
    requestedBefore: string,
    { limit, cursor }: RequestIdPageRequest,
  ): Promise<RequestIdPage> {
    const out = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: DELETION_REQUESTS_BY_STATUS_INDEX,
        KeyConditionExpression: '#status = :open AND #requestedAt < :before',
        ProjectionExpression: '#key',
        ExpressionAttributeNames: {
          '#status': DELETION_REQUESTS_BY_STATUS_PK_ATTRIBUTE,
          '#requestedAt': DELETION_REQUESTS_BY_STATUS_SK_ATTRIBUTE,
          '#key': KEY,
        },
        ExpressionAttributeValues: { ':open': 'OPEN', ':before': requestedBefore },
        Limit: limit,
        ...(cursor !== undefined && { ExclusiveStartKey: decodeKey(cursor) }),
      }),
    );
    const last = out.LastEvaluatedKey;
    return {
      requestIds: (out.Items ?? []).map((item) => String(item[KEY])),
      ...(last !== undefined && { nextCursor: encodeKey(last) }),
    };
  }

  async markNotified(requestId: string, notifiedAt: string): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { [KEY]: requestId },
          UpdateExpression: 'SET #notifiedAt = :notifiedAt',
          ConditionExpression:
            'attribute_exists(#key) AND #status = :open AND attribute_not_exists(#notifiedAt)',
          ExpressionAttributeNames: {
            '#key': KEY,
            '#status': 'status',
            '#notifiedAt': 'notifiedAt',
          },
          ExpressionAttributeValues: { ':open': 'OPEN', ':notifiedAt': notifiedAt },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }
}

const encodeKey = (key: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');

function decodeKey(cursor: string): Record<string, unknown> {
  const key: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (typeof key !== 'object' || key === null || Array.isArray(key)) {
    throw new Error('Invalid deletion request cursor');
  }
  return key as Record<string, unknown>;
}
