import { randomUUID } from 'node:crypto';
import {
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  ActorRefSchema,
  ChannelSchema,
  EntityId,
  IsoDateTime,
  MANAGEMENT_BOUNDS,
  type ActorRef,
} from '@open-estate/shared';
import { z } from 'zod';
import {
  decodeKeyCursor,
  encodeKeyCursor,
  InvalidCursorError,
  type KeyPage,
  type KeyPageRequest,
} from './key-page';

// Audit_Log of the management (design: "Audit_Log", Req 2.8, 11). Extends the existing `AuditLog`
// table of the admin package (categories `access-config`, `deletion`) by the categories
// `management` and `access-denied` and the GSI `byAgency`. Append-only: neither interface nor
// implementation offers an update or delete (Req 11.3).

/** Partition key of the `AuditLog` table (shared with `@open-estate/admin`). */
export const AUDIT_LOG_PARTITION_KEY = 'category';
/** Sort key of the `AuditLog` table: `<timestamp>#<id>` (shared with `@open-estate/admin`). */
export const AUDIT_LOG_SORT_KEY = 'timestampId';
/** GSI for agency-scoped queries (Req 11.5): PK `agencyId`, SK `timestampId`, projection ALL. */
export const AUDIT_LOG_BY_AGENCY_INDEX = 'byAgency';
export const AUDIT_LOG_BY_AGENCY_PK_ATTRIBUTE = 'agencyId';
export const AUDIT_LOG_BY_AGENCY_SK_ATTRIBUTE = AUDIT_LOG_SORT_KEY;

/** Categories written by the {@link AuditService}; platform queries read exactly these. */
export const AUDIT_SERVICE_CATEGORIES = ['management', 'access-denied'] as const;
export type AuditServiceCategory = (typeof AUDIT_SERVICE_CATEGORIES)[number];

const AuditCategorySchema = z.enum(AUDIT_SERVICE_CATEGORIES);
const AuditTarget = z.string().min(1).max(256);
const AuditAction = z.string().min(MANAGEMENT_BOUNDS.action.min).max(MANAGEMENT_BOUNDS.action.max);
const AuditResult = z.string().min(1).max(100);

/**
 * Entry to append. Strict: only identifiers, codes and metadata, no free-form details, so no
 * PII values can enter the log (Req 9.4). `actor` is absent for unauthenticated calls (Req 2.8).
 */
export const auditAppendEntrySchema = z.strictObject({
  category: AuditCategorySchema,
  actor: ActorRefSchema.optional(),
  channel: ChannelSchema.optional(),
  /** What happened, e.g. `agency.created`, `machine-access.revoked`, `listing.update`. */
  action: AuditAction,
  /** Target resource, e.g. `agency/a1`, `listing/l1`. */
  target: AuditTarget,
  agencyId: EntityId.optional(),
  /** Outcome code, e.g. `success`, `UNAUTHENTICATED`, `FORBIDDEN`. */
  result: AuditResult,
});
export type AuditAppendEntry = z.input<typeof auditAppendEntrySchema>;

/** Stored entry as returned by queries (shape of the `AuditEntry` view plus the category). */
export const auditRecordSchema = z.object({
  id: z.string().min(1),
  timestamp: IsoDateTime,
  category: AuditCategorySchema,
  actor: ActorRefSchema.optional(),
  channel: ChannelSchema.optional(),
  action: z.string(),
  target: z.string(),
  agencyId: EntityId.optional(),
  result: z.string(),
});
export type AuditRecord = z.infer<typeof auditRecordSchema>;

/** Filters of `GET /audit-log` (Req 11.4); `from`/`to` inclusive ISO-8601 timestamps. */
export interface AuditQuery {
  /** Actor id: `userId`, `keyId`, `connectorId` or `userArn` (see {@link auditActorId}). */
  actor?: string;
  /** Required for Agentur_Admins, set by the caller to their agency (Req 11.5). */
  agencyId?: string;
  action?: string;
  from?: string;
  to?: string;
}

/** Write side, adopted by every use case that audits (Req 2.8, 11.1, 11.2). */
export interface AuditService {
  /** Appends a new entry with a fresh id and the current time; never replaces an entry. */
  append(entry: AuditAppendEntry): Promise<AuditRecord>;
}

/** Read side for `GET /audit-log`. */
export interface AuditLogReader {
  /** Matching entries, newest first; each entry exactly once across all pages. */
  query(filter: AuditQuery, page: KeyPageRequest): Promise<KeyPage<AuditRecord>>;
}

/** Filterable id of an actor. */
export function auditActorId(actor: ActorRef): string {
  switch (actor.kind) {
    case 'user':
      return actor.userId;
    case 'machine':
      return actor.keyId;
    case 'connector':
      return actor.connectorId;
    case 'iam':
      return actor.userArn;
  }
}

