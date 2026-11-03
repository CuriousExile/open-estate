import { ConfigError } from '../config/config-error';
import {
  DynamoDbSearchProvider,
  type DynamoDbSearchProviderOptions,
} from './dynamodb-search-provider';
import {
  OpenSearchSearchProvider,
  type OpenSearchSearchProviderOptions,
} from './opensearch-search-provider';
import type { SearchProvider } from './search-provider';

/** Values of the SSM parameter `search-provider`. */
export const SEARCH_PROVIDER_KINDS = ['dynamodb', 'opensearch'] as const;
export type SearchProviderKind = (typeof SEARCH_PROVIDER_KINDS)[number];

/** Name of the SSM parameter in config errors. */
export const SEARCH_PROVIDER_PARAMETER = 'search-provider';

/** Parses the SSM value; missing or unknown → {@link ConfigError} (aborts the Lambda init). */
export function parseSearchProviderKind(value: string | undefined): SearchProviderKind {
  if (value === undefined || value.trim() === '') {
    throw new ConfigError('CONFIG_MISSING', [SEARCH_PROVIDER_PARAMETER]);
  }
  const kind = value.trim();
  if (!(SEARCH_PROVIDER_KINDS as readonly string[]).includes(kind)) {
    throw new ConfigError(
      'CONFIG_INVALID',
      [SEARCH_PROVIDER_PARAMETER],
      [{ path: '', message: `expected one of ${SEARCH_PROVIDER_KINDS.join(', ')}` }],
    );
  }
  return kind as SearchProviderKind;
}

/** Lazy options so that only the selected backend's client is constructed. */
export interface SearchProviderDeps {
  dynamodb?: () => DynamoDbSearchProviderOptions;
  opensearch?: () => OpenSearchSearchProviderOptions;
}

/** Creates the provider selected by the SSM parameter `search-provider`. */
export function createSearchProvider(
  kind: SearchProviderKind,
  deps: SearchProviderDeps,
): SearchProvider {
  switch (kind) {
    case 'dynamodb':
      if (deps.dynamodb === undefined) throw new ConfigError('CONFIG_MISSING', ['dynamodb']);
      return new DynamoDbSearchProvider(deps.dynamodb());
    case 'opensearch':
      if (deps.opensearch === undefined) throw new ConfigError('CONFIG_MISSING', ['opensearch']);
      return new OpenSearchSearchProvider(deps.opensearch());
  }
}
