import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { isDeepStrictEqual } from 'node:util';
import {
  flagCodes,
  ListingFlagsSchema,
  type FlagCode,
  type Listing,
  type ListingFlag,
  type ListingStatus,
  type OfferType,
  type Origin,
} from '@open-estate/shared';
import {
  fromManagedListingItem,
  LISTING_FLAG_CODES_ATTRIBUTE,
  toManagedListingItem,
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
import {
  scanCursor,
  scanInMemory,
  scanParameters,
  type ScanPage,
  type ScanRequest,
} from '../duplicates/scan-segment';
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
   * null requires a new listing, otherwise the stored `version` must equal it (Req 4.8). With
   * `expectedFlags` the stored Markierungen must also still equal them: they change without a
   * version (Verwerfung, Duplikat_Abgleich), and a write based on older ones would undo that
   * change and miscount `listing.flags.*` (duplicate-detection Req 8.2, 14.5).
   */
  putOp(
    item: ManagedListingItem,
    expectedVersion: number | null,
    expectedFlags?: readonly ListingFlag[],
  ): Op;
  /**
   * Sets only `lastImportedAt`/`lastRunId` (label `listing.touch`) if the stored `version` still
   * equals `expectedVersion`: an import run that delivers the listing unchanged (Req 4.16, 7.3).
   */
  touchProvenanceOp(id: string, expectedVersion: number, provenance: ProvenanceTouch): Op;
  /**
   * Replaces the Markierungen (label `listing.flags`) if the stored `version` still equals
   * `expectedVersion` and the stored Markierungen still equal `expectedFlags`. Creates no version:
   * flags are Verwaltungsdaten (duplicate-detection Req 7.3); used by the Verwerfung and the
   * Duplikat_Abgleich (Req 8.2, 10.3, 10.5).
   */
  setFlagsOp(
    id: string,
    expectedVersion: number,
    flags: readonly ListingFlag[],
    expectedFlags: readonly ListingFlag[],
  ): Op;
  /**
   * Condition (label `listing.check`) that the listing exists with `expectedVersion`, or exists at
   * all without it; writes nothing. Lets the Duplikat_Abgleich write index entries and Treffer
   * only for listings that are still there and unchanged (Req 10.5, 12.3).
   */
  checkOp(id: string, expectedVersion?: number): Op;
}

/** Stored Markierungen equal `expected` (both as stored: an empty list is no attribute). */
function sameStoredFlags(
  stored: readonly ListingFlag[] | undefined,
  expected: readonly ListingFlag[],
): boolean {
  return isDeepStrictEqual(
    ListingFlagsSchema.parse(stored ?? []),
    ListingFlagsSchema.parse([...expected]),
  );
}

/**
 * Condition on the stored Markierungen for DynamoDB: no attribute for none, else equality of the
 * whole list (`=` compares lists and maps element-wise).
 */
function flagsCondition(expected: readonly ListingFlag[]): {
  expression: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
} {
  return expected.length === 0
    ? { expression: 'attribute_not_exists(#flags)', names: { '#flags': 'flags' }, values: {} }
    : {
        expression: '#flags = :expectedFlags',
        names: { '#flags': 'flags' },
        values: { ':expectedFlags': ListingFlagsSchema.parse([...expected]) },
      };
}

/**
 * Reads of the Duplikat_Abgleich over the whole `Listings` table (duplicate-detection Req 10.4,
 * 12.4). Items that are no managed listing are returned as `invalid` with their id, so one bad
 * item cannot stop a run.
 */
export interface ListingSweepSource {
  /** One page of a parallel scan (eventually consistent). */
  scan(request: ScanRequest): Promise<ScanPage<ManagedListing | { invalid: string }>>;
  /** Strongly consistent reads of several listings; unknown or invalid ids are absent. */
  getMany(ids: readonly string[]): Promise<Map<string, ManagedListing>>;
  /** Ids among `ids` that have an item, strongly consistent (only the key is read). */
  existing(ids: readonly string[]): Promise<Set<string>>;
}

