import {
  GetCommand,
  QueryCommand,
  ScanCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { Listing, ListingStatus, OfferType, Origin } from '@open-estate/shared';
import {
  fromManagedListingItem,
  type ListingManagement,
  type ManagedListingItem,
} from '../search/listings-table';
import {
  decodeKeyCursor,
  encodeKeyCursor,
  InvalidCursorError,
  type KeyPage,
  type KeyPageRequest,
} from './key-page';
import type { DynamoDbOp, InMemoryOp } from './transaction';

// Read side and transaction operation of the `Listings` table for the versioned write path
// (design: "ListingCommandService und VersionedListingWriter").

/** A stored listing split into public listing and management attributes. */
export interface ManagedListing {
  listing: Listing;
  management: ListingManagement;
}

export interface ManagedListingStore<Op> {
  /** Strongly consistent read; `null` if no listing has this id. */
  get(id: string): Promise<ManagedListing | null>;
  /**
   * Writes the full item (label `listing.put`) with optimistic concurrency: `expectedVersion`
   * null requires a new listing, otherwise the stored `version` must equal it (Req 4.8).
   */
  putOp(item: ManagedListingItem, expectedVersion: number | null): Op;
  /**
   * Sets only `lastImportedAt`/`lastRunId` (label `listing.touch`) if the stored `version` still
   * equals `expectedVersion`: an import run that delivers the listing unchanged (Req 4.16, 7.3).
   */
  touchProvenanceOp(id: string, expectedVersion: number, provenance: ProvenanceTouch): Op;
}

/** Provenance fields refreshed by an unchanged import (no new version). */
export type ProvenanceTouch = Pick<Listing, 'lastImportedAt' | 'lastRunId'>;

// Listing overview of the Management_API (design: "DynamoDB-Tabellen", Req 2.7, 4.14, 10.4).

/**
 * GSI over the listings of one agency, newest change first (infra task 12.3): partition key
 * `agencyId`, sort key `updatedAt`, projection ALL. Sparse: listings without agency are not in it.
 *
 * Sort key deviates from the design's `updatedAt#id`: both attributes already exist on every item,
 * and a GSI sort key need not be unique — DynamoDB pages ties correctly because `LastEvaluatedKey`
 * also carries the table key `id`. A composite attribute would only duplicate data that every
 * writer must keep in sync. `updatedAt` is written in UTC (`toISOString`), so string order is
 * time order.
 */
export const LISTINGS_BY_AGENCY_INDEX = 'byAgency';
export const LISTINGS_BY_AGENCY_PK_ATTRIBUTE = 'agencyId';
export const LISTINGS_BY_AGENCY_SK_ATTRIBUTE = 'updatedAt';

/** Filters of the listing overview (Req 4.14, 10.4); all given filters must match. */
export interface ManagedListingFilter {
  /** Owning agency, enforced in the key condition (Req 2.7); absent = all listings (admin only). */
  agencyId?: string;
  status?: ListingStatus;
  origin?: Origin;
  /** The listing has an offer of this type. */
  offerType?: OfferType;
  listingType?: string;
  customId?: string;
  /** Case-insensitive substring of the title of any language version. */
  titleQuery?: string;
}

export interface ManagedListingQueryStore {
  /**
   * Matching listings. With `agencyId`: `Query` on {@link LISTINGS_BY_AGENCY_INDEX}, newest change
   * first. Without: all listings, including those without agency, in unspecified order. Each
   * listing appears at most once across pages unless it changes meanwhile. A page may hold fewer
   * than `limit` items although `nextCursor` is set. Throws `InvalidCursorError`.
   */
  query(filter: ManagedListingFilter, page: KeyPageRequest): Promise<KeyPage<ManagedListing>>;
}

/** NFC, locale-independent lowercase: the normalization of the title filter. */
const normalizeTitle = (value: string) => value.normalize('NFC').toLocaleLowerCase('und');

/** Single predicate of both implementations, so fake and DynamoDB filter identically. */
export function matchesListingFilter(
  { listing, management }: ManagedListing,
  filter: ManagedListingFilter,
): boolean {
  const { agencyId, status, origin, offerType, listingType, customId, titleQuery } = filter;
  if (agencyId !== undefined && management.agencyId !== agencyId) return false;
  if (status !== undefined && management.status !== status) return false;
  if (origin !== undefined && management.origin !== origin) return false;
  if (customId !== undefined && management.customId !== customId) return false;
  if (listingType !== undefined && listing.listingType !== listingType) return false;
  if (offerType !== undefined && !listing.offers.some((o) => o.offerType === offerType)) {
    return false;
  }
  if (titleQuery !== undefined) {
    const needle = normalizeTitle(titleQuery);
    const titles = [listing.title, ...listing.translations.map((t) => t.title)];
    if (!titles.some((title) => normalizeTitle(title).includes(needle))) return false;
  }
  return true;
}

/** Cursor key of an item: the table key, plus the index key when paging the agency index. */
function listingCursorKey(
  item: { id: string; agencyId?: string; updatedAt: string },
  byAgency: boolean,
): Record<string, string> {
  return byAgency
    ? {
        id: item.id,
        [LISTINGS_BY_AGENCY_PK_ATTRIBUTE]: item.agencyId ?? '',
        [LISTINGS_BY_AGENCY_SK_ATTRIBUTE]: item.updatedAt,
      }
    : { id: item.id };
}

/** Decodes and checks a cursor of {@link listingCursorKey} for this filter. */
function decodeListingCursor(cursor: string, agencyId: string | undefined): Record<string, string> {
  const key = decodeKeyCursor(cursor);
  const expected = Object.keys(
    listingCursorKey({ id: '', updatedAt: '' }, agencyId !== undefined),
  ).sort();
  const valid =
    Object.keys(key).sort().join() === expected.join() &&
    Object.values(key).every((value) => typeof value === 'string') &&
    (agencyId === undefined || key[LISTINGS_BY_AGENCY_PK_ATTRIBUTE] === agencyId);
  if (!valid) throw new InvalidCursorError();
  return key as Record<string, string>;
}

const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Fake with transaction semantics via `InMemoryTransactor`. */
export class InMemoryManagedListingStore
  implements ManagedListingStore<InMemoryOp>, ManagedListingQueryStore
{
  private readonly items = new Map<string, ManagedListingItem>();

  async query(
    filter: ManagedListingFilter,
    { limit, cursor }: KeyPageRequest,
  ): Promise<KeyPage<ManagedListing>> {
    const byAgency = filter.agencyId !== undefined;
    const after = cursor === undefined ? undefined : decodeListingCursor(cursor, filter.agencyId);
    // Agency index: `updatedAt` descending (ties by id); without agency: table order by id.
    const order = (a: { id: string; updatedAt: string }, b: { id: string; updatedAt: string }) =>
      byAgency
        ? compareStrings(b.updatedAt, a.updatedAt) || compareStrings(b.id, a.id)
        : compareStrings(a.id, b.id);
    const position = after && { id: after['id'] ?? '', updatedAt: after['updatedAt'] ?? '' };
    const matching = [...this.items.values()]
      .filter((item) => !byAgency || item.agencyId === filter.agencyId)
      .filter((item) => position === undefined || order(item, position) > 0)
      .sort(order)
      .map((item) => fromManagedListingItem(structuredClone(item)))
      .filter((managed) => matchesListingFilter(managed, filter));
    const items = matching.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      ...(last !== undefined &&
        matching.length > limit && {
          nextCursor: encodeKeyCursor(
            listingCursorKey({ ...last.management, id: last.listing.id }, byAgency),
          ),
        }),
    };
  }

  async get(id: string): Promise<ManagedListing | null> {
    const item = this.items.get(id);
    return item === undefined ? null : fromManagedListingItem(structuredClone(item));
  }

  putOp(item: ManagedListingItem, expectedVersion: number | null): InMemoryOp {
    const stored = structuredClone(item);
    return {
      label: 'listing.put',
      target: `Listings#${item.id}`,
      check: () => {
        const current = this.items.get(item.id);
        return expectedVersion === null
          ? current === undefined
          : current?.version === expectedVersion;
      },
      apply: () => {
        this.items.set(item.id, stored);
      },
    };
  }

  touchProvenanceOp(id: string, expectedVersion: number, provenance: ProvenanceTouch): InMemoryOp {
    const { lastImportedAt, lastRunId } = provenance;
    return {
      label: 'listing.touch',
      target: `Listings#${id}`,
      check: () => this.items.get(id)?.version === expectedVersion,
      apply: () => {
        const current = this.items.get(id);
        if (current !== undefined) this.items.set(id, { ...current, lastImportedAt, lastRunId });
      },
    };
  }

  /** All stored items (for assertions in tests). */
  all(): ManagedListingItem[] {
    return [...this.items.values()].map((item) => structuredClone(item));
  }
}

