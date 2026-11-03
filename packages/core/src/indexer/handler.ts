import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from 'aws-lambda';
import { createOpenSearchClient } from '../search/opensearch-client';
import { toOpenSearchDocument } from '../search/opensearch-search-provider';
import { readIndexerConfig } from './indexer-config';
import { OpenSearchIndexWriter, type OpenSearchIndexClientLike } from './opensearch-index-writer';
import { indexStreamBatch, type IndexerLogEntry } from './stream-indexer';

// Lambda entry of the stream indexer (stream on `Listings`, NEW_AND_OLD_IMAGES, with
// `ReportBatchItemFailures`). Configuration is read at module load: a missing value aborts the
// init with a ConfigError naming it. Not re-exported from the package index (side effects).

const config = readIndexerConfig(process.env);
// `createOpenSearchClient` returns the SDK client typed for search only; the writer needs its
// bulk and indices APIs.
const client = createOpenSearchClient({
  node: config.endpoint,
  region: config.region,
}) as unknown as OpenSearchIndexClientLike;
const writer = new OpenSearchIndexWriter(client, config.index);
const log = (entry: IndexerLogEntry): void => console.log(JSON.stringify(entry));

export function handler(event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> {
  return indexStreamBatch(event, { writer, toDocument: toOpenSearchDocument, log });
}