export interface AuditServiceOptions {
  /** Clock; injectable for tests. */
  now?: () => number;
  /** Generates entry ids; injectable for tests. */
  newId?: () => string;
}

function createRecord(
  entry: AuditAppendEntry,
  { now = Date.now, newId = randomUUID }: AuditServiceOptions,
): AuditRecord {
  const parsed = auditAppendEntrySchema.parse(entry);
  return auditRecordSchema.parse({
    ...parsed,
    id: newId(),
    timestamp: new Date(now()).toISOString(),
  });
}

const sortKeyOf = (record: Pick<AuditRecord, 'timestamp' | 'id'>): string =>
  `${record.timestamp}#${record.id}`;

/**
 * Inclusive sort-key bounds of a period. Timestamps are stored via `toISOString()` (fixed width),
 * so the bounds compare lexicographically; `undefined` if the period is empty.
 */
function sortKeyRange(filter: AuditQuery): { lower?: string; upper?: string } | undefined {
  const lower = filter.from === undefined ? undefined : `${toUtc(filter.from)}#`;
  const upper = filter.to === undefined ? undefined : `${toUtc(filter.to)}#\uffff`;
  if (lower !== undefined && upper !== undefined && lower > upper) return undefined;
  return { ...(lower !== undefined && { lower }), ...(upper !== undefined && { upper }) };
}

function toUtc(value: string): string {
  return new Date(IsoDateTime.parse(value)).toISOString();
}

interface AuditCursor {
  category: AuditServiceCategory;
  timestampId: string;
}

function encodeCursor(record: AuditRecord): string {
  return encodeKeyCursor({
    [AUDIT_LOG_PARTITION_KEY]: record.category,
    [AUDIT_LOG_SORT_KEY]: sortKeyOf(record),
  });
}

function decodeCursor(cursor: string): AuditCursor {
  const key = decodeKeyCursor(cursor);
  const category = AuditCategorySchema.safeParse(key[AUDIT_LOG_PARTITION_KEY]);
  const timestampId = key[AUDIT_LOG_SORT_KEY];
  if (!category.success || typeof timestampId !== 'string') throw new InvalidCursorError();
  return { category: category.data, timestampId };
}

/** Newest first; ids are unique, so the sort key is a total order. */
const newestFirst = (a: AuditRecord, b: AuditRecord): number => {
  const ka = sortKeyOf(a);
  const kb = sortKeyOf(b);
  return ka < kb ? 1 : ka > kb ? -1 : 0;
};

function toPage(sorted: AuditRecord[], limit: number): KeyPage<AuditRecord> {
  const items = sorted.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    ...(last !== undefined && sorted.length > limit && { nextCursor: encodeCursor(last) }),
  };
}

/** Fake for tests with the same query semantics as {@link DynamoDbAuditService}. */
export class InMemoryAuditService implements AuditService, AuditLogReader {
  private readonly records: AuditRecord[] = [];
  private readonly options: AuditServiceOptions;

  constructor(options: AuditServiceOptions = {}) {
    this.options = options;
  }

  /** All entries in append order (copies). */
  get entries(): AuditRecord[] {
    return this.records.map((record) => structuredClone(record));
  }

  async append(entry: AuditAppendEntry): Promise<AuditRecord> {
    const record = createRecord(entry, this.options);
    this.records.push(record);
    return structuredClone(record);
  }

  async query(
    filter: AuditQuery,
    { limit, cursor }: KeyPageRequest,
  ): Promise<KeyPage<AuditRecord>> {
    const after = cursor === undefined ? undefined : decodeCursor(cursor).timestampId;
    const range = sortKeyRange(filter);
    if (range === undefined) return { items: [] };
    const matching = this.records.filter((record) => {
      const key = sortKeyOf(record);
      return (
        (after === undefined || key < after) &&
        (range.lower === undefined || key >= range.lower) &&
        (range.upper === undefined || key <= range.upper) &&
        (filter.agencyId === undefined || record.agencyId === filter.agencyId) &&
        (filter.action === undefined || record.action === filter.action) &&
        (filter.actor === undefined ||
          (record.actor !== undefined && auditActorId(record.actor) === filter.actor))
      );
    });
    return toPage(
      matching.sort(newestFirst).map((record) => structuredClone(record)),
      limit,
    );
  }
}

export interface DynamoDbAuditServiceOptions extends AuditServiceOptions {
  client: DynamoDBDocumentClient;
  /** `AuditLog` table. */
  tableName: string;
}

/** Stored attribute holding {@link auditActorId} for the actor filter. */
const ACTOR_ID_ATTRIBUTE = 'actorId';

