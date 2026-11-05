import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  assertValidTaxonomy,
  buildSchemas,
  Currency,
  LocaleTag,
  TaxonomyConfig,
  TaxonomyValidationError,
  TourProvidersConfig,
  type LocaleConfig,
  type Schemas,
  type Taxonomy,
} from '@open-estate/shared';
import { z } from 'zod';
import { SsmAccessConfigSource } from '../access/access-config';
import { createAccessGuard, type AccessGuard } from '../access/access-guard';
import { DynamoDbApiKeyStore } from '../access/api-key-store';
import { DynamoDbRateLimitCounterStore } from '../access/rate-limit-counter-store';
import { ConfigError } from '../config/config-error';
import { loadConfig, SSM_PARAMETER_SUFFIX, type ConfigSources } from '../config/config-provider';
import { DynamoDbAgencyStore } from '../management/agency-store';
import { createListingService, type ListingService } from '../search/listing-service';
import { createOpenSearchClient } from '../search/opensearch-client';
import {
  createSearchProvider,
  parseSearchProviderKind,
  type SearchProviderKind,
} from '../search/search-provider-factory';
import type { SearchProvider } from '../search/search-provider';
import { createSearchService, type SearchService } from '../search/search-service';
import {
  createCachedSuspendedAgencies,
  type SuspendedAgencies,
} from '../search/suspended-agencies';
import { NO_USAGE, type UsageRecorder } from '../usage/usage-line';

// Lambda init of the read side shared by the public adapters (design: "ConfigProvider",
// "Taxonomy", "Konfigurationsmodelle"): config, taxonomy, locales and tour allow-list are loaded
// and validated once; guard, schemas and services are built from them. Used by the MCP Lambda;
// same environment and config contract as the Listings Lambda of `@open-estate/api`.

/** Environment variables (set by the CDK stack). */
export const READ_MODEL_ENV = {
  listingsTable: 'LISTINGS_TABLE_NAME',
  apiKeysTable: 'API_KEYS_TABLE_NAME',
  rateLimitCountersTable: 'RATE_LIMIT_COUNTERS_TABLE_NAME',
  /** `Agencies` table; GSI `byState` yields the suspended agencies (Req 1.9). */
  agenciesTable: 'AGENCIES_TABLE_NAME',
  /** SSM parameter names read by the AccessGuard (60-s cache, no restart needed, Req 17.9). */
  accessModeParameter: `ACCESS_MODE${SSM_PARAMETER_SUFFIX}`,
  rateLimitParameter: `RATE_LIMIT${SSM_PARAMETER_SUFFIX}`,
  /** Only with `search-provider = opensearch`. */
  openSearchEndpoint: 'OPENSEARCH_ENDPOINT',
  openSearchIndex: 'OPENSEARCH_INDEX',
  region: 'AWS_REGION',
} as const;

/** Values resolved by the ConfigProvider (env or `<NAME>_SSM_PARAMETER`). */
export const READ_MODEL_CONFIG_VALUES = {
  defaultCurrency: 'DEFAULT_CURRENCY',
  searchProvider: 'SEARCH_PROVIDER',
} as const;

/** Files in the private config bucket. */
export const READ_MODEL_CONFIG_FILES = {
  taxonomy: 'taxonomy.json',
  i18n: 'i18n-config.json',
  /** Optional: a missing file means "no tour provider allowed" (default-deny). */
  tourProviders: 'tour-providers.json',
} as const;

/** `i18n-config.json`: default locale must be enabled; locales unique (case-insensitive). */
export const I18nConfig = z
  .object({
    defaultLocale: LocaleTag,
    enabled: z.array(z.object({ locale: LocaleTag, label: z.string().trim().min(1) })).min(1),
  })
  .superRefine(({ defaultLocale, enabled }, ctx) => {
    const seen = new Set<string>();
    enabled.forEach(({ locale }, index) => {
      const key = locale.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['enabled', index, 'locale'],
          message: `duplicate locale ${locale}`,
        });
      }
      seen.add(key);
    });
    if (!enabled.some(({ locale }) => locale === defaultLocale)) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultLocale'],
        message: 'default locale is not enabled',
      });
    }
  });