export interface DynamoDbManagedListingStoreOptions {
  client: DynamoDBDocumentClient;
  /** `Listings` table; partition key `id`. */
  tableName: string;
}

/** Items read per request of the listing overview, and requests per returned page. */
export const LISTING_QUERY_BATCH = 100;
export const LISTING_QUERY_MAX_REQUESTS = 5;

/** Top-level equality filters evaluated by DynamoDB; the rest is matched after parsing. */
const EQUALITY_FILTERS = ['status', 'origin', 'customId', 'listingType'] as const;

function equalityFilterExpression(filter: ManagedListingFilter) {
  const names: Record<string, string> = {};
  const values: Record<string, string> = {};
  const terms = EQUALITY_FILTERS.flatMap((attribute) => {
    const value = filter[attribute];
    if (value === undefined) return [];
    names[`#f_${attribute}`] = attribute;
    values[`:f_${attribute}`] = value;
    return [`#f_${attribute} = :f_${attribute}`];
  });
  return { expression: terms.join(' AND '), names, values };
}

export class DynamoDbManagedListingStore
  implements ManagedListingStore<DynamoDbOp>, ManagedListingQueryStore
{
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor({ client, tableName }: DynamoDbManagedListingStoreOptions) {
    this.client = client;
    this.tableName = tableName;
  }

  /**
   * `Query` on the agency index (agency in the key condition, Req 2.7) or `Scan` without agency.
   * Up to {@link LISTING_QUERY_MAX_REQUESTS} reads fill one page; when a page is full mid-batch,
   * the cursor is the key of its last item, so no matching item is skipped.
   */
  async query(
    filter: ManagedListingFilter,
    { limit, cursor }: KeyPageRequest,
  ): Promise<KeyPage<ManagedListing>> {
    const { agencyId } = filter;
    const byAgency = agencyId !== undefined;
    let startKey: Record<string, unknown> | undefined =
      cursor === undefined ? undefined : decodeListingCursor(cursor, agencyId);
    const equality = equalityFilterExpression(filter);
    const items: ManagedListing[] = [];

    for (let request = 0; request < LISTING_QUERY_MAX_REQUESTS; request++) {
      const names = {
        ...equality.names,
        ...(byAgency && { '#pk': LISTINGS_BY_AGENCY_PK_ATTRIBUTE }),
      };
      const values = { ...equality.values, ...(byAgency && { ':pk': agencyId }) };
      const common = {
        TableName: this.tableName,
        Limit: LISTING_QUERY_BATCH,
        ...(equality.expression !== '' && { FilterExpression: equality.expression }),
        ...(Object.keys(names).length > 0 && { ExpressionAttributeNames: names }),
        ...(Object.keys(values).length > 0 && { ExpressionAttributeValues: values }),
        ...(startKey !== undefined && { ExclusiveStartKey: startKey }),
      };
      const out = await this.client.send(
        byAgency
          ? new QueryCommand({
              ...common,
              IndexName: LISTINGS_BY_AGENCY_INDEX,
              KeyConditionExpression: '#pk = :pk',
              ScanIndexForward: false,
            })
          : new ScanCommand(common),
      );
      const batch = out.Items ?? [];
      for (const [index, item] of batch.entries()) {
        const managed = fromManagedListingItem(item);
        if (!matchesListingFilter(managed, filter)) continue;
        items.push(managed);
        if (items.length === limit) {
          const more = index < batch.length - 1 || out.LastEvaluatedKey !== undefined;
          return {
            items,
            ...(more && {
              nextCursor: encodeKeyCursor(
                listingCursorKey({ ...managed.management, id: managed.listing.id }, byAgency),
              ),
            }),
          };
        }
      }
      startKey = out.LastEvaluatedKey;
      if (startKey === undefined) return { items };
    }
    return { items, ...(startKey !== undefined && { nextCursor: encodeKeyCursor(startKey) }) };
  }

  async get(id: string): Promise<ManagedListing | null> {
    const out = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { id }, ConsistentRead: true }),
    );
    return out.Item === undefined ? null : fromManagedListingItem(out.Item);
  }

  putOp(item: ManagedListingItem, expectedVersion: number | null): DynamoDbOp {
    return {
      label: 'listing.put',
      item: {
        Put: {
          TableName: this.tableName,
          Item: item,
          ...(expectedVersion === null
            ? {
                ConditionExpression: 'attribute_not_exists(#id)',
                ExpressionAttributeNames: { '#id': 'id' },
              }
            : {
                ConditionExpression: '#version = :expectedVersion',
                ExpressionAttributeNames: { '#version': 'version' },
                ExpressionAttributeValues: { ':expectedVersion': expectedVersion },
              }),
        },
      },
    };
  }

  touchProvenanceOp(id: string, expectedVersion: number, provenance: ProvenanceTouch): DynamoDbOp {
    return {
      label: 'listing.touch',
      item: {
        Update: {
          TableName: this.tableName,
          Key: { id },
          UpdateExpression: 'SET #lastImportedAt = :lastImportedAt, #lastRunId = :lastRunId',
          ConditionExpression: '#version = :expectedVersion',
          ExpressionAttributeNames: {
            '#lastImportedAt': 'lastImportedAt',
            '#lastRunId': 'lastRunId',
            '#version': 'version',
          },
          ExpressionAttributeValues: {
            ':lastImportedAt': provenance.lastImportedAt,
            ':lastRunId': provenance.lastRunId,
            ':expectedVersion': expectedVersion,
          },
        },
      },
    };
  }
}
