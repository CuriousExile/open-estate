// Feature: real-estate-platform, Property 1: Konjunktive Filterung entspricht dem Referenzmodell
// Feature: real-estate-platform, Property 5: Deterministische, totale Ordnung
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  DynamoDbSearchProvider,
  InMemorySearchProvider,
  LISTINGS_BY_ID_INDEX,
  LISTINGS_BY_ID_PK_ATTRIBUTE,
  toListingItem,
} from '@open-estate/core';
import type { Listing } from '@open-estate/shared';
import fc from 'fast-check';
import {
  allPages,
  arbAllowList,
  arbFilters,
  arbListings,
  BYTE_ORDER_EXAMPLE,
  referenceIds,
} from './provider-conformance';

/**
 * Integration test of the DynamoDB provider against DynamoDB Local (task 6.11). Runs only when
 * `DYNAMODB_ENDPOINT` is set (see CONTRIBUTING.md → Tests); otherwise the suite is skipped.
 *
 * For a generated listing set, allow-list and query (generators as in Property 1), all pages read
 * through `createSearchService` with the DynamoDB provider must equal the reference-filtered set
 * in `id ASC` byte order (Property 5), and the same sequence as the in-memory provider. Ids also
 * include non-ASCII characters so that byte order and UTF-16 order can diverge.
 *
 * **Validates: Requirements 1.1, 1.8**
 */

const ENDPOINT = process.env['DYNAMODB_ENDPOINT'];
const NUM_RUNS = 15;

// ---------------------------------------------------------------------------------------------
// DynamoDB Local harness
// ---------------------------------------------------------------------------------------------

/** Same key schema and `byId` GSI as the `Listings` table in the CDK DataStack. */
async function createListingsTable(client: DynamoDBClient, tableName: string): Promise<void> {
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: 'id', AttributeType: 'S' },
        { AttributeName: LISTINGS_BY_ID_PK_ATTRIBUTE, AttributeType: 'S' },
      ],
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [
        {
          IndexName: LISTINGS_BY_ID_INDEX,
          KeySchema: [
            { AttributeName: LISTINGS_BY_ID_PK_ATTRIBUTE, KeyType: 'HASH' },
            { AttributeName: 'id', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
}

async function dropTable(client: DynamoDBClient, tableName: string): Promise<void> {
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
  }
}

/** Writes items in the layout of the seed writer/indexer (`toListingItem`). */
async function writeListings(
  doc: DynamoDBDocumentClient,
  tableName: string,
  listings: readonly Listing[],
): Promise<void> {
  for (let i = 0; i < listings.length; i += 25) {
    let requests = listings
      .slice(i, i + 25)
      .map((l) => ({ PutRequest: { Item: toListingItem(l) } }));
    while (requests.length > 0) {
      const result = await doc.send(
        new BatchWriteCommand({ RequestItems: { [tableName]: requests } }),
      );
      requests = (result.UnprocessedItems?.[tableName] ?? []) as typeof requests;
    }
  }
}

// ---------------------------------------------------------------------------------------------

const describeWithDynamo = ENDPOINT !== undefined && ENDPOINT !== '' ? describe : describe.skip;
const suffix = ENDPOINT ? `(${ENDPOINT})` : '(skipped: set DYNAMODB_ENDPOINT to run)';

describeWithDynamo(`DynamoDbSearchProvider against DynamoDB Local ${suffix}`, () => {
  jest.setTimeout(120_000);

  const client = new DynamoDBClient({
    ...(ENDPOINT !== undefined && { endpoint: ENDPOINT }),
    region: 'eu-central-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const doc = DynamoDBDocumentClient.from(client);
  let run = 0;

  afterAll(() => client.destroy());

  it('all pages equal the reference model in id byte order and the in-memory provider', async () => {
    await fc.assert(
      fc.asyncProperty(arbListings, arbAllowList, arbFilters, async (listings, allowList, f) => {
        const tableName = `listings-it-${process.pid}-${run++}`;
        await createListingsTable(client, tableName);
        try {
          await writeListings(doc, tableName, listings);
          const dynamo = new DynamoDbSearchProvider({ client: doc, tableName });

          const ids = await allPages(dynamo, allowList, f);
          expect(ids).toEqual(referenceIds(listings, f, allowList));
          // Provider independence (Property 5): same sequence as the in-memory provider.
          expect(await allPages(new InMemorySearchProvider(listings), allowList, f)).toEqual(ids);
        } finally {
          await dropTable(client, tableName);
        }
      }),
      { numRuns: NUM_RUNS, examples: [BYTE_ORDER_EXAMPLE] },
    );
  });
});
