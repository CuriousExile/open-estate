import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  ActorRefSchema,
  ChangedPath,
  ChangeTypeSchema,
  ChannelSchema,
  CustomId,
  EntityId,
  IsoDateTime,
  ListingStatusSchema,
  StatusReasonSchema,
  VersionNumber,
  type ActorRef,
  type ChangeType,
  type Channel,
  type ContentPath,
  type FieldSource,
  type ListingStatus,
  type StatusReason,
} from '@open-estate/shared';
import { z } from 'zod';
import {
  decodeKeyCursor,
  encodeKeyCursor,
  InvalidCursorError,
  toKeyPage,
  type KeyPage,
  type KeyPageRequest,
} from './key-page';
import type { DynamoDbOp, InMemoryOp } from './transaction';

// `ListingVersions` table (design: "DynamoDB-Tabellen"): PK `listingId`, SK `version` (Number).
// Versions are written once inside the listing's transaction and never changed (Req 7.4); there
// is no TTL, they are kept until the listing is deleted (Req 9.1).

export const LISTING_VERSIONS_PK_ATTRIBUTE = 'listingId';
export const LISTING_VERSIONS_SK_ATTRIBUTE = 'version';

/** Changed Inhaltsfeld with its Feldherkunft before the change (Req 7.2, 12.11). */
export interface VersionChangedPath {
  path: ContentPath;
  /** Absent if the field did not exist before. */
  previous?: FieldSource;
  /** The change was made by a list import over the value (design: "durch Listenimport überschrieben"). */
  overwrittenByImport: boolean;
}

/** Version metadata; the Listing_Inhalt itself is the snapshot `listings/{id}/{contentHash}.json`. */
export interface ListingVersionRecord {
  listingId: string;
  version: number;
  changeType: ChangeType;
  channel: Channel;
  actor: ActorRef;
  /** ISO-8601 with offset (Req 7.1). */
  createdAt: string;
  status: ListingStatus;
  customId?: string;
  agencyId?: string;
  contentHash: string;
  /** Size of the snapshot in bytes (counted in `history.storage_bytes` only if `newSnapshot`). */
  snapshotBytes: number;
  /** This version stored a new snapshot object (`false` = deduplicated). */
  newSnapshot: boolean;
  changedPaths: VersionChangedPath[];
  restoredFrom?: number;
  /**
   * Why the platform stored another status than requested (duplicate-detection Req 5.4): only on
   * version 1 of a listing created as a duplicate.
   */
  statusReason?: StatusReason;
}

