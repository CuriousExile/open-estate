import { randomUUID } from 'node:crypto';
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** Partition keys of the `AuditLog` table (design.md, data model). `deletion` is written by 14.3. */
export const AUDIT_CATEGORIES = ['access-config', 'deletion'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export interface AuditEntry {
  type: AuditCategory;
  /** What happened, e.g. `api-key.created`. */
  action: string;
  /** IAM `userArn` of the administrator. */
  actor: string;
  /** ISO-8601 timestamp of the change. */
  at: string;
  /** Event data. Never secrets (API keys, key hashes) and never PII values (Req 18.8). */
  details: Record<string, unknown>;
  /**
   * Stable id of the event. Appending an entry with the same `type`, `at` and `id` again replaces
   * it instead of adding a duplicate, so re-run workflow steps can audit idempotently. Without an
   * id every append is a new entry.
   */
  id?: string;
}

/** Append-only audit trail shared by access-config changes (14.1) and deletions (14.3). */
export interface AuditLog {
  append(entry: AuditEntry): Promise<void>;
}

/** Fake for tests; `entries` in append order. */
export class InMemoryAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = [];

  async append(entry: AuditEntry): Promise<void> {
    const copy = structuredClone(entry);
    const index =
      entry.id === undefined
        ? -1
        : this.entries.findIndex(
            (e) => e.type === entry.type && e.at === entry.at && e.id === entry.id,
          );
    if (index === -1) this.entries.push(copy);
    else this.entries[index] = copy;
  }
}

export const AUDIT_LOG_PARTITION_KEY = 'category';
export const AUDIT_LOG_SORT_KEY = 'timestampId';

export interface DynamoDbAuditLogOptions {
  client: DynamoDBDocumentClient;
  /** `AuditLog` table; PK `category`, SK `timestampId` (`<at>#<uuid>`). */
  tableName: string;
  /** Generates the unique suffix of the sort key; injectable for tests. */
  newId?: () => string;
}

/**
 * One `PutItem` per entry; the sort key `<at>#<id or uuid>` keeps entries ordered by time and
 * unique (and makes appends with a stable `id` idempotent).
 */
export class DynamoDbAuditLog implements AuditLog {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly newId: () => string;

  constructor({ client, tableName, newId = randomUUID }: DynamoDbAuditLogOptions) {
    this.client = client;
    this.tableName = tableName;
    this.newId = newId;
  }

  async append({ type, action, actor, at, details, id }: AuditEntry): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          [AUDIT_LOG_PARTITION_KEY]: type,
          [AUDIT_LOG_SORT_KEY]: `${at}#${id ?? this.newId()}`,
          action,
          actor,
          at,
          details,
        },
      }),
    );
  }
}
