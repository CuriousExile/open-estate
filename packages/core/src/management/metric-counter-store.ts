import {
  GetCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import type { DynamoDbOp, InMemoryOp, TransactWriteItem } from './transaction';

// `MetricCounters` table (design: "DynamoDB-Tabellen", "Monitoring"): PK `scope`
// (`agency#{id}`, `listing#{id}`), SK `sk` = `code#current` (current value) or `code#{YYYY-MM-DD}`
// (daily value with TTL). Dimension values are part of the code, e.g. `listing.status.ACTIVE`.

export const METRIC_COUNTERS_PK_ATTRIBUTE = 'scope';
export const METRIC_COUNTERS_SK_ATTRIBUTE = 'sk';
export const METRIC_COUNTERS_VALUE_ATTRIBUTE = 'value';
export const METRIC_COUNTERS_TTL_ATTRIBUTE = 'expiresAt';

/** Daily values are kept 100 days (design: TTL of `MetricCounters`). */
export const METRIC_COUNTER_DAY_RETENTION_SECONDS = 100 * 24 * 60 * 60;

/** Scope id for listings without agency (platform values = sum over all agency scopes). */
export const NO_AGENCY_SCOPE_ID = '_none';

export const agencyScope = (agencyId: string | undefined): string =>
  `agency#${agencyId ?? NO_AGENCY_SCOPE_ID}`;

export const listingScope = (listingId: string): string => `listing#${listingId}`;

/** Sort key: `code#current`, or `code#{day}` with `day` = `YYYY-MM-DD` (UTC). */
export const counterSortKey = (code: string, day?: string): string => `${code}#${day ?? 'current'}`;

/** TTL (epoch seconds) of a daily value: end of `day` (UTC) plus the retention. */
export function dayCounterExpiry(day: string): number {
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(dayStart)) throw new Error(`Invalid counter day ${day}`);
  return dayStart / 1000 + 86_400 + METRIC_COUNTER_DAY_RETENTION_SECONDS;
}

export interface MetricCounterIncrement {
  scope: string;
  code: string;
  /** Absent = current value (no TTL); set = daily value of this UTC day. */
  day?: string;
  /** May be negative (status change, deletion). */
  delta: number;
}

const counterItemSchema = z.object({ [METRIC_COUNTERS_VALUE_ATTRIBUTE]: z.number() });

const dayItemSchema = z.object({ [METRIC_COUNTERS_SK_ATTRIBUTE]: z.string() });

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Daily value of one counter. */
export interface DayCounterValue {
  /** `YYYY-MM-DD` (UTC). */
  day: string;
  value: number;
}

function assertDay(day: string): void {
  if (!DAY_PATTERN.test(day)) throw new Error(`Invalid counter day ${day}`);
}

export interface MetricCounterStore<Op> {
  /** Atomic `ADD` outside a transaction (e.g. UsageAggregator). */
  add(increment: MetricCounterIncrement): Promise<void>;
  /** Counter value; 0 if never written. */
  get(scope: string, code: string, day?: string, signal?: AbortSignal): Promise<number>;
  /**
   * Daily values of `code` in `scope` for `fromDay ≤ day ≤ toDay` (both `YYYY-MM-DD`), ordered by
   * day; days never written are absent. One `Query` (key range) instead of one read per day.
   */
  listDays(
    scope: string,
    code: string,
    fromDay: string,
    toDay: string,
    signal?: AbortSignal,
  ): Promise<DayCounterValue[]>;
  /**
   * `ADD` inside a transaction (label `metric.add`), unconditional. One transaction may touch a
   * counter only once: sum the deltas per counter before building the operations.
   */
  addOp(increment: MetricCounterIncrement): Op;
}

/** Fake with transaction semantics via `InMemoryTransactor`. */
export class InMemoryMetricCounterStore implements MetricCounterStore<InMemoryOp> {
  private readonly values = new Map<string, number>();

  async add(increment: MetricCounterIncrement): Promise<void> {
    this.apply(increment);
  }

  async get(scope: string, code: string, day?: string): Promise<number> {
    return this.values.get(counterTarget(scope, code, day)) ?? 0;
  }

  async listDays(
    scope: string,
    code: string,
    fromDay: string,
    toDay: string,
  ): Promise<DayCounterValue[]> {
    assertDay(fromDay);
    assertDay(toDay);
    const prefix = `${scope}|${code}#`;
    return [...this.values.entries()]
      .flatMap(([key, value]) => {
        if (!key.startsWith(prefix)) return [];
        const day = key.slice(prefix.length);
        return DAY_PATTERN.test(day) && day >= fromDay && day <= toDay ? [{ day, value }] : [];
      })
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  }

