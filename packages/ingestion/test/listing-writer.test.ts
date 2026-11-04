import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { toListingItem } from '@open-estate/core';
import {
  createRunLogger,
  DELETION_BLOCK_REASON,
  DELETION_BLOCKLIST_KEY_ATTRIBUTE,
  DeletionBlockedError,
  DynamoDbDeletionBlocklist,
  DynamoDbListingWriter,
  ImportPipeline,
  InMemoryDeletionBlocklist,
  InMemoryListingWriter,
  type ListingWriter,
} from '@open-estate/ingestion';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  TourProvidersConfig,
  type Listing,
} from '@open-estate/shared';

const LISTINGS = 'Listings';
const BLOCKLIST = 'DeletionBlocklist';

const listingSchema = buildSchemas(assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG), {
  defaultLocale: 'de',
  enabled: [{ locale: 'de', label: 'Deutsch' }],
}).listing;

const tourProviders = TourProvidersConfig.parse({
  providers: [{ code: 'matterport', hostnames: ['my.matterport.com'] }],
});

function rawListing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'L-1',
    originalLocale: 'de',
    title: 'Helle Wohnung',
    description: 'Mit Balkon',
    translations: [],
    offers: [{ offerType: 'SALE', price: '350000', currency: 'EUR' }],
    listingType: 'loft',
    rooms: 2.5,
    area: '72.50',
    address: { city: 'Berlin', postalCode: '10115', country: 'DE' },
    sourceUrl: 'https://partner.example/listings/1',
    media: [{ url: 'https://img.example/1.jpg' }, { url: 'https://img.example/2.jpg' }],
    tours: [{ url: 'https://my.matterport.com/show/?m=abc' }],
    ...overrides,
  };
}

function listing(overrides: Record<string, unknown> = {}): Listing {
  return listingSchema.parse({
    ...rawListing(overrides),
    tours: (overrides['tours'] as unknown[] | undefined) ?? [
      { url: 'https://my.matterport.com/show/?m=abc', providerCode: 'matterport' },
    ],
    source: 'partner-db',
    lastImportedAt: '2026-11-05T10:00:00.000Z',
    lastRunId: 'run-1',
  });
}

