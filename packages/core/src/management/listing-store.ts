import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Listing } from '@open-estate/shared';
import {
  fromManagedListingItem,
  type ListingManagement,
  type ManagedListingItem,
} from '../search/listings-table';
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

/** Fake with transaction semantics via `InMemoryTransactor`. */
export class InMemoryManagedListingStore implements ManagedListingStore<InMemoryOp> {
  private readonly items = new Map<string, ManagedListingItem>();

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

export class DynamoDbManagedListingStore implements ManagedListingStore<DynamoDbOp> {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor({ client, tableName }: DynamoDbManagedListingStoreOptions) {
    this.client = client;
    this.tableName = tableName;
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
