import { OPENSEARCH_INDEX_MAPPING } from '../search/opensearch-search-provider';
import type { IndexDocument, IndexWriteFailure, SearchIndexWriter } from './search-index-writer';

// Bulk implementation of the indexer port against OpenSearch (Serverless). Mapping and document
// layout come from the provider (Task 18.1) as the single source.

type BulkAction =
  { index: { _index: string; _id: string } } | { delete: { _index: string; _id: string } };

interface BulkItemResult {
  _id?: string;
  status?: number;
  error?: { type?: string };
}

/** The part of `@opensearch-project/opensearch` `Client` the writer uses. */
export interface OpenSearchIndexClientLike {
  bulk(params: { body: unknown[] }): Promise<{ body: unknown }>;
  indices: {
    exists(params: { index: string }): Promise<{ body: unknown }>;
    create(params: { index: string; body: Record<string, unknown> }): Promise<unknown>;
  };
}

/** Error category of a whole failed `indices.create`; a concurrent create is not an error. */
function isAlreadyExists(error: unknown): boolean {
  const type = (error as { body?: { error?: { type?: unknown } } } | undefined)?.body?.error?.type;
  return type === 'resource_already_exists_exception';
}

export class OpenSearchIndexWriter<D extends IndexDocument> implements SearchIndexWriter<D> {
  private ready: Promise<void> | undefined;

  constructor(
    private readonly client: OpenSearchIndexClientLike,
    private readonly index: string,
  ) {}

  async upsert(docs: readonly D[]): Promise<readonly IndexWriteFailure[]> {
    return this.bulk(
      docs.map((doc) => doc.id),
      docs.flatMap((doc) => [{ index: { _index: this.index, _id: doc.id } } as BulkAction, doc]),
    );
  }

  async delete(ids: readonly string[]): Promise<readonly IndexWriteFailure[]> {
    return this.bulk(
      ids,
      ids.map((id): BulkAction => ({ delete: { _index: this.index, _id: id } })),
    );
  }

  /** Creates the index with the provider's mapping once per container; retried after failure. */
  private ensureIndex(): Promise<void> {
    this.ready ??= (async () => {
      const { body: exists } = await this.client.indices.exists({ index: this.index });
      if (exists === true) return;
      try {
        await this.client.indices.create({
          index: this.index,
          body: { mappings: OPENSEARCH_INDEX_MAPPING },
        });
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    })().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private async bulk(ids: readonly string[], body: unknown[]): Promise<IndexWriteFailure[]> {
    if (ids.length === 0) return [];
    await this.ensureIndex();
    const response = await this.client.bulk({ body });
    const items = (response.body as { items?: unknown } | undefined)?.items;
    if (!Array.isArray(items) || items.length !== ids.length) {
      return ids.map((id) => ({ id, errorType: 'MALFORMED_BULK_RESPONSE' }));
    }
    return items.flatMap((entry: Record<string, BulkItemResult>, i) => {
      const result = Object.values(entry)[0];
      const status = result?.status ?? 0;
      // 404 on delete: document already absent — the desired end state (idempotent).
      if ((status >= 200 && status < 300) || ('delete' in entry && status === 404)) return [];
      return [{ id: ids[i] as string, errorType: result?.error?.type ?? `HTTP_${status}` }];
    });
  }
}