export interface ReadModelSources extends ConfigSources {
  dynamo?: DynamoDBDocumentClient;
  /** Usage lines of search and detail (Req 13.4); defaults to none. */
  usage?: UsageRecorder;
}

/** Everything a read adapter (API, MCP) needs; built once per Lambda instance. */
export interface ReadModel {
  guard: AccessGuard;
  schemas: Schemas;
  taxonomy: Taxonomy;
  /** Enabled locales and default locale (`i18n-config.json`). */
  locales: LocaleConfig;
  /** ISO 4217 default currency of price filters (Req 12.9). */
  defaultCurrency: string;
  /** Tour allow-list; empty if `tour-providers.json` is missing (default-deny). */
  tourProviders: TourProvidersConfig;
  search: SearchService;
  listings: ListingService;
}

const EMPTY_TOUR_PROVIDERS: TourProvidersConfig = { providers: [] };

/** Checks all `names` at once; one `ConfigError{CONFIG_MISSING}` names every missing variable. */
function requireEnv(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): (name: string) => string {
  const values = new Map<string, string>();
  const missing: string[] = [];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) values.set(name, value);
    else missing.push(name);
  }
  if (missing.length > 0) throw new ConfigError('CONFIG_MISSING', missing);
  return (name) => {
    const value = values.get(name);
    if (value === undefined) throw new ConfigError('CONFIG_MISSING', [name]);
    return value;
  };
}

function providerEnv(kind: SearchProviderKind): string[] {
  return kind === 'dynamodb'
    ? [READ_MODEL_ENV.listingsTable]
    : [READ_MODEL_ENV.openSearchEndpoint, READ_MODEL_ENV.openSearchIndex, READ_MODEL_ENV.region];
}

function parseDefaultCurrency(value: string | undefined): string {
  const currency = value?.trim() ?? '';
  if (Currency.safeParse(currency).success) return currency;
  throw new ConfigError(
    'CONFIG_INVALID',
    [READ_MODEL_CONFIG_VALUES.defaultCurrency],
    [{ path: '', message: 'expected an ISO 4217 code (three upper-case letters)' }],
  );
}

/** Missing allow-list ⇒ empty (default-deny, Req 16.9); an invalid file aborts the init. */
async function loadTourProviders(sources: ConfigSources): Promise<TourProvidersConfig> {
  const key = READ_MODEL_CONFIG_FILES.tourProviders;
  try {
    const config = await loadConfig({ files: [key] }, sources);
    return config.loadJson(key, TourProvidersConfig);
  } catch (error) {
    const onlyThisFileMissing =
      error instanceof ConfigError &&
      error.code === 'CONFIG_MISSING' &&
      error.names.length === 1 &&
      error.names[0] === key;
    if (onlyThisFileMissing) return EMPTY_TOUR_PROVIDERS;
    throw error;
  }
}

/**
 * Loads and validates the configuration and builds guard, schemas and services. Throws
 * `ConfigError` or `TaxonomyValidationError` (all affected names/codes) on invalid
 * configuration; AWS errors propagate.
 */
