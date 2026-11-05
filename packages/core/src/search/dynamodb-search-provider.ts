import {
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ListingStatusSchema, type Listing, type LocationsDocument } from '@open-estate/shared';
import { systemClock, TtlCache, type Clock } from '../access/ttl-cache';
import { DOWNSTREAM_DEADLINE_MS } from '../deadlines';
import {
  fromListingItem,
  type ListingVisibility,
  LISTINGS_BY_ID_INDEX,
  LISTINGS_BY_ID_PK_ATTRIBUTE,
  LISTINGS_BY_ID_PK_VALUE,
} from './listings-table';
import {
  aggregateLocations,
  effectivePageSize,
  type IntRange,
  type LocationEntry,
  type LocationQuery,
  type ResolvedQuery,
  type SearchProvider,
  type SearchResult,
  type StoredListing,
  withOwners,
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
  /** Clock of the locations cache; injectable for tests. */
  clock?: Clock;
  /** Lifetime of the cached location rows; default {@link DYNAMODB_LOCATIONS_CACHE_TTL_MS}. */
  locationsCacheTtlMs?: number;
}

/** `GET /locations` reads all public listings at most once per 5 minutes per Lambda instance. */
export const DYNAMODB_LOCATIONS_CACHE_TTL_MS = 5 * 60_000;

/** Projection query on `byId` that reads only country, city and owner of every `ACTIVE` listing. */
export function buildLocationsQueryInput(tableName: string): QueryCommandInput {
  return {
    TableName: tableName,
    IndexName: LISTINGS_BY_ID_INDEX,
    KeyConditionExpression: '#pk = :pk',
    ProjectionExpression: '#country, #address.#city, #agencyId',
    ExpressionAttributeNames: {
      '#pk': LISTINGS_BY_ID_PK_ATTRIBUTE,
      '#country': 'country',
      '#address': 'address',
      '#city': 'city',
      '#agencyId': 'agencyId',
    },
    ExpressionAttributeValues: { ':pk': LISTINGS_BY_ID_PK_VALUE },
  };
}

/** Location row of a projected item; items without country or city are skipped. */
function locationEntryOf(item: Record<string, unknown>): LocationEntry | undefined {
  const address = item['address'] as Record<string, unknown> | undefined;
  const city = address?.['city'];
  const country = item['country'];
  const agencyId = item['agencyId'];
  if (typeof city !== 'string' || typeof country !== 'string') return undefined;
  return { country, city, ...(typeof agencyId === 'string' && { agencyId }) };
}

type Values = Record<string, unknown>;

/** DynamoDB allows at most 100 operands per `IN`; longer exclusion lists are split. */
export const DYNAMODB_IN_OPERAND_LIMIT = 100;

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
      // One currency: plain AND terms (as without conversion); several: OR of AND groups.
      const conditions = q.price.map((price) => {
        const terms = [`${b.name(currency)} = ${b.value(price.currency)}`];
        b.range(amount, price, terms);
        return terms;
      });
      if (conditions.length === 1) parts.push(...(conditions[0] ?? []));
      else parts.push(`(${conditions.map((terms) => `(${terms.join(' AND ')})`).join(' OR ')})`);
    }
  }
  b.range('roomsHalf', q.roomsHalf, parts);
  b.range('areaMinor', q.areaMinor, parts);
  if (q.cityNorm !== undefined) parts.push(`${b.name('cityNorm')} = ${b.value(q.cityNorm)}`);
  if (q.postalCode !== undefined) {
    parts.push(`${b.name('postalCode')} = ${b.value(q.postalCode)}`);
  }
  if (q.country !== undefined) parts.push(`${b.name('country')} = ${b.value(q.country)}`);
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
  // `IN` on a missing attribute is false, so listings without agency stay visible (Req 1.9).
  const excluded = q.excludeAgencies ?? [];
  for (let i = 0; i < excluded.length; i += DYNAMODB_IN_OPERAND_LIMIT) {
    const chunk = excluded.slice(i, i + DYNAMODB_IN_OPERAND_LIMIT);
    parts.push(`NOT (${b.name('agencyId')} IN (${chunk.map((a) => b.value(a)).join(', ')}))`);
  }
  return parts.length > 0 ? parts.join(' AND ') : undefined;
}

