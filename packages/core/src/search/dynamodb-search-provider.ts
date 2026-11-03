import {
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { Listing } from '@open-estate/shared';
import { DOWNSTREAM_DEADLINE_MS } from '../deadlines';
import {
  fromListingItem,
  LISTINGS_BY_ID_INDEX,
  LISTINGS_BY_ID_PK_ATTRIBUTE,
  LISTINGS_BY_ID_PK_VALUE,
} from './listings-table';
import {
  effectivePageSize,
  type IntRange,
  type ResolvedQuery,
  type SearchProvider,
  type SearchResult,
} from './search-provider';
import { ServiceUnavailableError } from './service-unavailable-error';

/** Downstream budget per request (Req 9.1, 9.6); the shared `DOWNSTREAM_DEADLINE_MS`. */
export const DYNAMODB_REQUEST_DEADLINE_MS = DOWNSTREAM_DEADLINE_MS;

export interface DynamoDbSearchProviderOptions {
  client: Pick<DynamoDBDocumentClient, 'send'>;
  /** Listings table; partition key `id`, GSI `byId`. */
  tableName: string;
  /** Deadline for one `search`/`getById` call across all DynamoDB requests. */
  deadlineMs?: number;
  /** Creates the deadline signal; injectable for tests. Defaults to `AbortSignal.timeout`. */
  deadlineSignal?: (ms: number) => AbortSignal;
}

type Values = Record<string, unknown>;

/** Collects placeholders so that every attribute name and value is passed via `#n`/`:v`. */
class ExpressionBuilder {
  readonly names: Record<string, string> = {};
  readonly values: Values = {};
  private counter = 0;

  name(attribute: string): string {
    const placeholder = `#${attribute}`;
    this.names[placeholder] = attribute;
    return placeholder;
  }

  value(value: unknown): string {
    const placeholder = `:v${this.counter++}`;
    this.values[placeholder] = value;
    return placeholder;
  }

  range(attribute: string, range: IntRange | undefined, out: string[]): void {
    if (range?.min !== undefined) out.push(`${this.name(attribute)} >= ${this.value(range.min)}`);
    if (range?.max !== undefined) out.push(`${this.name(attribute)} <= ${this.value(range.max)}`);
  }
}

/** FilterExpression over the flat search fields; semantics of `matchesQuery`. */
function addFilter(q: ResolvedQuery, b: ExpressionBuilder): string | undefined {
  const parts: string[] = [];
  if (q.offerType !== undefined) {
    const [amount, currency] =
      q.offerType === 'SALE'
        ? ['saleAmountMinor', 'saleCurrency']
        : ['rentAmountMinor', 'rentCurrency'];
    parts.push(`attribute_exists(${b.name(amount)})`);
    if (q.price !== undefined) {
      parts.push(`${b.name(currency)} = ${b.value(q.price.currency)}`);
      b.range(amount, q.price, parts);
    }
  }
  b.range('roomsHalf', q.roomsHalf, parts);
  b.range('areaMinor', q.areaMinor, parts);
  if (q.cityNorm !== undefined) parts.push(`${b.name('cityNorm')} = ${b.value(q.cityNorm)}`);
  if (q.postalCode !== undefined) {
    parts.push(`${b.name('postalCode')} = ${b.value(q.postalCode)}`);
  }
  // Non-empty here (empty sets short-circuit in `search`); ≤ 50 types and a small tour allow-list
  // stay well below DynamoDB's limit of 100 IN operands.
  if (q.listingTypes !== undefined) {
    const operands = q.listingTypes.map((t) => b.value(t)).join(', ');
    parts.push(`${b.name('listingType')} IN (${operands})`);
  }
  if (q.tourHosts !== undefined) {
    const hosts = q.tourHosts.map((h) => `contains(${b.name('tourHosts')}, ${b.value(h)})`);
    parts.push(`(${hosts.join(' OR ')})`);
  }
  return parts.length > 0 ? parts.join(' AND ') : undefined;
}

/** Query input on the `byId` GSI: `id ASC`, exclusive start at `after`, filter on flat fields. */
export function buildSearchQueryInput(q: ResolvedQuery, tableName: string): QueryCommandInput {
  const b = new ExpressionBuilder();
  let keyCondition = `${b.name(LISTINGS_BY_ID_PK_ATTRIBUTE)} = ${b.value(LISTINGS_BY_ID_PK_VALUE)}`;
  if (q.after !== undefined) keyCondition += ` AND ${b.name('id')} > ${b.value(q.after)}`;
  const filter = addFilter(q, b);
  return {
    TableName: tableName,
    IndexName: LISTINGS_BY_ID_INDEX,
    KeyConditionExpression: keyCondition,
    ...(filter !== undefined ? { FilterExpression: filter } : {}),
    ExpressionAttributeNames: b.names,
    ExpressionAttributeValues: b.values,
    ScanIndexForward: true,
  };
}

/**
 * Default provider (design: "Indexierungs-Strategie und Ordnung"): Query on GSI `byId`
 * (PK `gsiPk = 'L'`, SK `id`) with a FilterExpression; reads page after page until `pageSize + 1`
 * matches (lookahead for `next`) or the index ends. Linear cost, intended for ≲ 10,000 listings.
 * Every failure or a deadline overrun surfaces as {@link ServiceUnavailableError} without a
 * partial result (Req 9.5, 9.6).
 */
export class DynamoDbSearchProvider implements SearchProvider {
  private readonly client: Pick<DynamoDBDocumentClient, 'send'>;
  private readonly tableName: string;
  private readonly deadlineMs: number;
  private readonly deadlineSignal: (ms: number) => AbortSignal;

  constructor({
    client,
    tableName,
    deadlineMs = DYNAMODB_REQUEST_DEADLINE_MS,
    deadlineSignal = (ms) => AbortSignal.timeout(ms),
  }: DynamoDbSearchProviderOptions) {
    this.client = client;
    this.tableName = tableName;
    this.deadlineMs = deadlineMs;
    this.deadlineSignal = deadlineSignal;
  }

  async search(q: ResolvedQuery): Promise<SearchResult> {
    // An empty IN/OR set matches nothing (as in `matchesQuery`) and is no valid expression.
    if (q.listingTypes?.length === 0 || q.tourHosts?.length === 0) return { items: [] };
    const pageSize = effectivePageSize(q.pageSize);
    const input = buildSearchQueryInput(q, this.tableName);

    const matches = await this.withDeadline(async (abortSignal) => {
      const found: Listing[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        abortSignal.throwIfAborted();
        const page = await this.client.send(
          new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey }),
          { abortSignal },
        );
        found.push(...(page.Items ?? []).map(fromListingItem));
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey !== undefined && found.length <= pageSize);
      return found;
    });

    if (matches.length <= pageSize) return { items: matches };
    const items = matches.slice(0, pageSize);
    return { items, next: { lastId: (items[pageSize - 1] as Listing).id } };
  }

  async getById(id: string): Promise<Listing | null> {
    const result = await this.withDeadline((abortSignal) =>
      this.client.send(new GetCommand({ TableName: this.tableName, Key: { id } }), {
        abortSignal,
      }),
    );
    return result.Item === undefined ? null : fromListingItem(result.Item);
  }

  private async withDeadline<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = this.deadlineSignal(this.deadlineMs);
    try {
      return await run(signal);
    } catch (cause) {
      const message = signal.aborted
        ? `DynamoDB deadline of ${this.deadlineMs} ms exceeded`
        : 'DynamoDB request failed';
      throw new ServiceUnavailableError(message, { cause });
    }
  }
}