/** Stored item → managed listing, or `invalid` with its id. */
function sweepItem(item: object): ManagedListing | { invalid: string } {
  try {
    return fromManagedListingItem(item);
  } catch {
    return { invalid: String((item as { id?: unknown }).id ?? '') };
  }
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
  /** The listing carries a Markierung with this code (duplicate-detection Req 7.5). */
  flag?: FlagCode;
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
  const { agencyId, status, origin, offerType, listingType, customId, titleQuery, flag } = filter;
  if (agencyId !== undefined && management.agencyId !== agencyId) return false;
  if (flag !== undefined && !(management.flags ?? []).some((f) => f.code === flag)) return false;
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
  implements ManagedListingStore<InMemoryOp>, ManagedListingQueryStore, ListingSweepSource
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

  putOp(
    item: ManagedListingItem,
    expectedVersion: number | null,
    expectedFlags?: readonly ListingFlag[],
  ): InMemoryOp {
    const stored = structuredClone(item);
    return {
      label: 'listing.put',
      target: `Listings#${item.id}`,
      check: () => {
        const current = this.items.get(item.id);
        if (expectedVersion === null) return current === undefined;
        return (
          current?.version === expectedVersion &&
          (expectedFlags === undefined || sameStoredFlags(current.flags, expectedFlags))
        );
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

  setFlagsOp(
    id: string,
    expectedVersion: number,
    flags: readonly ListingFlag[],
    expectedFlags: readonly ListingFlag[],
  ): InMemoryOp {
    const stored = structuredClone([...flags]);
    return {
      label: 'listing.flags',
      target: `Listings#${id}`,
      check: () => {
        const current = this.items.get(id);
        return (
          current?.version === expectedVersion && sameStoredFlags(current.flags, expectedFlags)
        );
      },
      apply: () => {
        const current = this.items.get(id);
        if (current === undefined) return;
        const { listing, management } = fromManagedListingItem(current);
        this.items.set(id, toManagedListingItem(listing, { ...management, flags: stored }));
      },
    };
  }

  checkOp(id: string, expectedVersion?: number): InMemoryOp {
    return {
      label: 'listing.check',
      target: `Listings#${id}`,
      check: () => {
        const current = this.items.get(id);
        return (
          current !== undefined &&
          (expectedVersion === undefined || current.version === expectedVersion)
        );
      },
      apply: () => {},
    };
  }

  async scan(request: ScanRequest): Promise<ScanPage<ManagedListing | { invalid: string }>> {
    const page = scanInMemory([...this.items.values()], (item) => item.id, request);
    return {
      items: page.items.map((item) => sweepItem(structuredClone(item))),
      ...(page.cursor !== undefined && { cursor: page.cursor }),
    };
  }

  async getMany(ids: readonly string[]): Promise<Map<string, ManagedListing>> {
    const found = new Map<string, ManagedListing>();
    for (const id of new Set(ids)) {
      const item = this.items.get(id);
      if (item === undefined) continue;
      const managed = sweepItem(structuredClone(item));
      if (!('invalid' in managed)) found.set(id, managed);
    }
    return found;
  }

  async existing(ids: readonly string[]): Promise<Set<string>> {
    return new Set(ids.filter((id) => this.items.has(id)));
  }

  /** Stores an item as is, bypassing the writer (tests: listings written outside it). */
  putRaw(item: ManagedListingItem): void {
    this.items.set(item.id, structuredClone(item));
  }

  /** All stored items (for assertions in tests). */
  all(): ManagedListingItem[] {
    return [...this.items.values()].map((item) => structuredClone(item));
  }

  /**
   * Removes the listing outside a transaction (in-process deletion of local runs); `false` if no
   * listing has this id.
   */
  remove(id: string): boolean {
    return this.items.delete(id);
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
  // Markierungscode: the derived code list of the item contains it (duplicate-detection Req 7.5).
  if (filter.flag !== undefined) {
    names['#f_flagCodes'] = LISTING_FLAG_CODES_ATTRIBUTE;
    values[':f_flag'] = filter.flag;
    terms.push('contains(#f_flagCodes, :f_flag)');
  }
  return { expression: terms.join(' AND '), names, values };
}

/** BatchGetItem reads at most 100 keys per request. */
const BATCH_GET_LIMIT = 100;
const MAX_BATCH_GET_RETRIES = 5;

export class DynamoDbManagedListingStore
  implements ManagedListingStore<DynamoDbOp>, ManagedListingQueryStore, ListingSweepSource
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

  putOp(
    item: ManagedListingItem,
    expectedVersion: number | null,
    expectedFlags?: readonly ListingFlag[],
  ): DynamoDbOp {
    const flags = expectedFlags === undefined ? undefined : flagsCondition(expectedFlags);
    const values = { ':expectedVersion': expectedVersion, ...flags?.values };
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
                ConditionExpression:
                  flags === undefined
                    ? '#version = :expectedVersion'
                    : `#version = :expectedVersion AND ${flags.expression}`,
                ExpressionAttributeNames: { '#version': 'version', ...flags?.names },
                ExpressionAttributeValues: values,
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

  setFlagsOp(
    id: string,
    expectedVersion: number,
    flags: readonly ListingFlag[],
    expectedFlags: readonly ListingFlag[],
  ): DynamoDbOp {
    const guard = flagsCondition(expectedFlags);
    const names = {
      '#flags': 'flags',
      '#flagCodes': LISTING_FLAG_CODES_ATTRIBUTE,
      '#version': 'version',
    };
    const values = { ':expectedVersion': expectedVersion, ...guard.values };
    // Like `toManagedListingItem`: no flags = no attributes at all.
    const update =
      flags.length === 0
        ? { UpdateExpression: 'REMOVE #flags, #flagCodes', ExpressionAttributeValues: values }
        : {
            UpdateExpression: 'SET #flags = :flags, #flagCodes = :flagCodes',
            ExpressionAttributeValues: {
              ...values,
              ':flags': ListingFlagsSchema.parse(flags),
              ':flagCodes': flagCodes(flags),
            },
          };
    return {
      label: 'listing.flags',
      item: {
        Update: {
          TableName: this.tableName,
          Key: { id },
          ConditionExpression: `#version = :expectedVersion AND ${guard.expression}`,
          ExpressionAttributeNames: names,
          ...update,
        },
      },
    };
  }

  async scan(request: ScanRequest): Promise<ScanPage<ManagedListing | { invalid: string }>> {
    const out = await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
        ConsistentRead: true,
        ...scanParameters(request),
      }),
    );
    return { items: (out.Items ?? []).map(sweepItem), ...scanCursor(out.LastEvaluatedKey) };
  }

  async getMany(ids: readonly string[]): Promise<Map<string, ManagedListing>> {
    const found = new Map<string, ManagedListing>();
    for (const item of await this.batchGet(ids, false)) {
      const managed = sweepItem(item);
      if (!('invalid' in managed)) found.set(managed.listing.id, managed);
    }
    return found;
  }

  async existing(ids: readonly string[]): Promise<Set<string>> {
    return new Set((await this.batchGet(ids, true)).map((item) => String(item['id'])));
  }

  /** Strongly consistent BatchGet of all `ids`, with retries of unprocessed keys. */
  private async batchGet(
    ids: readonly string[],
    keysOnly: boolean,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    const unique = [...new Set(ids)];
    for (let start = 0; start < unique.length; start += BATCH_GET_LIMIT) {
      let keys: Record<string, unknown>[] = unique
        .slice(start, start + BATCH_GET_LIMIT)
        .map((id) => ({ id }));
      for (let attempt = 0; keys.length > 0; attempt += 1) {
        if (attempt > MAX_BATCH_GET_RETRIES) throw new Error('Listings: unprocessed keys remain');
        const out = await this.client.send(
          new BatchGetCommand({
            RequestItems: {
              [this.tableName]: {
                Keys: keys,
                ConsistentRead: true,
                ...(keysOnly && {
                  ProjectionExpression: '#id',
                  ExpressionAttributeNames: { '#id': 'id' },
                }),
              },
            },
          }),
        );
        items.push(...(out.Responses?.[this.tableName] ?? []));
        keys = (out.UnprocessedKeys?.[this.tableName]?.Keys ?? []) as Record<string, unknown>[];
      }
    }
    return items;
  }

  checkOp(id: string, expectedVersion?: number): DynamoDbOp {
    return {
      label: 'listing.check',
      item: {
        ConditionCheck: {
          TableName: this.tableName,
          Key: { id },
          ...(expectedVersion === undefined
            ? {
                ConditionExpression: 'attribute_exists(#id)',
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
}
