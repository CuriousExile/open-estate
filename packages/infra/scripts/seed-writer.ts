import { DescribeStacksCommand, type CloudFormationClient } from '@aws-sdk/client-cloudformation';
import {
  CONFIG_BUCKET_ENV,
  contentToInput,
  DUPLICATE_DETECTION_PARAMETER_ENV,
} from '@open-estate/core';
import {
  CONNECTOR_LAMBDA_ENV,
  createRunLogger,
  type ImportStoreNames,
  type LogSink,
  type RecordOutcome,
  type RecordProcessor,
} from '@open-estate/ingestion';
import type { Listing } from '@open-estate/shared';

// Writes example and load-test listings like an import (source `seed` / `loadtest`): through the
// import pipeline with version 1, Feldherkunft, counters, snapshot and Duplikat_Prüfung. Raw items
// (`toListingItem` only) lacked the management attributes, so the Management_API could not read
// them and the Duplikat_Abgleich skipped them.

/** CloudFormation outputs of the stores, per stack (kept in sync with the stacks by a test). */
export const STACK_OUTPUTS = {
  data: {
    listingsTable: 'ListingsTableName',
    deletionBlocklistTable: 'DeletionBlocklistTableName',
    configBucket: 'ConfigBucketName',
  },
  managementData: {
    listingVersionsTable: 'ListingVersionsTableName',
    listingKeysTable: 'ListingKeysTableName',
    metricCountersTable: 'MetricCountersTableName',
    duplicateIndexTable: 'DuplicateIndexTableName',
    snapshotBucket: 'SnapshotBucketName',
  },
} as const;

/** `ListingsTableName`, still read by tools that only need the table. */
export const LISTINGS_TABLE_OUTPUT = STACK_OUTPUTS.data.listingsTable;

/**
 * Environment variables that override an output, named like the connector Lambda's
 * (`LISTINGS_TABLE_NAME`, …, `CONFIG_BUCKET`).
 */
export const SEED_TARGET_ENV = {
  listingsTable: CONNECTOR_LAMBDA_ENV.listingsTable,
  deletionBlocklistTable: CONNECTOR_LAMBDA_ENV.deletionBlocklistTable,
  listingVersionsTable: CONNECTOR_LAMBDA_ENV.listingVersionsTable,
  listingKeysTable: CONNECTOR_LAMBDA_ENV.listingKeysTable,
  metricCountersTable: CONNECTOR_LAMBDA_ENV.metricCountersTable,
  duplicateIndexTable: CONNECTOR_LAMBDA_ENV.duplicateIndexTable,
  snapshotBucket: CONNECTOR_LAMBDA_ENV.snapshotBucket,
  configBucket: CONFIG_BUCKET_ENV,
} as const satisfies Record<keyof SeedTargets, string>;

const ENV_NAME_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;

function stackName(envName: string, suffix: string): string {
  if (!ENV_NAME_PATTERN.test(envName)) {
    throw new Error(`Invalid environment name ${JSON.stringify(envName)}`);
  }
  return `OpenEstate-${envName}-${suffix}`;
}

/** Data stack name per environment; mirrors `resolveEnvironment` in `src/config.ts` (checked by a test). */
export const dataStackName = (envName: string): string => stackName(envName, 'Data');
export const managementDataStackName = (envName: string): string =>
  stackName(envName, 'ManagementData');

/**
 * SSM parameter with Ein/Aus of the Duplikat-Erkennung (`enabled` | `disabled`), so seeding
 * follows the platform's switch: `DUPLICATE_DETECTION_PARAMETER_NAME`, else
 * `/open-estate/<env>/duplicate-detection` (mirrors `ssmParameterNames` of the DataStack, checked
 * by a test).
 */
export function duplicateDetectionParameterName(envName: string, env: NodeJS.ProcessEnv): string {
  const override = env[DUPLICATE_DETECTION_PARAMETER_ENV]?.trim();
  if (override) return override;
  if (!ENV_NAME_PATTERN.test(envName)) {
    throw new Error(`Invalid environment name ${JSON.stringify(envName)}`);
  }
  return `/open-estate/${envName}/duplicate-detection`;
}

export type CloudFormationSender = Pick<CloudFormationClient, 'send'>;

/** Stores of the import write path plus the config bucket with taxonomy and allowlists. */
export interface SeedTargets extends ImportStoreNames {
  configBucket: string;
}

