import { z } from 'zod';
import { LISTING_BOUNDS } from '@open-estate/shared';

/** Deletion criterion (Req 18.4): exactly one listing id or all listings of one data source. */
export type DeletionCriterion = { listingId: string } | { source: string };

export const DELETION_STATUSES = ['OPEN', 'EXECUTED'] as const;
export type DeletionStatus = (typeof DELETION_STATUSES)[number];

/** Item of the `DeletionRequests` table (design: "DynamoDB-Tabellen"). */
export interface DeletionRequestRecord {
  requestId: string;
  criterion: DeletionCriterion;
  status: DeletionStatus;
  /** IAM `userArn` of the requesting administrator, or the user id of a Plattform_Admin. */
  requestedBy: string;
  /** ISO-8601. */
  requestedAt: string;
  /** ISO-8601; set when the request becomes `EXECUTED`. */
  executedAt?: string;
  /** Listings removed by this request so far. */
  removedCount: number;
  /** ISO-8601; set by the overdue check (14.7). */
  notifiedAt?: string;
}

/** A listing affected by a deletion request; only key data, never listing content. */
export interface DeletionTarget {
  listingId: string;
  source: string;
}

/** Entry of the `DeletionBlocklist` table; kept until an administrator removes it (Req 18.6). */
export interface DeletionBlocklistEntry {
  listingId: string;
  source: string;
  /** ISO-8601 time the id was blocked. */
  deletedAt: string;
  requestId: string;
}

export interface TargetPage {
  targets: DeletionTarget[];
  /** Opaque; present if more targets may follow. */
  nextCursor?: string;
}

/** Thrown by workflow steps for an unknown request id. */
export class DeletionRequestNotFoundError extends Error {
  constructor(readonly requestId: string) {
    super(`Deletion request ${requestId} not found`);
    this.name = 'DeletionRequestNotFoundError';
  }
}

const listingId = z.string().min(LISTING_BOUNDS.id.min).max(LISTING_BOUNDS.id.max);
const source = z.string().min(LISTING_BOUNDS.source.min).max(LISTING_BOUNDS.source.max);

/** Strict union: unknown fields and both/neither criterion are rejected. */
export const deletionCriterionSchema = z.union([
  z.strictObject({ listingId }),
  z.strictObject({ source }),
]);

const isoDateTime = z.iso.datetime({ offset: true });

/** Schema of a stored request; guards the DynamoDB adapter against foreign or corrupt items. */
export const deletionRequestRecordSchema = z.object({
  requestId: z.string().min(1),
  criterion: deletionCriterionSchema,
  status: z.enum(DELETION_STATUSES),
  requestedBy: z.string().min(1),
  requestedAt: isoDateTime,
  executedAt: isoDateTime.optional(),
  removedCount: z.number().int().nonnegative(),
  notifiedAt: isoDateTime.optional(),
});

/** Human-readable criterion for messages, e.g. `listingId "L-1"`. */
export function describeCriterion(criterion: DeletionCriterion): string {
  return 'listingId' in criterion
    ? `listingId ${JSON.stringify(criterion.listingId)}`
    : `source ${JSON.stringify(criterion.source)}`;
}
