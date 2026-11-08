import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  ConfigError,
  duplicateDataPurge,
  DynamoDbDuplicateIndexStore,
  DynamoDbDuplicateReportStore,
  DynamoDbIdempotencyStore,
  DynamoDbMetricCounterStore,
  DynamoDbTransactor,
  DynamoDbS3ListingHistoryStore,
} from '@open-estate/core';
import { z } from 'zod';
import { DynamoDbAuditLog } from '../audit-log';
import { DynamoDbDeletionBlocklistStore } from './deletion-blocklist-store';
import { DynamoDbDeletionListingStore } from './deletion-listing-store';
import { DynamoDbDeletionRequestStore } from './deletion-request-store';
import {
  createDeletionWorkflow,
  type DeleteListingOutput,
  type DeletionWorkflow,
} from './deletion-workflow';
import type { DeletionRequestRecord, TargetPage } from './deletion-model';

const requestId = z.string().min(1);

/** Payload of a Step Functions Lambda task; `step` selects the workflow step. */
export const deletionTaskEventSchema = z.discriminatedUnion('step', [
  z.strictObject({ step: z.literal('resolveTargets'), requestId, cursor: z.string().optional() }),
  z.strictObject({
    step: z.literal('deleteListing'),
    requestId,
    listingId: z.string().min(1),
    source: z.string().min(1),
  }),
  z.strictObject({ step: z.literal('finalize'), requestId }),
]);
export type DeletionTaskEvent = z.input<typeof deletionTaskEventSchema>;
export type DeletionTaskResult = TargetPage | DeleteListingOutput | DeletionRequestRecord;
export type DeletionTaskHandler = (event: unknown) => Promise<DeletionTaskResult>;

/**
 * Lambda task for the Step Functions deletion workflow (infra 14.10). Errors propagate, so the
 * state machine's retry policy applies; every step is idempotent. Nothing is logged here, in
 * particular no listing content (Req 18.8).
 */
export function createDeletionTaskHandler(workflow: DeletionWorkflow): DeletionTaskHandler {
  return async (event) => {
    const parsed = deletionTaskEventSchema.parse(event);
    switch (parsed.step) {
      case 'resolveTargets':
        return workflow.resolveTargets({
          requestId: parsed.requestId,
          ...(parsed.cursor !== undefined && { cursor: parsed.cursor }),
        });
      case 'deleteListing':
        return workflow.deleteListing(parsed);
      case 'finalize':
        return workflow.finalize(parsed);
    }
  };
}

/** Table names shared by the admin Lambda and the deletion task Lambda (set by CDK, 14.10). */
export const DELETION_ENV = {
  listingsTable: 'LISTINGS_TABLE_NAME',
  deletionRequestsTable: 'DELETION_REQUESTS_TABLE_NAME',
  deletionBlocklistTable: 'DELETION_BLOCKLIST_TABLE_NAME',
  auditLogTable: 'AUDIT_LOG_TABLE_NAME',
} as const;

/**
 * Stores of the version history the deletion task removes besides the listing (design:
 * "Löschprozess-Erweiterung", Req 9.2, 9.3); same names as the connector Lambda's. Required: the
 * task refuses to start without them rather than leave versions behind.
 */
export const DELETION_HISTORY_ENV = {
  listingVersionsTable: 'LISTING_VERSIONS_TABLE_NAME',
  listingKeysTable: 'LISTING_KEYS_TABLE_NAME',
  metricCountersTable: 'METRIC_COUNTERS_TABLE_NAME',
  snapshotBucket: 'SNAPSHOT_BUCKET_NAME',
  /** Duplikat-Erkennung's data of a listing, removed with it (duplicate-detection Req 12.3). */
  duplicateIndexTable: 'DUPLICATE_INDEX_TABLE_NAME',
  idempotencyKeysTable: 'IDEMPOTENCY_KEYS_TABLE_NAME',
  duplicateReportsTable: 'DUPLICATE_REPORTS_TABLE_NAME',
} as const;

/** All variables of the deletion task Lambda. */
export const DELETION_TASK_ENV = { ...DELETION_ENV, ...DELETION_HISTORY_ENV } as const;

/** Throws `ConfigError{code:"CONFIG_MISSING"}` naming every missing or empty variable (Req 9.4). */
export function readEnv<K extends string>(
  env: NodeJS.ProcessEnv,
  names: Readonly<Record<K, string>>,
): Record<K, string> {
  const result: Partial<Record<K, string>> = {};
  const missing: string[] = [];
  for (const [key, name] of Object.entries(names) as [K, string][]) {
    const value = env[name]?.trim();
    if (value) result[key] = value;
    else missing.push(name);
  }
  if (missing.length > 0) throw new ConfigError('CONFIG_MISSING', missing);
  return result as Record<K, string>;
}

/** Production workflow over DynamoDB and S3 from {@link DELETION_TASK_ENV}. */
export function createDeletionWorkflowFromEnv(
  env: NodeJS.ProcessEnv,
  dynamo: DynamoDBDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({})),
): DeletionWorkflow {
  const config = readEnv(env, DELETION_TASK_ENV);
  return createDeletionWorkflow({
    requests: new DynamoDbDeletionRequestStore({
      client: dynamo,
      tableName: config.deletionRequestsTable,
    }),
    listings: new DynamoDbDeletionListingStore({
      client: dynamo,
      listingsTable: config.listingsTable,
      deletionRequestsTable: config.deletionRequestsTable,
      listingKeysTable: config.listingKeysTable,
      metricCountersTable: config.metricCountersTable,
    }),
    blocklist: new DynamoDbDeletionBlocklistStore({
      client: dynamo,
      tableName: config.deletionBlocklistTable,
    }),
    history: new DynamoDbS3ListingHistoryStore({
      client: dynamo,
      versionsTable: config.listingVersionsTable,
      bucketName: config.snapshotBucket,
    }),
    audit: new DynamoDbAuditLog({ client: dynamo, tableName: config.auditLogTable }),
    duplicates: duplicateDataPurge({
      index: new DynamoDbDuplicateIndexStore({
        client: dynamo,
        tableName: config.duplicateIndexTable,
      }),
      idempotency: new DynamoDbIdempotencyStore({
        client: dynamo,
        tableName: config.idempotencyKeysTable,
      }),
      reports: new DynamoDbDuplicateReportStore({
        client: dynamo,
        tableName: config.duplicateReportsTable,
      }),
      counters: new DynamoDbMetricCounterStore({
        client: dynamo,
        tableName: config.metricCountersTable,
      }),
      transactor: new DynamoDbTransactor({ client: dynamo }),
    }),
  });
}