export const listingVersionRecordSchema = z.object({
  listingId: z.string().min(1),
  version: VersionNumber,
  changeType: ChangeTypeSchema,
  channel: ChannelSchema,
  actor: ActorRefSchema,
  createdAt: IsoDateTime,
  status: ListingStatusSchema,
  customId: CustomId.optional(),
  agencyId: EntityId.optional(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  snapshotBytes: z.int().min(0),
  newSnapshot: z.boolean(),
  changedPaths: z.array(ChangedPath),
  restoredFrom: VersionNumber.optional(),
  statusReason: StatusReasonSchema.optional(),
});

/** Validates a record; also drops `undefined` optionals so they are not stored as attributes. */
const parseRecord = (item: unknown): ListingVersionRecord =>
  listingVersionRecordSchema.parse(item) as ListingVersionRecord;

/** Cursor = key of the last returned version (same format as DynamoDB's `LastEvaluatedKey`). */
function decodeVersionCursor(listingId: string, cursor: string): number {
  const key = decodeKeyCursor(cursor);
  const version = key[LISTING_VERSIONS_SK_ATTRIBUTE];
  if (key[LISTING_VERSIONS_PK_ATTRIBUTE] !== listingId || typeof version !== 'number') {
    throw new InvalidCursorError();
  }
  return version;
}

const versionKey = (listingId: string, version: number) => ({
  [LISTING_VERSIONS_PK_ATTRIBUTE]: listingId,
  [LISTING_VERSIONS_SK_ATTRIBUTE]: version,
});

export interface ListingVersionStore<Op> {
  get(listingId: string, version: number): Promise<ListingVersionRecord | null>;
  /** Versions of one listing, newest first (Req 7.5); throws `InvalidCursorError`. */
  list(listingId: string, page: KeyPageRequest): Promise<KeyPage<ListingVersionRecord>>;
  /** Inserts a new version (label `listingVersion.put`); fails if the version exists. */
  putOp(record: ListingVersionRecord): Op;
}

/** Fake with transaction semantics via `InMemoryTransactor`; there is no update operation. */
export class InMemoryListingVersionStore implements ListingVersionStore<InMemoryOp> {
  private readonly byListing = new Map<string, Map<number, ListingVersionRecord>>();

  async get(listingId: string, version: number): Promise<ListingVersionRecord | null> {
    const record = this.byListing.get(listingId)?.get(version);
    return record === undefined ? null : structuredClone(record);
  }

  async list(
    listingId: string,
    { limit, cursor }: KeyPageRequest,
  ): Promise<KeyPage<ListingVersionRecord>> {
    const before = cursor === undefined ? undefined : decodeVersionCursor(listingId, cursor);
    const remaining = [...(this.byListing.get(listingId)?.values() ?? [])]
      .filter((record) => before === undefined || record.version < before)
      .sort((a, b) => b.version - a.version);
    const items = remaining.slice(0, limit).map((record) => structuredClone(record));
    const last = items.at(-1);
    return {
      items,
      ...(last !== undefined &&
        remaining.length > limit && {
          nextCursor: encodeKeyCursor(versionKey(listingId, last.version)),
        }),
    };
  }

  putOp(record: ListingVersionRecord): InMemoryOp {
    const stored = structuredClone(parseRecord(record));
    return {
      label: 'listingVersion.put',
      target: `ListingVersions#${record.listingId}#${record.version}`,
      check: () => this.byListing.get(record.listingId)?.has(record.version) !== true,
      apply: () => {
        const versions = this.byListing.get(record.listingId) ?? new Map();
        versions.set(record.version, stored);
        this.byListing.set(record.listingId, versions);
      },
    };
  }

  /** Removes every version of a listing — only a deletion request may do this (Req 7.4, 9.2). */
  removeListing(listingId: string): void {
    this.byListing.delete(listingId);
  }

  /** All versions of all listings (for assertions in tests). */
  all(): ListingVersionRecord[] {
    return [...this.byListing.values()].flatMap((versions) =>
      [...versions.values()].map((record) => structuredClone(record)),
    );
  }
}

export interface DynamoDbListingVersionStoreOptions {
  client: DynamoDBDocumentClient;
  /** `ListingVersions` table; PK `listingId`, SK `version` (Number). */
  tableName: string;
}

export class DynamoDbListingVersionStore implements ListingVersionStore<DynamoDbOp> {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor({ client, tableName }: DynamoDbListingVersionStoreOptions) {
    this.client = client;
    this.tableName = tableName;
  }

  async get(listingId: string, version: number): Promise<ListingVersionRecord | null> {
    const out = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: versionKey(listingId, version),
        ConsistentRead: true,
      }),
    );
    return out.Item === undefined ? null : parseRecord(out.Item);
  }

  async list(
    listingId: string,
    { limit, cursor }: KeyPageRequest,
  ): Promise<KeyPage<ListingVersionRecord>> {
    const before = cursor === undefined ? undefined : decodeVersionCursor(listingId, cursor);
    const out = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': LISTING_VERSIONS_PK_ATTRIBUTE },
        ExpressionAttributeValues: { ':pk': listingId },
        ScanIndexForward: false,
        Limit: limit,
        ConsistentRead: true,
        ...(before !== undefined && { ExclusiveStartKey: versionKey(listingId, before) }),
      }),
    );
    return toKeyPage(out.Items, out.LastEvaluatedKey, parseRecord);
  }

  putOp(record: ListingVersionRecord): DynamoDbOp {
    return {
      label: 'listingVersion.put',
      item: {
        Put: {
          TableName: this.tableName,
          Item: parseRecord(record),
          ConditionExpression: 'attribute_not_exists(#sk)',
          ExpressionAttributeNames: { '#sk': LISTING_VERSIONS_SK_ATTRIBUTE },
        },
      },
    };
  }
}