  addOp(increment: MetricCounterIncrement): InMemoryOp {
    return {
      label: 'metric.add',
      target: `MetricCounters#${counterTarget(increment.scope, increment.code, increment.day)}`,
      check: () => true,
      apply: () => this.apply(increment),
    };
  }

  /** All counters as `scope|sk → value`, sorted by key (for assertions in tests). */
  entries(): [string, number][] {
    return [...this.values.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  private apply({ scope, code, day, delta }: MetricCounterIncrement): void {
    const key = counterTarget(scope, code, day);
    this.values.set(key, (this.values.get(key) ?? 0) + delta);
  }
}

const counterTarget = (scope: string, code: string, day?: string) =>
  `${scope}|${counterSortKey(code, day)}`;

export interface DynamoDbMetricCounterStoreOptions {
  client: DynamoDBDocumentClient;
  /** `MetricCounters` table; PK `scope`, SK `sk`, TTL attribute `expiresAt`. */
  tableName: string;
}

export class DynamoDbMetricCounterStore implements MetricCounterStore<DynamoDbOp> {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor({ client, tableName }: DynamoDbMetricCounterStoreOptions) {
    this.client = client;
    this.tableName = tableName;
  }

  async add(increment: MetricCounterIncrement): Promise<void> {
    await this.client.send(new UpdateCommand(this.addUpdate(increment)));
  }

  async get(scope: string, code: string, day?: string, signal?: AbortSignal): Promise<number> {
    const out = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: this.key(scope, code, day) }),
      signal === undefined ? {} : { abortSignal: signal },
    );
    return out.Item === undefined
      ? 0
      : counterItemSchema.parse(out.Item)[METRIC_COUNTERS_VALUE_ATTRIBUTE];
  }

  async listDays(
    scope: string,
    code: string,
    fromDay: string,
    toDay: string,
    signal?: AbortSignal,
  ): Promise<DayCounterValue[]> {
    assertDay(fromDay);
    assertDay(toDay);
    const prefix = `${code}#`;
    const values: DayCounterValue[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const out = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: '#pk = :scope AND #sk BETWEEN :from AND :to',
          ExpressionAttributeNames: {
            '#pk': METRIC_COUNTERS_PK_ATTRIBUTE,
            '#sk': METRIC_COUNTERS_SK_ATTRIBUTE,
          },
          ExpressionAttributeValues: {
            ':scope': scope,
            ':from': counterSortKey(code, fromDay),
            ':to': counterSortKey(code, toDay),
          },
          ExclusiveStartKey: startKey,
        }),
        signal === undefined ? {} : { abortSignal: signal },
      );
      for (const item of out.Items ?? []) {
        const day = dayItemSchema.parse(item)[METRIC_COUNTERS_SK_ATTRIBUTE].slice(prefix.length);
        if (!DAY_PATTERN.test(day)) continue;
        values.push({ day, value: counterItemSchema.parse(item)[METRIC_COUNTERS_VALUE_ATTRIBUTE] });
      }
      startKey = out.LastEvaluatedKey;
    } while (startKey !== undefined);
    return values;
  }

  addOp(increment: MetricCounterIncrement): DynamoDbOp {
    return { label: 'metric.add', item: { Update: this.addUpdate(increment) } };
  }

  private key(scope: string, code: string, day?: string) {
    return {
      [METRIC_COUNTERS_PK_ATTRIBUTE]: scope,
      [METRIC_COUNTERS_SK_ATTRIBUTE]: counterSortKey(code, day),
    };
  }

  /** `ADD value :delta` creates the item if missing; daily values also set the TTL. */
  private addUpdate({
    scope,
    code,
    day,
    delta,
  }: MetricCounterIncrement): NonNullable<TransactWriteItem['Update']> {
    const base = {
      TableName: this.tableName,
      Key: this.key(scope, code, day),
    };
    // `value` is a DynamoDB reserved word, hence the attribute name placeholder.
    return day === undefined
      ? {
          ...base,
          UpdateExpression: 'ADD #value :delta',
          ExpressionAttributeNames: { '#value': METRIC_COUNTERS_VALUE_ATTRIBUTE },
          ExpressionAttributeValues: { ':delta': delta },
        }
      : {
          ...base,
          UpdateExpression: 'ADD #value :delta SET #ttl = :ttl',
          ExpressionAttributeNames: {
            '#value': METRIC_COUNTERS_VALUE_ATTRIBUTE,
            '#ttl': METRIC_COUNTERS_TTL_ATTRIBUTE,
          },
          ExpressionAttributeValues: { ':delta': delta, ':ttl': dayCounterExpiry(day) },
        };
  }
}