/**
 * One `PutItem` per entry (no condition needed: the sort key contains a fresh UUID). Queries use
 * the GSI `byAgency` if an agency is given, otherwise one query per category; the period is part
 * of the key condition, actor and action are filters (design: "Audit_Log").
 */
export class DynamoDbAuditService implements AuditService, AuditLogReader {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly options: AuditServiceOptions;

  constructor({ client, tableName, ...options }: DynamoDbAuditServiceOptions) {
    this.client = client;
    this.tableName = tableName;
    this.options = options;
  }

  async append(entry: AuditAppendEntry): Promise<AuditRecord> {
    const record = createRecord(entry, this.options);
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...record,
          [AUDIT_LOG_PARTITION_KEY]: record.category,
          [AUDIT_LOG_SORT_KEY]: sortKeyOf(record),
          ...(record.actor !== undefined && { [ACTOR_ID_ATTRIBUTE]: auditActorId(record.actor) }),
        },
      }),
    );
    return record;
  }

  async query(
    filter: AuditQuery,
    { limit, cursor }: KeyPageRequest,
  ): Promise<KeyPage<AuditRecord>> {
    const after = cursor === undefined ? undefined : decodeCursor(cursor);
    const range = sortKeyRange(filter);
    if (range === undefined) return { items: [] };
    // One more than requested tells whether a next page exists.
    const wanted = limit + 1;
    const partitions =
      filter.agencyId === undefined
        ? AUDIT_SERVICE_CATEGORIES.map((category) =>
            this.collect(
              { partitionAttribute: AUDIT_LOG_PARTITION_KEY, partitionValue: category },
              after && { ...after, category },
              range,
              filter,
              wanted,
            ),
          )
        : [
            this.collect(
              {
                indexName: AUDIT_LOG_BY_AGENCY_INDEX,
                partitionAttribute: AUDIT_LOG_BY_AGENCY_PK_ATTRIBUTE,
                partitionValue: filter.agencyId,
              },
              after && { ...after, [AUDIT_LOG_BY_AGENCY_PK_ATTRIBUTE]: filter.agencyId },
              range,
              filter,
              wanted,
            ),
          ];
    const merged = (await Promise.all(partitions)).flat().sort(newestFirst);
    return toPage(merged, limit);
  }

  /** Up to `wanted` matching entries of one partition, newest first, older than `startKey`. */
  private async collect(
    partition: { indexName?: string; partitionAttribute: string; partitionValue: string },
    startKey: Record<string, unknown> | undefined,
    range: { lower?: string; upper?: string },
    filter: AuditQuery,
    wanted: number,
  ): Promise<AuditRecord[]> {
    const input = buildQuery(this.tableName, partition, range, filter);
    const found: AuditRecord[] = [];
    let exclusiveStartKey = startKey;
    do {
      const out = await this.client.send(
        new QueryCommand({
          ...input,
          Limit: wanted - found.length,
          ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
        }),
      );
      for (const item of out.Items ?? []) found.push(auditRecordSchema.parse(item));
      exclusiveStartKey = out.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined && found.length < wanted);
    return found;
  }
}

function buildQuery(
  tableName: string,
  partition: { indexName?: string; partitionAttribute: string; partitionValue: string },
  { lower, upper }: { lower?: string; upper?: string },
  filter: AuditQuery,
): Omit<QueryCommandInput, 'Limit' | 'ExclusiveStartKey'> {
  const names: Record<string, string> = { '#pk': partition.partitionAttribute };
  const values: Record<string, unknown> = { ':pk': partition.partitionValue };
  let keyCondition = '#pk = :pk';
  if (lower !== undefined || upper !== undefined) {
    names['#sk'] = AUDIT_LOG_SORT_KEY;
    if (lower !== undefined) values[':lower'] = lower;
    if (upper !== undefined) values[':upper'] = upper;
    keyCondition +=
      lower !== undefined && upper !== undefined
        ? ' AND #sk BETWEEN :lower AND :upper'
        : lower !== undefined
          ? ' AND #sk >= :lower'
          : ' AND #sk <= :upper';
  }
  const filters: string[] = [];
  if (filter.actor !== undefined) {
    names['#actorId'] = ACTOR_ID_ATTRIBUTE;
    values[':actor'] = filter.actor;
    filters.push('#actorId = :actor');
  }
  if (filter.action !== undefined) {
    names['#action'] = 'action';
    values[':action'] = filter.action;
    filters.push('#action = :action');
  }
  return {
    TableName: tableName,
    ...(partition.indexName !== undefined && { IndexName: partition.indexName }),
    KeyConditionExpression: keyCondition,
    ...(filters.length > 0 && { FilterExpression: filters.join(' AND ') }),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ScanIndexForward: false,
  };
}