/**
 * Status and owner of a stored item. Unmanaged items (seed, legacy imports) carry no `status` and
 * are `ACTIVE`; a malformed status throws instead of being guessed.
 */
export function visibilityOf(item: Record<string, unknown>): ListingVisibility {
  const status =
    item['status'] === undefined ? 'ACTIVE' : ListingStatusSchema.parse(item['status']);
  const agencyId = item['agencyId'];
  return typeof agencyId === 'string' ? { status, agencyId } : { status };
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
  private readonly locationCache: TtlCache<'all', LocationEntry[]>;

  constructor({
    client,
    tableName,
    deadlineMs = DYNAMODB_REQUEST_DEADLINE_MS,
    deadlineSignal = (ms) => AbortSignal.timeout(ms),
    clock = systemClock,
    locationsCacheTtlMs = DYNAMODB_LOCATIONS_CACHE_TTL_MS,
  }: DynamoDbSearchProviderOptions) {
    this.client = client;
    this.tableName = tableName;
    this.deadlineMs = deadlineMs;
    this.deadlineSignal = deadlineSignal;
    this.locationCache = new TtlCache(clock, locationsCacheTtlMs, 1);
  }

  async search(q: ResolvedQuery): Promise<SearchResult> {
    // An empty IN/OR set matches nothing (as in `matchesQuery`) and is no valid expression.
    if (q.listingTypes?.length === 0 || q.tourHosts?.length === 0) return { items: [] };
    const pageSize = effectivePageSize(q.pageSize);
    const input = buildSearchQueryInput(q, this.tableName);

    const matches = await this.withDeadline(async (abortSignal) => {
      const found: StoredListing[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        abortSignal.throwIfAborted();
        const page = await this.client.send(
          new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey }),
          { abortSignal },
        );
        found.push(
          ...(page.Items ?? []).map((item) => ({
            listing: fromListingItem(item),
            visibility: visibilityOf(item),
          })),
        );
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey !== undefined && found.length <= pageSize);
      return found;
    });

    const owners = new Map(matches.map((m) => [m.listing.id, m.visibility.agencyId]));
    const listings = matches.map(({ listing }) => listing);
    if (listings.length <= pageSize) {
      return withOwners({ items: listings }, (id) => owners.get(id));
    }
    const items = listings.slice(0, pageSize);
    return withOwners({ items, next: { lastId: (items[pageSize - 1] as Listing).id } }, (id) =>
      owners.get(id),
    );
  }

  async getById(id: string): Promise<StoredListing | null> {
    const result = await this.withDeadline((abortSignal) =>
      this.client.send(new GetCommand({ TableName: this.tableName, Key: { id } }), {
        abortSignal,
      }),
    );
    if (result.Item === undefined) return null;
    return { listing: fromListingItem(result.Item), visibility: visibilityOf(result.Item) };
  }

  /**
   * Reads country, city and owner of every `ACTIVE` listing (projection query on `byId`, all
   * pages) and caches the rows per Lambda instance for {@link DYNAMODB_LOCATIONS_CACHE_TTL_MS};
   * suspended agencies are applied per call. Linear read cost per cache miss (docs/known-issues.md).
   */
  async locations(q: LocationQuery): Promise<LocationsDocument> {
    const rows = await this.locationCache.get('all', () => this.readLocationEntries());
    return aggregateLocations(rows, q);
  }

  private readLocationEntries(): Promise<LocationEntry[]> {
    return this.withDeadline(async (abortSignal) => {
      const input = buildLocationsQueryInput(this.tableName);
      const rows: LocationEntry[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        abortSignal.throwIfAborted();
        const page = await this.client.send(
          new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey }),
          { abortSignal },
        );
        for (const item of page.Items ?? []) {
          const entry = locationEntryOf(item);
          if (entry !== undefined) rows.push(entry);
        }
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey !== undefined);
      return rows;
    });
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
