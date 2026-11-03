// Narrow write port of the stream indexer (Task 18.2). The OpenSearch Bulk implementation lives
// in `opensearch-index-writer.ts`; tests use an in-memory fake.

/** Anything the index can store: the document id becomes the index `_id`. */
export interface IndexDocument {
  readonly id: string;
}

/** One document that could not be written. `errorType` is a category, never document content. */
export interface IndexWriteFailure {
  readonly id: string;
  readonly errorType: string;
}

export interface SearchIndexWriter<D extends IndexDocument = IndexDocument> {
  /** Creates or fully replaces each document under `_id = doc.id`; returns the failed ones. */
  upsert(docs: readonly D[]): Promise<readonly IndexWriteFailure[]>;
  /** Deletes the documents; an id that is already absent counts as success (idempotent). */
  delete(ids: readonly string[]): Promise<readonly IndexWriteFailure[]>;
}
