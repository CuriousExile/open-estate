import { S3Client } from '@aws-sdk/client-s3';
import {
  CONFIG_BUCKET_ENV,
  ConfigError,
  contentRules,
  DynamoDbAgencyStore,
  DynamoDbDeletionBlocklistCheck,
  DynamoDbListingKeyStore,
  DynamoDbListingVersionStore,
  DynamoDbManagedListingStore,
  DynamoDbMetricCounterStore,
  DynamoDbTransactor,
  ListingCommandService,
  ListingQueryService,
  loadConfig,
  manualContentSchema,
  READ_MODEL_CONFIG_FILES,
  READ_MODEL_ENV,
  S3SnapshotStore,
  VersionedListingWriter,
  VersionService,
  type ConfigSources,
} from '@open-estate/core';
import {
  assertValidTaxonomy,
  PiiAllowlistConfig,
  TaxonomyConfig,
  TourProvidersConfig,
} from '@open-estate/shared';
import type { ZodType } from 'zod';
import { MANAGEMENT_ENV, readEnv } from '../../env';
import type { RouteGroupContext } from '../route-group';

// Production wiring of the listing and version routes: DynamoDB stores, the S3 snapshot store
// and the content rules of the import (taxonomy, tour and PII allow-lists from the private config
// bucket), so manual edits are validated exactly like imports (Req 4.3).

/** Environment variables of the listing routes (set by the ManagementStack). */
export const LISTING_ROUTES_ENV = {
  listingsTable: READ_MODEL_ENV.listingsTable,
  listingVersionsTable: 'LISTING_VERSIONS_TABLE_NAME',
  listingKeysTable: 'LISTING_KEYS_TABLE_NAME',
  metricCountersTable: 'METRIC_COUNTERS_TABLE_NAME',
  deletionBlocklistTable: 'DELETION_BLOCKLIST_TABLE_NAME',
  agenciesTable: MANAGEMENT_ENV.agenciesTable,
  /** `VersionSnapshots` bucket (read and written by the `VersionedListingWriter`). */
  snapshotBucket: 'SNAPSHOT_BUCKET_NAME',
  /** Private config bucket with taxonomy, tour and PII allow-lists. */
  configBucket: CONFIG_BUCKET_ENV,
} as const;

/** Files of the config bucket the listing commands validate against. */
export const LISTING_CONFIG_FILES = {
  taxonomy: READ_MODEL_CONFIG_FILES.taxonomy,
  /** Optional: missing ⇒ no tour provider allowed (default-deny). */
  tourProviders: READ_MODEL_CONFIG_FILES.tourProviders,
  /** Optional: missing ⇒ every PII field is dropped (same key as the connector Lambda). */
  piiAllowlist: 'pii-allowlist.json',
} as const;

export type ListingCommands = Pick<
  ListingCommandService,
  'create' | 'replaceContent' | 'setStatus' | 'assignAgency' | 'restore'
>;

/** Use cases behind the listing routes. */
export interface ListingServices {
  queries: Pick<ListingQueryService, 'get' | 'getByCustomId' | 'list' | 'lookup'>;
  versions: Pick<VersionService, 'list' | 'get' | 'diff'>;
  /**
   * Command service; resolved asynchronously because the content rules come from the config
   * bucket. A failed load is retried by the next call.
   */
  commands: () => Promise<ListingCommands>;
}

export interface ListingServiceOptions {
  /** Default: SDK defaults (region and credentials from the environment). */
  s3?: S3Client;
}

/** Optional config file: missing yields `fallback`, invalid throws `ConfigError`. */
async function loadOptional<T>(
  key: string,
  schema: ZodType<T>,
  fallback: T,
  sources: ConfigSources,
): Promise<T> {
  try {
    return (await loadConfig({ files: [key] }, sources)).loadJson(key, schema);
  } catch (error) {
    const onlyThisFileMissing =
      error instanceof ConfigError &&
      error.code === 'CONFIG_MISSING' &&
      error.names.length === 1 &&
      error.names[0] === key;
    if (onlyThisFileMissing) return fallback;
    throw error;
  }
}

/** Memoized `load`; a rejection is not cached, so the next call loads again. */
function retryingOnce<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

/**
 * Builds the listing use cases from the environment. Throws `ConfigError` naming every missing
 * variable. The content rules start loading immediately (Lambda init phase); taxonomy errors
 * surface on the first write as a 503 and are retried by the next one.
 */
export function createListingServices(
  { env, clients, shared }: RouteGroupContext,
  options: ListingServiceOptions = {},
): ListingServices {
  const names = readEnv(env, LISTING_ROUTES_ENV);
  const dynamo = clients.dynamo;
  const s3 = options.s3 ?? new S3Client({});
  const table = (tableName: string) => ({ client: dynamo, tableName });

  const listings = new DynamoDbManagedListingStore(table(names.listingsTable));
  const versions = new DynamoDbListingVersionStore(table(names.listingVersionsTable));
  const keys = new DynamoDbListingKeyStore(table(names.listingKeysTable));
  const snapshots = new S3SnapshotStore({ client: s3, bucketName: names.snapshotBucket });
  const agencies = new DynamoDbAgencyStore(table(names.agenciesTable));
  const writer = new VersionedListingWriter({
    listings,
    versions,
    keys,
    blocklist: new DynamoDbDeletionBlocklistCheck({ tableName: names.deletionBlocklistTable }),
    counters: new DynamoDbMetricCounterStore(table(names.metricCountersTable)),
    snapshots,
    transactor: new DynamoDbTransactor({ client: dynamo }),
    clock: shared.clock,
  });
  const { audit, frontendOrigin } = shared;

  const configSources: ConfigSources = { env, s3, ssm: clients.ssm };
  const files = LISTING_CONFIG_FILES;
  const commands = retryingOnce(async (): Promise<ListingCommands> => {
    const [config, tourProviders, piiAllowlist] = await Promise.all([
      loadConfig({ files: [files.taxonomy] }, configSources),
      loadOptional(files.tourProviders, TourProvidersConfig, { providers: [] }, configSources),
      loadOptional(files.piiAllowlist, PiiAllowlistConfig, { allowedFields: [] }, configSources),
    ]);
    const taxonomy = assertValidTaxonomy(config.loadJson(files.taxonomy, TaxonomyConfig));
    return new ListingCommandService({
      listings,
      versions,
      snapshots,
      agencies,
      writer,
      audit,
      frontendOrigin,
      contentSchema: manualContentSchema(taxonomy),
      rules: contentRules({ tourProviders, piiAllowlist }),
    });
  });
  // Start loading during init; a failure is reported by (and retried on) the first write.
  commands().catch(() => undefined);

  return {
    queries: new ListingQueryService({ listings, keys, audit, frontendOrigin }),
    versions: new VersionService({ listings, versions, snapshots, audit }),
    commands,
  };
}