const canceled = (...codes: string[]) =>
  new TransactionCanceledException({
    message: 'Transaction cancelled',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

function setupWriter(...results: (Error | undefined)[]) {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
  const send = jest.spyOn(client, 'send').mockImplementation(async () => {
    const result = results.shift();
    if (result !== undefined) throw result;
    return {};
  });
  const writer = new DynamoDbListingWriter({
    client,
    listingsTable: LISTINGS,
    blocklistTable: BLOCKLIST,
  });
  const inputs = () => send.mock.calls.map(([command]) => (command as TransactWriteCommand).input);
  return { writer, send, inputs };
}

const blocklistCheck = {
  ConditionCheck: {
    TableName: BLOCKLIST,
    Key: { listingId: 'L-1' },
    ConditionExpression: 'attribute_not_exists(#key)',
    ExpressionAttributeNames: { '#key': 'listingId' },
  },
};

describe('DynamoDbListingWriter', () => {
  it('creates a new listing in one transaction with the blocklist check ⇒ imported', async () => {
    const t = setupWriter();
    const item = listing();

    expect(await t.writer.write(item)).toBe('imported');
    expect(t.send.mock.calls[0]?.[0]).toBeInstanceOf(TransactWriteCommand);
    expect(t.inputs()).toEqual([
      {
        TransactItems: [
          {
            Put: {
              TableName: LISTINGS,
              Item: toListingItem(item),
              ConditionExpression: 'attribute_not_exists(#id)',
              ExpressionAttributeNames: { '#id': 'id' },
            },
          },
          blocklistCheck,
        ],
      },
    ]);
    expect(t.inputs()[0]?.TransactItems?.[0]?.Put?.Item).toMatchObject({
      cityNorm: 'berlin',
      saleAmountMinor: 35000000,
      tourHosts: ['my.matterport.com'],
      gsiPk: 'L',
    });
  });

  it('replaces an existing listing without create condition ⇒ updated', async () => {
    const t = setupWriter(canceled('ConditionalCheckFailed', 'None'));
    const item = listing({ media: [], tours: [] });

    expect(await t.writer.write(item)).toBe('updated');
    expect(t.inputs()).toHaveLength(2);
    expect(t.inputs()[1]).toEqual({
      TransactItems: [{ Put: { TableName: LISTINGS, Item: toListingItem(item) } }, blocklistCheck],
    });
    // Full replacement: the put item carries the (empty) new media/tours, nothing is merged.
    expect(t.inputs()[1]?.TransactItems?.[0]?.Put?.Item).toMatchObject({ media: [], tours: [] });
  });

  it.each([
    ['first transaction', [canceled('None', 'ConditionalCheckFailed')], 1],
    ['both conditions failing', [canceled('ConditionalCheckFailed', 'ConditionalCheckFailed')], 1],
    [
      'second transaction',
      [canceled('ConditionalCheckFailed', 'None'), canceled('None', 'ConditionalCheckFailed')],
      2,
    ],
  ])(
    'throws DeletionBlockedError when the blocklist check fails (%s)',
    async (_, errors, calls) => {
      const t = setupWriter(...errors);

      const write = t.writer.write(listing());
      await expect(write).rejects.toBeInstanceOf(DeletionBlockedError);
      await expect(write).rejects.toMatchObject({ listingId: 'L-1' });
      expect(t.send).toHaveBeenCalledTimes(calls);
    },
  );

  it.each([
    ['a conflict in the first transaction', [canceled('TransactionConflict', 'None')], 1],
    [
      'a conflict in the second transaction',
      [canceled('ConditionalCheckFailed', 'None'), canceled('TransactionConflict', 'None')],
      2,
    ],
    ['a non-transaction error', [new Error('network down')], 1],
  ])('rethrows %s', async (_, errors, calls) => {
    const t = setupWriter(...errors);
    const expected = errors[errors.length - 1];

    await expect(t.writer.write(listing())).rejects.toBe(expected);
    expect(t.send).toHaveBeenCalledTimes(calls);
  });
});

describe('DynamoDbDeletionBlocklist', () => {
  function setup(response: Record<string, unknown>) {
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
    const send = jest.spyOn(client, 'send').mockImplementation(async () => response);
    return { blocklist: new DynamoDbDeletionBlocklist({ client, tableName: BLOCKLIST }), send };
  }

  it('looks the id up with a consistent read', async () => {
    const t = setup({ Item: { listingId: 'L-1' } });

    expect(await t.blocklist.has('L-1')).toBe(true);
    const command = t.send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetCommand);
    expect((command as GetCommand).input).toEqual({
      TableName: BLOCKLIST,
      Key: { listingId: 'L-1' },
      ProjectionExpression: '#key',
      ExpressionAttributeNames: { '#key': 'listingId' },
      ConsistentRead: true,
    });
    expect(DELETION_BLOCKLIST_KEY_ATTRIBUTE).toBe('listingId');
  });

  it('returns false when no item exists', async () => {
    expect(await setup({}).blocklist.has('L-1')).toBe(false);
  });

  it('propagates read errors', async () => {
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
    const error = new ConditionalCheckFailedException({ message: 'x', $metadata: {} });
    jest.spyOn(client, 'send').mockImplementation(async () => {
      throw error;
    });
    const blocklist = new DynamoDbDeletionBlocklist({ client, tableName: BLOCKLIST });
    await expect(blocklist.has('L-1')).rejects.toBe(error);
  });
});

describe('InMemoryListingWriter', () => {
  it('replaces the stored listing completely, old media and tours disappear', async () => {
    const writer = new InMemoryListingWriter();

    expect(await writer.write(listing())).toBe('imported');
    expect(await writer.write(listing({ title: 'Neu', media: [], tours: [] }))).toBe('updated');
    expect(writer.get('L-1')).toEqual(listing({ title: 'Neu', media: [], tours: [] }));
    expect(writer.size).toBe(1);
  });

  it('throws DeletionBlockedError for an id on the shared blocklist and stores nothing', async () => {
    const blocklist = new InMemoryDeletionBlocklist(['L-1']);
    const writer = new InMemoryListingWriter(blocklist);

    await expect(writer.write(listing())).rejects.toBeInstanceOf(DeletionBlockedError);
    expect(writer.size).toBe(0);
  });
});

describe('ImportPipeline with a write-time deletion block', () => {
  function setup(writer: ListingWriter) {
    const lines: string[] = [];
    const logger = createRunLogger({
      runId: 'run-1',
      source: 'partner-db',
      sink: (l) => lines.push(l),
    });
    const pipeline = new ImportPipeline({
      listingSchema,
      // Pre-check passes: the id is blocked only between pre-check and write.
      blocklist: new InMemoryDeletionBlocklist(),
      writer,
      tourProviders,
    });
    const process = () =>
      pipeline.process(rawListing(), { runId: 'run-1', source: 'partner-db', logger });
    const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    return { process, entries };
  }

  it('records the record as rejected with reason „Löschsperre“', async () => {
    const t = setup(setupWriter(canceled('None', 'ConditionalCheckFailed')).writer);

    expect(await t.process()).toBe('rejected');
    expect(t.entries()).toContainEqual(
      expect.objectContaining({
        event: 'record.rejected',
        listingId: 'L-1',
        source: 'partner-db',
        issues: [{ field: 'id', reason: DELETION_BLOCK_REASON }],
      }),
    );
  });

  it('rethrows other writer errors', async () => {
    const error = new Error('network down');
    const t = setup(setupWriter(error).writer);

    await expect(t.process()).rejects.toBe(error);
  });
});
