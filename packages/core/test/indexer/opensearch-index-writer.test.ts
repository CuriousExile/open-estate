import {
  OpenSearchIndexWriter,
  type OpenSearchIndexClientLike,
} from '../../src/indexer/opensearch-index-writer';
import { OPENSEARCH_INDEX_MAPPING } from '../../src/search/opensearch-search-provider';

function fakeClient(items: unknown[], exists = true) {
  const calls = { bulk: [] as unknown[][], create: [] as unknown[] };
  const client: OpenSearchIndexClientLike = {
    bulk: async ({ body }) => {
      calls.bulk.push(body);
      return { body: { errors: true, items } };
    },
    indices: {
      exists: async () => ({ body: exists }),
      create: async (params) => {
        calls.create.push(params);
        return {};
      },
    },
  };
  return { client, calls };
}

describe('OpenSearchIndexWriter', () => {
  it('indexes with _id = id and reports per-item errors by type only', async () => {
    const { client, calls } = fakeClient([
      { index: { _id: 'a', status: 201 } },
      { index: { _id: 'b', status: 400, error: { type: 'mapper_parsing_exception' } } },
    ]);
    const writer = new OpenSearchIndexWriter(client, 'listings');

    const failures = await writer.upsert([{ id: 'a' }, { id: 'b' }]);

    expect(calls.bulk[0]).toEqual([
      { index: { _index: 'listings', _id: 'a' } },
      { id: 'a' },
      { index: { _index: 'listings', _id: 'b' } },
      { id: 'b' },
    ]);
    expect(failures).toEqual([{ id: 'b', errorType: 'mapper_parsing_exception' }]);
  });

  it('treats 404 on delete as success (idempotent)', async () => {
    const { client, calls } = fakeClient([
      { delete: { _id: 'a', status: 404, result: 'not_found' } },
      { delete: { _id: 'b', status: 429 } },
    ]);
    const writer = new OpenSearchIndexWriter(client, 'listings');

    await expect(writer.delete(['a', 'b'])).resolves.toEqual([{ id: 'b', errorType: 'HTTP_429' }]);
    expect(calls.bulk[0]).toEqual([
      { delete: { _index: 'listings', _id: 'a' } },
      { delete: { _index: 'listings', _id: 'b' } },
    ]);
  });

  it('creates a missing index once with the provider mapping', async () => {
    const { client, calls } = fakeClient([{ delete: { _id: 'a', status: 200 } }], false);
    const writer = new OpenSearchIndexWriter(client, 'listings');

    await writer.delete(['a']);
    await writer.delete(['a']);

    expect(calls.create).toEqual([
      { index: 'listings', body: { mappings: OPENSEARCH_INDEX_MAPPING } },
    ]);
  });

  it('fails every document on a malformed bulk response', async () => {
    const { client } = fakeClient([]);
    const writer = new OpenSearchIndexWriter(client, 'listings');

    await expect(writer.delete(['a'])).resolves.toEqual([
      { id: 'a', errorType: 'MALFORMED_BULK_RESPONSE' },
    ]);
  });
});