export interface SeedTargetSources {
  /** Process environment; a variable of {@link SEED_TARGET_ENV} wins over the stack output. */
  env: NodeJS.ProcessEnv;
  /** Environment name for the stack-output lookup. */
  envName: string;
  /** Lazily created: no CloudFormation client exists when the environment names everything. */
  cloudFormation: () => CloudFormationSender;
}

/**
 * Names of the stores: each from its environment variable, else from the outputs of
 * `OpenEstate-<env>-Data` and `OpenEstate-<env>-ManagementData`.
 */
export async function resolveSeedTargets(sources: SeedTargetSources): Promise<SeedTargets> {
  const fromEnv = (key: keyof SeedTargets) =>
    sources.env[SEED_TARGET_ENV[key]]?.trim() || undefined;
  const keys = Object.keys(SEED_TARGET_ENV) as (keyof SeedTargets)[];
  const values: Partial<SeedTargets> = {};
  for (const key of keys) {
    const value = fromEnv(key);
    if (value !== undefined) values[key] = value;
  }
  const stacks = [
    [dataStackName(sources.envName), STACK_OUTPUTS.data],
    [managementDataStackName(sources.envName), STACK_OUTPUTS.managementData],
  ] as const;
  for (const [stack, outputs] of stacks) {
    const byKey = outputs as Readonly<Partial<Record<keyof SeedTargets, string>>>;
    const missing = keys.filter((key) => byKey[key] !== undefined && values[key] === undefined);
    if (missing.length === 0) continue;
    const { Stacks } = await sources
      .cloudFormation()
      .send(new DescribeStacksCommand({ StackName: stack }));
    const found = Stacks?.[0]?.Outputs ?? [];
    for (const key of missing) {
      const outputKey = byKey[key];
      const value = found.find((o) => o.OutputKey === outputKey)?.OutputValue;
      if (!value) throw new Error(`Stack ${stack} has no output ${outputKey}`);
      values[key] = value;
    }
  }
  return values as SeedTargets;
}

/** Outcome counts of an import of listings, with the ids of rejected ones. */
export interface ImportSummary {
  imported: number;
  /** Created as a possible duplicate (inactive, flagged); also counted in `imported`. */
  flagged: number;
  updated: number;
  unchanged: number;
  rejected: string[];
}

export interface ImportOptions {
  /** Source of the listings (`seed`, `loadtest`); becomes their `source`. */
  source: string;
  /** Becomes `lastRunId` of created and changed listings. */
  runId: string;
  /** Records processed in parallel (default 8). */
  concurrency?: number;
  /** Run log lines (value-free); default: dropped. */
  sink?: LogSink;
}

/**
 * Imports `listings` (internal representation) through `processor` — the import pipeline —
 * like records of a connector: new ids are created `ACTIVE` (a duplicate of an older listing
 * `INACTIVE` with a Markierung), known ids are updated or stay unchanged. Idempotent: a repeated
 * run changes nothing but `lastImportedAt`.
 */
export async function importListings(
  processor: RecordProcessor,
  listings: readonly Listing[],
  { source, runId, concurrency = 8, sink = () => undefined }: ImportOptions,
): Promise<ImportSummary> {
  const logger = createRunLogger({ runId, source, sink });
  const summary: ImportSummary = {
    imported: 0,
    flagged: 0,
    updated: 0,
    unchanged: 0,
    rejected: [],
  };
  const count = (listing: Listing, outcome: RecordOutcome) => {
    if (outcome === 'rejected') summary.rejected.push(listing.id);
    else if (outcome === 'flagged') {
      summary.imported += 1;
      summary.flagged += 1;
    } else summary[outcome] += 1;
  };
  let next = 0;
  const worker = async () => {
    while (next < listings.length) {
      const listing = listings[next++];
      if (listing === undefined) continue;
      const record = { ...contentToInput(listing), id: listing.id };
      // Complete records: fields missing from a record are removed on the next run.
      count(
        listing,
        await processor.process(record, { runId, source, logger, importMode: 'REPLACE' }),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return summary;
}

/** Run id of one seeding, e.g. `seed-20260301T100000Z`. */
export const seedRunId = (prefix: string, now: Date = new Date()): string =>
  `${prefix}-${now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}`;
