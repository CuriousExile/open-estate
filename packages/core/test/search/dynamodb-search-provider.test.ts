import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  DEFAULT_PAGE_SIZE,
  DYNAMODB_REQUEST_DEADLINE_MS,
  DynamoDbSearchProvider,
  fromListingItem,
  LISTINGS_BY_ID_PK_ATTRIBUTE,
  LISTINGS_BY_ID_PK_VALUE,
  MAX_PAGE_SIZE,
  ServiceUnavailableError,
  toListingItem,
  toSearchDocument,
  type DynamoDbSearchProviderOptions,
} from '@open-estate/core';
import type { Listing } from '@open-estate/shared';
import { listing, listings, sortedIds } from './fixtures';

const TABLE = 'test-listings';

type Send = (command: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>;

/** Index pages as DynamoDB returns them after filtering (`LastEvaluatedKey` = page number). */
function queryPages(pages: Listing[][]): Send {
  return async (command) => {
    if (command instanceof QueryCommand) {
      const index = Number(command.input.ExclusiveStartKey?.['page'] ?? 0);
      const isLast = index >= pages.length - 1;
      return {
        Items: (pages[index] ?? []).map((l) => toListingItem(l)),
        ...(isLast ? {} : { LastEvaluatedKey: { page: index + 1 } }),
      };
    }
    if (command instanceof GetCommand) {
      const id = command.input.Key?.['id'] as string;
      const found = pages.flat().find((l) => l.id === id);
      return found ? { Item: toListingItem(found) } : {};
    }
    throw new Error('unexpected command');
  };
}

/** Document client whose `send` is stubbed; no AWS calls are made. */
function setup(impl: Send, options: Partial<DynamoDbSearchProviderOptions> = {}) {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
  const send = jest.spyOn(client, 'send').mockImplementation(impl as never);
  const provider = new DynamoDbSearchProvider({ client, tableName: TABLE, ...options });
  const inputs = () => send.mock.calls.map(([cmd]) => (cmd as QueryCommand).input);
  return { provider, send, inputs };
}

describe('toListingItem / fromListingItem', () => {
  it('stores listing, flat search document and byId key; round-trips to the listing', () => {
    const l = listing('a');
    const item = toListingItem(l);
    expect(item).toEqual({
      ...l,
      ...toSearchDocument(l),
      [LISTINGS_BY_ID_PK_ATTRIBUTE]: LISTINGS_BY_ID_PK_VALUE,
    });
    expect(item).toMatchObject(l);
    expect(fromListingItem({ ...item })).toEqual(l);
  });

  it('sets the sparse byId key only for ACTIVE listings and stores the agency (Req 6.3, 6.5)', () => {
    const l = listing('a');
    const inactive = toListingItem(l, { status: 'INACTIVE', agencyId: 'agency-1' });
    expect(inactive).not.toHaveProperty(LISTINGS_BY_ID_PK_ATTRIBUTE);
    expect(inactive).toEqual({ ...l, ...toSearchDocument(l, 'agency-1') });
    expect(toListingItem(l, { status: 'ACTIVE', agencyId: 'agency-1' })).toEqual({
      ...inactive,
      [LISTINGS_BY_ID_PK_ATTRIBUTE]: LISTINGS_BY_ID_PK_VALUE,
    });
    expect(fromListingItem({ ...inactive })).toEqual(l);
  });
});

describe('DynamoDbSearchProvider.search', () => {
  it('queries the byId GSI in id order without filter for an empty query', async () => {
    const { provider, inputs } = setup(queryPages([[]]));
    await expect(provider.search({})).resolves.toEqual({ items: [] });
    expect(inputs()).toEqual([
      {
        TableName: TABLE,
        IndexName: 'byId',
        KeyConditionExpression: '#gsiPk = :v0',
        ExpressionAttributeNames: { '#gsiPk': 'gsiPk' },
        ExpressionAttributeValues: { ':v0': 'L' },
        ScanIndexForward: true,
        ExclusiveStartKey: undefined,
      },
    ]);
  });

  it('builds KeyCondition with the after cursor and a FilterExpression from all conditions', async () => {
    const { provider, inputs } = setup(queryPages([[]]));
    await provider.search({
      offerType: 'RENT',
      price: { currency: 'EUR', min: 50000, max: 150000 },
      roomsHalf: { min: 4 },
      areaMinor: { max: 9000 },
      cityNorm: 'köln',
      postalCode: '50667',
      listingTypes: ['APARTMENT', 'LOFT'],
      tourHosts: ['my.matterport.com', 'kuula.co'],
      after: 'id-007',
    });
    const [input] = inputs();
    expect(input?.KeyConditionExpression).toBe('#gsiPk = :v0 AND #id > :v1');
    expect(input?.FilterExpression).toBe(
      'attribute_exists(#rentAmountMinor) AND #rentCurrency = :v2' +
        ' AND #rentAmountMinor >= :v3 AND #rentAmountMinor <= :v4' +
        ' AND #roomsHalf >= :v5 AND #areaMinor <= :v6' +
        ' AND #cityNorm = :v7 AND #postalCode = :v8' +
        ' AND #listingType IN (:v9, :v10)' +
        ' AND (contains(#tourHosts, :v11) OR contains(#tourHosts, :v12))',
    );
    expect(input?.ExpressionAttributeValues).toEqual({
      ':v0': 'L',
      ':v1': 'id-007',
      ':v2': 'EUR',
      ':v3': 50000,
      ':v4': 150000,
      ':v5': 4,
      ':v6': 9000,
      ':v7': 'köln',
      ':v8': '50667',
      ':v9': 'APARTMENT',
      ':v10': 'LOFT',
      ':v11': 'my.matterport.com',
      ':v12': 'kuula.co',
    });
    for (const [placeholder, name] of Object.entries(input?.ExpressionAttributeNames ?? {})) {
      expect(placeholder).toBe(`#${name}`);
    }
  });

  it('filters SALE offers on the sale fields; offer type without price only requires existence', async () => {
    const { provider, inputs } = setup(queryPages([[]]));
    await provider.search({ offerType: 'SALE' });
    await provider.search({ offerType: 'SALE', price: { currency: 'CHF', max: 1 } });
    expect(inputs().map((i) => i.FilterExpression)).toEqual([
      'attribute_exists(#saleAmountMinor)',
      'attribute_exists(#saleAmountMinor) AND #saleCurrency = :v1 AND #saleAmountMinor <= :v2',
    ]);
  });

  it('keeps reading DynamoDB pages until pageSize + 1 matches and reports next', async () => {
    const data = listings(10).reverse(); // ascending ids, as the GSI returns them
    const pages = [data.slice(0, 2), [], data.slice(2, 4), data.slice(4, 7), data.slice(7)];
    const { provider, inputs } = setup(queryPages(pages));

    const result = await provider.search({ pageSize: 3 });

    expect(result.items.map((l) => l.id)).toEqual(sortedIds(data).slice(0, 3));
    expect(result.next).toEqual({ lastId: data[2]?.id });
    // 2 + 0 + 2 = 4 = pageSize + 1 → stops after the third request.
    expect(inputs().map((i) => i.ExclusiveStartKey)).toEqual([undefined, { page: 1 }, { page: 2 }]);
  });

  it('reports no next when the index ends without a lookahead match', async () => {
    const data = listings(3).reverse();
    const { provider } = setup(queryPages([data.slice(0, 1), data.slice(1)]));
    await expect(provider.search({ pageSize: 3 })).resolves.toEqual({ items: data });
  });

  it('applies the default page size and caps pageSize at 50', async () => {
    const data = listings(60).reverse();
    const r1 = await setup(queryPages([data])).provider.search({});
    expect(r1.items).toHaveLength(DEFAULT_PAGE_SIZE);
    const r2 = await setup(queryPages([data])).provider.search({ pageSize: 99 });
    expect(r2.items).toHaveLength(MAX_PAGE_SIZE);
    expect(r2.next).toEqual({ lastId: data[MAX_PAGE_SIZE - 1]?.id });
  });

  it('returns stored items as listings without search fields or gsiPk', async () => {
    const { provider } = setup(queryPages([[listing('a')]]));
    const { items } = await provider.search({});
    expect(items).toEqual([listing('a')]);
    expect(items[0]).not.toHaveProperty('cityNorm');
    expect(items[0]).not.toHaveProperty(LISTINGS_BY_ID_PK_ATTRIBUTE);
  });

  it('matches nothing for empty listingTypes or tourHosts without querying', async () => {
    const { provider, send } = setup(queryPages([[listing('a')]]));
    await expect(provider.search({ listingTypes: [] })).resolves.toEqual({ items: [] });
    await expect(provider.search({ tourHosts: [] })).resolves.toEqual({ items: [] });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('DynamoDbSearchProvider.getById', () => {
  it('issues a GetCommand, strips search fields and maps a missing item to null', async () => {
    const { provider, send } = setup(queryPages([[listing('a')]]));
    await expect(provider.getById('a')).resolves.toEqual(listing('a'));
    await expect(provider.getById('missing')).resolves.toBeNull();
    expect((send.mock.calls[0]?.[0] as GetCommand).input).toEqual({
      TableName: TABLE,
      Key: { id: 'a' },
    });
  });
});

describe('DynamoDbSearchProvider deadline and errors', () => {
  /** `send` that never resolves on its own and rejects once the passed signal aborts (SDK behaviour). */
  const hanging: Send = (_command, options) =>
    new Promise((_resolve, reject) => {
      options?.abortSignal?.addEventListener('abort', () => reject(new Error('Request aborted')));
    });

  it('passes one 4.5 s deadline signal to every request of a search', async () => {
    const controller = new AbortController();
    const deadlineSignal = jest.fn(() => controller.signal);
    const data = listings(4).reverse();
    const { provider, send } = setup(queryPages([data.slice(0, 2), data.slice(2)]), {
      deadlineSignal,
    });
    await provider.search({ pageSize: 3 });
    expect(deadlineSignal).toHaveBeenCalledTimes(1);
    expect(deadlineSignal).toHaveBeenCalledWith(DYNAMODB_REQUEST_DEADLINE_MS);
    expect(send.mock.calls.map(([, opts]) => opts)).toEqual([
      { abortSignal: controller.signal },
      { abortSignal: controller.signal },
    ]);
  });

  it.each([
    ['search', (p: DynamoDbSearchProvider) => p.search({})],
    ['getById', (p: DynamoDbSearchProvider) => p.getById('a')],
  ])('%s: deadline exceeded → SERVICE_UNAVAILABLE', async (_name, call) => {
    const controller = new AbortController();
    const { provider } = setup(hanging, { deadlineSignal: () => controller.signal });
    const pending = call(provider);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(pending).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('aborts between pages without a partial result once the deadline has passed', async () => {
    const controller = new AbortController();
    const first = queryPages([[listing('a')], [listing('b')]]);
    const { provider, send } = setup(
      async (cmd, opts) => {
        const page = await first(cmd, opts);
        controller.abort(); // deadline passes while the first page is in flight; stub ignores it
        return page;
      },
      { deadlineSignal: () => controller.signal },
    );
    await expect(provider.search({})).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['search', (p: DynamoDbSearchProvider) => p.search({})],
    ['getById', (p: DynamoDbSearchProvider) => p.getById('a')],
  ])('%s: downstream error → SERVICE_UNAVAILABLE with cause', async (_name, call) => {
    const failure = Object.assign(new Error('boom'), { name: 'ProvisionedThroughputExceeded' });
    const { provider } = setup(() => Promise.reject(failure));
    const error = await call(provider).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', cause: failure });
  });
});
