// Feature: real-estate-platform, Property 1: Konjunktive Filterung entspricht dem Referenzmodell
// Feature: real-estate-platform, Property 5: Deterministische, totale Ordnung
import type { AttributeValue as SdkAttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import {
  InMemorySearchProvider,
  OPENSEARCH_INDEX_MAPPING,
  OpenSearchIndexWriter,
  OpenSearchSearchProvider,
  toListingItem,
  toOpenSearchDocument,
  type OpenSearchClientLike,
  type OpenSearchDocument,
  type OpenSearchIndexClientLike,
} from '@open-estate/core';
import type { Listing, TourProvidersConfig } from '@open-estate/shared';
import { Client } from '@opensearch-project/opensearch';
import type {
  AttributeValue,
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from 'aws-lambda';
import fc from 'fast-check';
import { exampleListing } from '../../../shared/test/arbitraries';
import {
  allPages,
  arbAllowList,
  arbFilterListing,
  arbFilters,
  arbListings,
  BYTE_ORDER_EXAMPLE,
  noFilters,
  referenceIds,
  type Filters,
} from './provider-conformance';

/**
 * Conformance test of the OpenSearch provider and the stream indexer against a real OpenSearch
 * (task 18.3). Runs only when `OPENSEARCH_ENDPOINT` is set (see CONTRIBUTING.md → Tests);
 * otherwise the suite is skipped.
 *
 * Provider: for a generated listing set, allow-list and query (generators as in Property 1), all
 * pages read through `createSearchService` must equal the reference-filtered set in `id ASC`
 * byte order (Property 5) and the in-memory provider's sequence. Each run gets its own index,
 * created with `OPENSEARCH_INDEX_MAPPING`.
 *
 * Indexer: synthetic DynamoDB stream batches (INSERT/MODIFY/REMOVE, NEW_AND_OLD_IMAGES images
 * built with `toListingItem` + `marshall`) go through the Lambda `handler`; afterwards the index
 * must hold exactly the model state and search must reflect upserts and deletions.
 *
 * **Validates: Requirements 1.1, 1.8, 18.5**
 */

const ENDPOINT = process.env['OPENSEARCH_ENDPOINT'];
const NUM_RUNS = 10;

// ---------------------------------------------------------------------------------------------
// OpenSearch harness
// ---------------------------------------------------------------------------------------------

/** Unsigned client for the local container (security plugin disabled). */
const client = new Client({ node: ENDPOINT ?? 'http://localhost:9200' });
const searchClient = client as unknown as OpenSearchClientLike;

async function createIndex(index: string): Promise<void> {
  await client.indices.create({ index, body: { mappings: OPENSEARCH_INDEX_MAPPING } as never });
}

async function dropIndex(index: string): Promise<void> {
  await client.indices.delete({ index, ignore_unavailable: true });
}

const refresh = (index: string) => client.indices.refresh({ index });

const provider = (index: string) => new OpenSearchSearchProvider({ client: searchClient, index });

// ---------------------------------------------------------------------------------------------
// Synthetic stream records (layout of a `Listings` stream with NEW_AND_OLD_IMAGES)
// ---------------------------------------------------------------------------------------------

let seq = 0;

function image(listing: Listing): Record<string, AttributeValue> {
  return marshall(toListingItem(listing), { removeUndefinedValues: true }) as Record<
    string,
    SdkAttributeValue
  > as Record<string, AttributeValue>;
}

function streamRecord(
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE',
  id: string,
  images: { newImage?: Listing | undefined; oldImage?: Listing | undefined },
): DynamoDBRecord {
  seq += 1;
  return {
    eventName,
    eventSource: 'aws:dynamodb',
    dynamodb: {
      Keys: { id: { S: id } },
      SequenceNumber: String(seq).padStart(21, '0'),
      StreamViewType: 'NEW_AND_OLD_IMAGES',
      ...(images.newImage ? { NewImage: image(images.newImage) } : {}),
      ...(images.oldImage ? { OldImage: image(images.oldImage) } : {}),
    },
  };
}

/** Applies one write to the model and returns the stream record DynamoDB would emit. */
function put(model: Map<string, Listing>, listing: Listing): DynamoDBRecord {
  const old = model.get(listing.id);
  model.set(listing.id, listing);
  return streamRecord(old ? 'MODIFY' : 'INSERT', listing.id, { newImage: listing, oldImage: old });
}

function remove(model: Map<string, Listing>, id: string): DynamoDBRecord {
  const old = model.get(id);
  model.delete(id);
  return streamRecord('REMOVE', id, { oldImage: old });
}

/** Index content and search agree with the model (ids, documents, absent ids). */
async function expectMirrors(
  index: string,
  model: ReadonlyMap<string, Listing>,
  probeIds: readonly string[],
): Promise<void> {
  const os = provider(index);
  const all = noFilters(7);
  const noTours: TourProvidersConfig = { providers: [] };
  expect(await allPages(os, noTours, all)).toEqual(referenceIds([...model.values()], all, noTours));
  for (const id of probeIds) {
    expect(await os.getById(id)).toEqual(model.get(id) ?? null);
  }
}

// ---------------------------------------------------------------------------------------------

const describeWithOpenSearch = ENDPOINT !== undefined && ENDPOINT !== '' ? describe : describe.skip;
const suffix = ENDPOINT ? `(${ENDPOINT})` : '(skipped: set OPENSEARCH_ENDPOINT to run)';

describeWithOpenSearch(`OpenSearch provider and indexer against OpenSearch ${suffix}`, () => {
  jest.setTimeout(180_000);

  afterAll(() => client.close());

  describe('OpenSearchSearchProvider', () => {
    let run = 0;

    it('all pages equal the reference model in id byte order and the in-memory provider', async () => {
      await fc.assert(
        fc.asyncProperty(arbListings, arbAllowList, arbFilters, async (listings, allowList, f) => {
          const index = `listings-it-${process.pid}-${run++}`;
          await createIndex(index);
          try {
            const writer = new OpenSearchIndexWriter<OpenSearchDocument>(
              client as unknown as OpenSearchIndexClientLike,
              index,
            );
            expect(await writer.upsert(listings.map((l) => toOpenSearchDocument(l)))).toEqual([]);
            await refresh(index);
            const os = provider(index);

            const ids = await allPages(os, allowList, f);
            expect(ids).toEqual(referenceIds(listings, f, allowList));
            // Provider independence (Property 5): same sequence as the in-memory provider.
            expect(await allPages(new InMemorySearchProvider(listings), allowList, f)).toEqual(ids);
            for (const l of listings) expect(await os.getById(l.id)).toEqual(l);
          } finally {
            await dropIndex(index);
          }
        }),
        { numRuns: NUM_RUNS, examples: [BYTE_ORDER_EXAMPLE] },
      );
    });
  });

  describe('indexer handler (DynamoDB Streams → OpenSearch)', () => {
    const index = `listings-indexer-it-${process.pid}`;
    const savedEnv = { ...process.env };
    type Handler = (event: DynamoDBStreamEvent) => Promise<DynamoDBBatchResponse>;
    let handler: Handler;
    let logSpy: jest.SpyInstance;

    const apply = async (...records: DynamoDBRecord[]): Promise<void> => {
      expect(await handler({ Records: records })).toEqual({ batchItemFailures: [] });
      await refresh(index);
    };

    beforeAll(async () => {
      // The handler reads its configuration and builds its (SigV4) client at module load. The
      // local container has no security plugin, so it ignores the signature; static dummy
      // credentials keep the default provider chain away from real profiles.
      Object.assign(process.env, {
        OPENSEARCH_ENDPOINT: ENDPOINT,
        OPENSEARCH_INDEX: index,
        AWS_REGION: 'eu-central-1',
        AWS_ACCESS_KEY_ID: 'local',
        AWS_SECRET_ACCESS_KEY: 'local',
      });
      delete process.env['AWS_SESSION_TOKEN'];
      delete process.env['AWS_PROFILE'];
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      await dropIndex(index);
      ({ handler } = jest.requireActual<{ handler: Handler }>('../../src/indexer/handler'));
    });

    afterAll(async () => {
      logSpy.mockRestore();
      process.env = savedEnv;
      await dropIndex(index);
    });

    /** Keeps the index (and the handler's created-index cache); only clears the documents. */
    const clearIndex = async (): Promise<void> => {
      if ((await client.indices.exists({ index })).body !== true) return;
      await client.deleteByQuery({ index, body: { query: { match_all: {} } }, refresh: true });
    };

    beforeEach(clearIndex);

    it('creates the index with the mapping and mirrors insert, update and removal', async () => {
      const model = new Map<string, Listing>();
      const berlin = exampleListing('\u{1F600}', {
        address: { city: 'Berlin', postalCode: '10115', country: 'DE' },
      });
      const other = exampleListing('\uFF01');
      const byCity = (city: string): Filters => ({ ...noFilters(10), city });
      const noTours: TourProvidersConfig = { providers: [] };

      await apply(put(model, berlin), put(model, other));
      const mapping = await client.indices.getMapping({ index });
      expect(mapping.body[index]?.mappings).toMatchObject({ dynamic: 'strict' });
      await expectMirrors(index, model, [berlin.id, other.id]);
      expect(await allPages(provider(index), noTours, byCity('berlin'))).toEqual([
        other.id,
        berlin.id,
      ]);

      // MODIFY: the new image fully replaces the document; search follows the new city.
      const moved = {
        ...berlin,
        address: { ...berlin.address, city: 'Köln', postalCode: '50667' },
      };
      await apply(put(model, moved));
      await expectMirrors(index, model, [berlin.id]);
      expect(await allPages(provider(index), noTours, byCity('berlin'))).toEqual([other.id]);
      expect(await allPages(provider(index), noTours, byCity('KÖLN'))).toEqual([berlin.id]);

      // REMOVE: gone from search and lookup; removing it again is idempotent.
      await apply(remove(model, berlin.id));
      await apply(remove(model, berlin.id));
      await expectMirrors(index, model, [berlin.id, other.id]);
      expect(await allPages(provider(index), noTours, byCity('Köln'))).toEqual([]);
    });

    const arbOp = fc.record({
      remove: fc.boolean(),
      slot: fc.nat(),
      replacement: arbFilterListing,
    });
    const arbBatches = fc.array(fc.array(arbOp, { minLength: 1, maxLength: 6 }), {
      minLength: 1,
      maxLength: 4,
    });

    it('after any sequence of stream batches the index equals the model and search agrees', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbListings.filter((pool) => pool.length > 0),
          arbBatches,
          arbAllowList,
          arbFilters,
          async (pool, batches, allowList, f) => {
            await clearIndex();
            const model = new Map<string, Listing>();
            const poolIds = pool.map((l) => l.id);
            await apply(...pool.map((l) => put(model, l)));
            for (const batch of batches) {
              const records = batch.map(({ remove: isRemove, slot, replacement }) => {
                const id = poolIds[slot % poolIds.length] as string;
                return isRemove ? remove(model, id) : put(model, { ...replacement, id });
              });
              await apply(...records);
              await expectMirrors(index, model, poolIds);
            }
            const state = [...model.values()];
            const ids = await allPages(provider(index), allowList, f);
            expect(ids).toEqual(referenceIds(state, f, allowList));
            expect(await allPages(new InMemorySearchProvider(state), allowList, f)).toEqual(ids);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