export async function initReadModel(
  env: Readonly<Record<string, string | undefined>>,
  sources: ReadModelSources = {},
): Promise<ReadModel> {
  const ssm = sources.ssm ?? new SSMClient({});
  const s3 = sources.s3 ?? new S3Client({});
  const configSources: ConfigSources = { ...sources, env, ssm, s3 };

  const [config, tourProviders] = await Promise.all([
    loadConfig(
      {
        values: Object.values(READ_MODEL_CONFIG_VALUES),
        files: [READ_MODEL_CONFIG_FILES.taxonomy, READ_MODEL_CONFIG_FILES.i18n],
      },
      configSources,
    ),
    loadTourProviders(configSources),
  ]);

  const values = config.requireAll(Object.values(READ_MODEL_CONFIG_VALUES));
  const defaultCurrency = parseDefaultCurrency(values[READ_MODEL_CONFIG_VALUES.defaultCurrency]);
  const kind = parseSearchProviderKind(values[READ_MODEL_CONFIG_VALUES.searchProvider]);
  const vars = requireEnv(env, [
    READ_MODEL_ENV.apiKeysTable,
    READ_MODEL_ENV.rateLimitCountersTable,
    READ_MODEL_ENV.agenciesTable,
    READ_MODEL_ENV.accessModeParameter,
    READ_MODEL_ENV.rateLimitParameter,
    ...providerEnv(kind),
  ]);

  const taxonomy = assertValidTaxonomy(
    config.loadJson(READ_MODEL_CONFIG_FILES.taxonomy, TaxonomyConfig),
  );
  const locales = config.loadJson(READ_MODEL_CONFIG_FILES.i18n, I18nConfig);

  const dynamo = sources.dynamo ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const guard = createAccessGuard({
    config: new SsmAccessConfigSource({
      client: ssm,
      accessModeParameter: vars(READ_MODEL_ENV.accessModeParameter),
      rateLimitParameter: vars(READ_MODEL_ENV.rateLimitParameter),
    }),
    apiKeys: new DynamoDbApiKeyStore({
      client: dynamo,
      tableName: vars(READ_MODEL_ENV.apiKeysTable),
    }),
    counters: new DynamoDbRateLimitCounterStore({
      client: dynamo,
      tableName: vars(READ_MODEL_ENV.rateLimitCountersTable),
    }),
  });
  const provider = createSearchProvider(kind, {
    dynamodb: () => ({ client: dynamo, tableName: vars(READ_MODEL_ENV.listingsTable) }),
    opensearch: () => ({
      client: createOpenSearchClient({
        node: vars(READ_MODEL_ENV.openSearchEndpoint),
        region: vars(READ_MODEL_ENV.region),
      }),
      index: vars(READ_MODEL_ENV.openSearchIndex),
    }),
  });

  // One cache shared by search and detail, so both see the same suspension state.
  const suspendedAgencies = createCachedSuspendedAgencies({
    store: new DynamoDbAgencyStore({
      client: dynamo,
      tableName: vars(READ_MODEL_ENV.agenciesTable),
    }),
  });

  return createReadModel({
    guard,
    provider,
    taxonomy,
    locales,
    defaultCurrency,
    tourProviders,
    suspendedAgencies,
    ...(sources.usage !== undefined && { usage: sources.usage }),
  });
}

/** Already loaded configuration and backends of a {@link ReadModel}. */
export interface ReadModelParts {
  guard: AccessGuard;
  provider: SearchProvider;
  taxonomy: Taxonomy;
  locales: LocaleConfig;
  defaultCurrency: string;
  tourProviders: TourProvidersConfig;
  /** Shared by search and detail, so both see the same suspension state. */
  suspendedAgencies: SuspendedAgencies;
  /** Defaults to none. */
  usage?: UsageRecorder;
}

/**
 * Builds schemas and services over already loaded parts. Used by {@link initReadModel}; other
 * callers (tests, the local dev server) inject their own guard, provider and agency source.
 */
export function createReadModel(parts: ReadModelParts): ReadModel {
  const { guard, provider, taxonomy, locales, defaultCurrency, tourProviders } = parts;
  const { suspendedAgencies } = parts;
  const usage = parts.usage ?? NO_USAGE;
  return {
    guard,
    schemas: buildSchemas(taxonomy, locales),
    taxonomy,
    locales,
    defaultCurrency,
    tourProviders,
    search: createSearchService({
      provider,
      taxonomy,
      tourProviders,
      defaultCurrency,
      suspendedAgencies,
      usage,
    }),
    listings: createListingService({ provider, taxonomy, suspendedAgencies, usage }),
  };
}

/** Configuration errors stay until the next cold start (restart semantics, Req 15.3, 15.4). */
export function isConfigFailure(error: unknown): boolean {
  return error instanceof ConfigError || error instanceof TaxonomyValidationError;
}

/** Machine-readable init log: names/codes of the affected values, never their content. */
export function describeInitFailure(error: unknown): Record<string, unknown> {
  if (error instanceof ConfigError) return { errorName: error.name, ...error.toJSON() };
  if (error instanceof TaxonomyValidationError) {
    return { errorName: error.name, violations: error.violations };
  }
  return { errorName: error instanceof Error ? error.name : typeof error };
}
