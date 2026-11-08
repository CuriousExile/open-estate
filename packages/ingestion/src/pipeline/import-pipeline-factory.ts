import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  DuplicateDetector,
  DynamoDbDeletionBlocklistCheck,
  DynamoDbDuplicateIndexStore,
  DynamoDbListingKeyStore,
  DynamoDbListingVersionStore,
  DynamoDbManagedListingStore,
  DynamoDbMetricCounterStore,
  DynamoDbTransactor,
  I18nConfig,
  loadConfig,
  loadDuplicateConfig,
  loadOptionalConfigFile,
  READ_MODEL_CONFIG_FILES,
  S3SnapshotStore,
  systemClock,
  VersionedListingWriter,
  SsmDuplicateDetectionSetting,
  type Clock,
  type ConfigSources,
} from '@open-estate/core';
import {
  assertValidTaxonomy,
  buildSchemas,
  DUPLICATE_CONFIG_FILE,
  PiiAllowlistConfig,
  TaxonomyConfig,
  TourProvidersConfig,
  type DuplicateConfig,
  type LocaleConfig,
  type Taxonomy,
} from '@open-estate/shared';
import { DynamoDbDeletionBlocklist } from './deletion-blocklist';
import { ImportPipeline } from './import-pipeline';

// The import write path on the deployed stores (design: "Import-Pipeline"): what a connector
// Lambda runs per record, and what the seed script and the load-test generator use to write their
// listings exactly like an import — with version, Feldherkunft, counters, Custom_Id keys, snapshot
// and Duplikat_Prüfung (instead of raw items the Management_API could not read).

/** Object key of the PII allowlist in the private config bucket. */
export const PII_ALLOWLIST_FILE = 'pii-allowlist.json';

/** Configuration files of the import, read from the private config bucket. */
export const IMPORT_CONFIG_FILES = {
  taxonomy: READ_MODEL_CONFIG_FILES.taxonomy,
  i18n: READ_MODEL_CONFIG_FILES.i18n,
  /** Optional: missing ⇒ no tour provider allowed (default-deny, Req 16.9). */
  tourProviders: READ_MODEL_CONFIG_FILES.tourProviders,
  /** Optional: missing ⇒ every PII field is dropped (Req 18.3). */
  piiAllowlist: PII_ALLOWLIST_FILE,
  /** Optional: missing ⇒ the documented defaults of the Duplikat_Bewertung. */
  duplicateDetection: DUPLICATE_CONFIG_FILE,
} as const;

/** Tables and bucket of the import write path. */
export interface ImportStoreNames {
  listingsTable: string;
  deletionBlocklistTable: string;
  listingVersionsTable: string;
  listingKeysTable: string;
  metricCountersTable: string;
  /** `VersionSnapshots` bucket of the `VersionedListingWriter`. */
  snapshotBucket: string;
  /** Duplikat_Index of the Duplikat_Prüfung (duplicate-detection Req 5.1, 6.1). */
  duplicateIndexTable: string;
}

/** Validated configuration the import checks records against. */
export interface ImportConfig {
  taxonomy: Taxonomy;
  locales: LocaleConfig;
  tourProviders: TourProvidersConfig;
  piiAllowlist: PiiAllowlistConfig;
  duplicateConfig: DuplicateConfig;
}

/**
 * Loads taxonomy, locales, tour and PII allowlists and the Duplikat_Konfiguration (from the config
 * bucket named by `CONFIG_BUCKET` in `sources.env`, else the local sources). Throws `ConfigError`
 * or `TaxonomyValidationError` naming every affected value.
 */
export async function loadImportConfig(sources: ConfigSources): Promise<ImportConfig> {
  const files = IMPORT_CONFIG_FILES;
  const [config, tourProviders, piiAllowlist, duplicateConfig] = await Promise.all([
    loadConfig({ files: [files.taxonomy, files.i18n] }, sources),
    loadOptionalConfigFile(files.tourProviders, TourProvidersConfig, { providers: [] }, sources),
    loadOptionalConfigFile(files.piiAllowlist, PiiAllowlistConfig, { allowedFields: [] }, sources),
    loadDuplicateConfig(sources),
  ]);
  return {
    taxonomy: assertValidTaxonomy(config.loadJson(files.taxonomy, TaxonomyConfig)),
    locales: config.loadJson(files.i18n, I18nConfig),
    tourProviders,
    piiAllowlist,
    duplicateConfig,
  };
}

export interface ImportPipelineWiring {
  names: ImportStoreNames;
  config: ImportConfig;
  dynamo: DynamoDBDocumentClient;
  s3?: S3Client;
  clock?: Clock;
  /**
   * SSM parameter with Ein/Aus of the Duplikat-Erkennung (`/open-estate/<env>/duplicate-detection`,
   * read at most once a minute); default: always on.
   */
  duplicateDetectionParameter?: string;
  /** Client of that parameter; default: SDK defaults. */
  ssm?: SSMClient;
}

/** The import pipeline on the DynamoDB tables and the snapshot bucket. */
export function createImportPipeline({
  names,
  config,
  dynamo,
  s3 = new S3Client({}),
  clock = systemClock,
  duplicateDetectionParameter,
  ssm,
}: ImportPipelineWiring): ImportPipeline {
  const table = (tableName: string) => ({ client: dynamo, tableName });
  const listings = new DynamoDbManagedListingStore(table(names.listingsTable));
  const keys = new DynamoDbListingKeyStore(table(names.listingKeysTable));
  const duplicateIndex = new DynamoDbDuplicateIndexStore(table(names.duplicateIndexTable));
  const detector = new DuplicateDetector({
    index: duplicateIndex,
    taxonomy: config.taxonomy,
    config: config.duplicateConfig,
  });
  const writer = new VersionedListingWriter({
    listings,
    versions: new DynamoDbListingVersionStore(table(names.listingVersionsTable)),
    keys,
    blocklist: new DynamoDbDeletionBlocklistCheck({ tableName: names.deletionBlocklistTable }),
    counters: new DynamoDbMetricCounterStore(table(names.metricCountersTable)),
    snapshots: new S3SnapshotStore({ client: s3, bucketName: names.snapshotBucket }),
    transactor: new DynamoDbTransactor({ client: dynamo }),
    clock,
    duplicates: { index: duplicateIndex, detector },
  });
  return new ImportPipeline({
    listingSchema: buildSchemas(config.taxonomy, config.locales).listing,
    reader: {
      listings,
      keys,
      blocklist: new DynamoDbDeletionBlocklist({
        client: dynamo,
        tableName: names.deletionBlocklistTable,
      }),
    },
    writer,
    piiAllowlist: config.piiAllowlist,
    tourProviders: config.tourProviders,
    taxonomy: config.taxonomy,
    duplicates: detector,
    ...(duplicateDetectionParameter !== undefined && {
      detection: new SsmDuplicateDetectionSetting({
        client: ssm ?? new SSMClient({}),
        parameterName: duplicateDetectionParameter,
        clock,
      }),
    }),
    clock,
  });
}
