// Key layout of the GDPR deletion tables (design: "DynamoDB-Tabellen"), shared by infra (14.10),
// the import pipeline (blocklist check) and the admin deletion workflow (14.3, 14.7).

/** Partition key attribute of the `DeletionBlocklist` table. */
export const DELETION_BLOCKLIST_KEY_ATTRIBUTE = 'listingId';

/** Partition key attribute of the `DeletionRequests` table. */
export const DELETION_REQUESTS_KEY_ATTRIBUTE = 'requestId';

/** GSI of `DeletionRequests` for the overdue check (14.7): PK `status`, SK `requestedAt`. */
export const DELETION_REQUESTS_BY_STATUS_INDEX = 'byStatus';
export const DELETION_REQUESTS_BY_STATUS_PK_ATTRIBUTE = 'status';
export const DELETION_REQUESTS_BY_STATUS_SK_ATTRIBUTE = 'requestedAt';
