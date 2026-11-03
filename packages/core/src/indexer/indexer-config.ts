import { ConfigError } from '../config/config-error';

export const OPENSEARCH_ENDPOINT_ENV = 'OPENSEARCH_ENDPOINT';
export const OPENSEARCH_INDEX_ENV = 'OPENSEARCH_INDEX';
/** Set by the Lambda runtime. */
export const AWS_REGION_ENV = 'AWS_REGION';

export interface IndexerConfig {
  readonly endpoint: string;
  readonly index: string;
  readonly region: string;
}

/** Reads the indexer configuration; every missing value is named in one {@link ConfigError}. */
export function readIndexerConfig(env: NodeJS.ProcessEnv): IndexerConfig {
  const value = (name: string): string => env[name]?.trim() ?? '';
  const config = {
    endpoint: value(OPENSEARCH_ENDPOINT_ENV),
    index: value(OPENSEARCH_INDEX_ENV),
    region: value(AWS_REGION_ENV),
  };
  const missing = [
    [OPENSEARCH_ENDPOINT_ENV, config.endpoint],
    [OPENSEARCH_INDEX_ENV, config.index],
    [AWS_REGION_ENV, config.region],
  ].flatMap(([name, v]) => (v === '' ? [name as string] : []));
  if (missing.length > 0) throw new ConfigError('CONFIG_MISSING', missing);
  return config;
}
