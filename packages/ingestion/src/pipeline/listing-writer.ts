import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toListingItem } from '@open-estate/core';
import type { Listing } from '@open-estate/shared';
import {
  DELETION_BLOCKLIST_KEY_ATTRIBUTE,
  DeletionBlockedError,
  InMemoryDeletionBlocklist,
} from './deletion-blocklist';

/** `imported` = id was new, `updated` = an existing listing was replaced (Req 5.8). */
export type WriteOutcome = 'imported' | 'updated';

/**
 * Pipeline step 7: stores a validated listing, replacing an existing one completely, media and
 * tours included (Req 4.11, 16.3). Throws {@link DeletionBlockedError} if the id is on the
 * deletion blocklist at write time (Req 18.7).
 */
export interface ListingWriter {
  write(listing: Listing): Promise<WriteOutcome>;
}

/**
 * In-memory writer for tests and local runs; stores copies, so callers cannot alter stored data.
 * Pass the blocklist shared with the pipeline to simulate a deletion between pre-check and write.
 */
export class InMemoryListingWriter implements ListingWriter {
  private readonly listings = new Map<string, Listing>();

  constructor(private readonly blocklist = new InMemoryDeletionBlocklist()) {}

  async write(listing: Listing): Promise<WriteOutcome> {
    if (await this.blocklist.has(listing.id)) throw new DeletionBlockedError(listing.id);
    const outcome = this.listings.has(listing.id) ? 'updated' : 'imported';
    this.listings.set(listing.id, structuredClone(listing));
    return outcome;
  }

  get(id: string): Listing | undefined {
    const listing = this.listings.get(id);
    return listing === undefined ? undefined : structuredClone(listing);
  }

  get size(): number {
    return this.listings.size;
  }
}

export interface DynamoDbListingWriterOptions {
  client: DynamoDBDocumentClient;
  /** `Listings` table; partition key `id`. */
  listingsTable: string;
  /** `DeletionBlocklist` table; partition key {@link DELETION_BLOCKLIST_KEY_ATTRIBUTE}. */
  blocklistTable: string;
}

const PUT_INDEX = 0;
const BLOCKLIST_INDEX = 1;
const CONDITION_FAILED = 'ConditionalCheckFailed';

/**
 * Atomic upsert (design: "Connector_Framework und Import-Pipeline", step 7): one
 * `TransactWriteItems` with `Put(Listings)` and `ConditionCheck(DeletionBlocklist,
 * attribute_not_exists)`, so a deletion that blocks the id concurrently can never be undone by an
 * import. `Put` replaces the whole item (media and tours included, Req 4.11, 16.3) with the item
 * layout of `toListingItem` (listing + flat search fields + `gsiPk`).
 *
 * `imported` vs. `updated` (Req 5.8): the first transaction puts with `attribute_not_exists(id)`.
 * Success ⇒ `imported`. If only that condition fails the item exists, and a second transaction
 * without it replaces the item ⇒ `updated`. This is exact for concurrent writers of the same id
 * (only one of them can create it), unlike a preceding `GetItem`, where two writers could both see
 * "absent" and both count `imported`. Cost: an update takes two transactions. The only deletion
 * path (erasure, Req 18.6) blocks the id first, so a deletion between both transactions makes the
 * second one fail with {@link DeletionBlockedError} instead of re-creating the listing.
 */
export class DynamoDbListingWriter implements ListingWriter {
  private readonly client: DynamoDBDocumentClient;
  private readonly listingsTable: string;
  private readonly blocklistTable: string;

  constructor({ client, listingsTable, blocklistTable }: DynamoDbListingWriterOptions) {
    this.client = client;
    this.listingsTable = listingsTable;
    this.blocklistTable = blocklistTable;
  }

  async write(listing: Listing): Promise<WriteOutcome> {
    try {
      await this.transact(listing, true);
      return 'imported';
    } catch (error) {
      if (!this.isPutConditionFailure(error, listing.id)) throw error;
    }
    try {
      await this.transact(listing, false);
      return 'updated';
    } catch (error) {
      this.throwIfBlocked(error, listing.id);
      throw error;
    }
  }

  private async transact(listing: Listing, createOnly: boolean): Promise<void> {
    const createCondition = createOnly
      ? {
          ConditionExpression: 'attribute_not_exists(#id)',
          ExpressionAttributeNames: { '#id': 'id' },
        }
      : {};
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.listingsTable,
              Item: toListingItem(listing),
              ...createCondition,
            },
          },
          {
            ConditionCheck: {
              TableName: this.blocklistTable,
              Key: { [DELETION_BLOCKLIST_KEY_ATTRIBUTE]: listing.id },
              ConditionExpression: 'attribute_not_exists(#key)',
              ExpressionAttributeNames: { '#key': DELETION_BLOCKLIST_KEY_ATTRIBUTE },
            },
          },
        ],
      }),
    );
  }

  /** `true` if only the create condition failed; a blocked id throws, anything else is `false`. */
  private isPutConditionFailure(error: unknown, listingId: string): boolean {
    this.throwIfBlocked(error, listingId);
    return cancellationCodes(error)?.[PUT_INDEX] === CONDITION_FAILED;
  }

  private throwIfBlocked(error: unknown, listingId: string): void {
    if (cancellationCodes(error)?.[BLOCKLIST_INDEX] === CONDITION_FAILED) {
      throw new DeletionBlockedError(listingId);
    }
  }
}

/** Per-item cancellation codes of a `TransactionCanceledException`, otherwise `undefined`. */
function cancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') return undefined;
  const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return reasons?.map((reason) => reason.Code);
}
