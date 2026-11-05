import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Key-based pagination of the management stores: the cursor is the base64url-encoded
// `LastEvaluatedKey` (DynamoDB) or the key of the last returned item (fakes).

export interface KeyPageRequest {
  limit: number;
  cursor?: string;
}

export interface KeyPage<T> {
  items: T[];
  /** Present if more items may follow. */
  nextCursor?: string;
}

/** The cursor was not issued by a store (maps to 400 in the API layer). */
export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid page cursor');
    this.name = 'InvalidCursorError';
  }
}

export function encodeKeyCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

export function decodeKeyCursor(cursor: string): Record<string, unknown> {
  let key: unknown;
  try {
    key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  if (typeof key !== 'object' || key === null || Array.isArray(key)) {
    throw new InvalidCursorError();
  }
  return key as Record<string, unknown>;
}

/**
 * Fake pagination: `items` ordered by `sortKey`, the cursor holds the sort key of the last item
 * under `cursorAttribute`; `nextCursor` only if more items remain.
 */
export function pageBySortKey<T>(
  items: readonly T[],
  sortKey: (item: T) => string,
  cursorAttribute: string,
  { limit, cursor }: KeyPageRequest,
): KeyPage<T> {
  const sorted = [...items].sort((a, b) => compare(sortKey(a), sortKey(b)));
  let start = 0;
  if (cursor !== undefined) {
    const after = decodeKeyCursor(cursor)[cursorAttribute];
    if (typeof after !== 'string') throw new InvalidCursorError();
    start = sorted.findIndex((item) => sortKey(item) > after);
    if (start < 0) start = sorted.length;
  }
  const page = sorted.slice(start, start + limit);
  const last = page.at(-1);
  return {
    items: page,
    ...(last !== undefined &&
      start + limit < sorted.length && {
        nextCursor: encodeKeyCursor({ [cursorAttribute]: sortKey(last) }),
      }),
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface IndexQuery {
  tableName: string;
  indexName: string;
  partitionAttribute: string;
  partitionValue: string;
}

/** One `Query` page on a GSI (projection ALL); every item is parsed, malformed items throw. */
export async function queryIndexPage<T>(
  client: DynamoDBDocumentClient,
  { tableName, indexName, partitionAttribute, partitionValue }: IndexQuery,
  { limit, cursor }: KeyPageRequest,
  parse: (item: unknown) => T,
): Promise<KeyPage<T>> {
  const out = await client.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: indexName,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': partitionAttribute },
      ExpressionAttributeValues: { ':pk': partitionValue },
      Limit: limit,
      ...(cursor !== undefined && { ExclusiveStartKey: decodeKeyCursor(cursor) }),
    }),
  );
  return toKeyPage(out.Items, out.LastEvaluatedKey, parse);
}

export function toKeyPage<T>(
  items: Record<string, unknown>[] | undefined,
  lastEvaluatedKey: Record<string, unknown> | undefined,
  parse: (item: unknown) => T,
): KeyPage<T> {
  return {
    items: (items ?? []).map(parse),
    ...(lastEvaluatedKey !== undefined && { nextCursor: encodeKeyCursor(lastEvaluatedKey) }),
  };
}
