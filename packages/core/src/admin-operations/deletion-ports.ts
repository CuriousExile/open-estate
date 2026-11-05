import type {
  DeletionBlocklistEntry,
  DeletionRequestRecord,
  DeletionTarget,
  TargetPage,
} from './deletion-model';

// Ports of the deletion process used by `AdminOperations`; adapters live in `@open-estate/admin`.

/** `DeletionRequests` table (design: "DynamoDB-Tabellen"). */
export interface DeletionRequestStore {
  /** Creates a new request; an existing `requestId` is an error. */
  create(record: DeletionRequestRecord): Promise<void>;
  get(requestId: string): Promise<DeletionRequestRecord | null>;
  /**
   * `OPEN` → `EXECUTED` with `executedAt`. Idempotent: an already executed request is returned
   * unchanged (its first `executedAt` stays). `null` if the request does not exist.
   */
  markExecuted(requestId: string, executedAt: string): Promise<DeletionRequestRecord | null>;
  /**
   * Ids of `OPEN` requests with `requestedAt` strictly before `requestedBefore` (ISO-8601 UTC),
   * oldest first, at most `limit` per page (overdue check 14.7). May be stale: callers re-read.
   */
  listOpenRequestedBefore(
    requestedBefore: string,
    page: RequestIdPageRequest,
  ): Promise<RequestIdPage>;
  /**
   * Sets `notifiedAt` once on an `OPEN` request; the status is not changed (Req 18.10). `false`
   * if the request is missing, no longer `OPEN` or already notified.
   */
  markNotified(requestId: string, notifiedAt: string): Promise<boolean>;
}

export interface RequestIdPageRequest {
  limit: number;
  cursor?: string;
}

export interface RequestIdPage {
  requestIds: string[];
  /** Opaque; present if more ids may follow. */
  nextCursor?: string;
}

export interface TargetPageRequest {
  limit: number;
  cursor?: string;
}

/** The deletion workflow's view of the `Listings` table: key lookups and removal only. */
export interface DeletionListingStore {
  /** The listing with this id, or `null`. */
  find(listingId: string): Promise<DeletionTarget | null>;
  /** Listings of a source, ordered by id, at most `limit` per page. */
  listBySource(source: string, page: TargetPageRequest): Promise<TargetPage>;
  /**
   * Removes the listing — media and tours are references inside the item and go with it
   * (Req 18.4) — and counts it on the request, atomically. `false` if the listing no longer
   * exists (already removed, e.g. by a re-run), in which case nothing is counted.
   */
  removeForRequest(listingId: string, requestId: string): Promise<boolean>;
}

/**
 * Write side of the `DeletionBlocklist` (Req 18.6); the import pipeline reads it (Req 18.7).
 */
export interface DeletionBlocklistStore {
  /** Adds the id. Idempotent: an existing entry is kept unchanged. */
  block(entry: DeletionBlocklistEntry): Promise<void>;
  /** Removes the id; `false` if it was not listed. */
  unblock(listingId: string): Promise<boolean>;
}

/** Starts the deletion workflow for a created `OPEN` request (design step 2). */
export interface DeletionWorkflowStarter {
  start(requestId: string): Promise<void>;
}
