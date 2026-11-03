import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import type { OpenSearchClientLike } from './opensearch-search-provider';

export interface OpenSearchClientConfig {
  /** Collection endpoint, e.g. `https://<id>.<region>.aoss.amazonaws.com`. */
  node: string;
  region: string;
  /** `aoss` for OpenSearch Serverless (default), `es` for managed domains. */
  service?: 'aoss' | 'es';
}

/** SigV4-signed client; credentials from the default Node provider chain (Lambda role). */
export function createOpenSearchClient({
  node,
  region,
  service = 'aoss',
}: OpenSearchClientConfig): OpenSearchClientLike {
  return new Client({
    ...AwsSigv4Signer({ region, service, getCredentials: defaultProvider() }),
    node,
  });
}
