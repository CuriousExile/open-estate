import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DOWNSTREAM_DEADLINE_MS, toListingItem } from '@open-estate/core';
import { DEFAULT_TAXONOMY_CONFIG, type Listing } from '@open-estate/shared';
import { initListingsHandler, logger, type ListingsRequest } from '@open-estate/api';
import { exampleListing } from '../../shared/test/arbitraries';

// Full request path through `initListingsHandler` with the real read model (DynamoDB search
// provider, DynamoDB rate-limit counter, SSM access config) over SDK clients with stubbed `send`.
// Complements the handler tests (in-memory provider) and listings-lambda.test.ts (init, routing).

const REGION = 'eu-central-1';

const ENV = {
  CONFIG_BUCKET: 'config-bucket',
  DEFAULT_CURRENCY: 'EUR',
  SEARCH_PROVIDER: 'dynamodb',
  ACCESS_MODE_SSM_PARAMETER: '/oe/test/access-mode',
  RATE_LIMIT_SSM_PARAMETER: '/oe/test/rate-limit',
  LISTINGS_TABLE_NAME: 'listings',
  API_KEYS_TABLE_NAME: 'api-keys',
  RATE_LIMIT_COUNTERS_TABLE_NAME: 'rate-limit-counters',
};

const SSM_VALUES: Record<string, string> = {
  '/oe/test/access-mode': 'open',
  '/oe/test/rate-limit': '{"requests":1000,"windowSeconds":60}',
};

const FILES: Record<string, string> = {
  'taxonomy.json': JSON.stringify(DEFAULT_TAXONOMY_CONFIG),
  'i18n-config.json': JSON.stringify({
    defaultLocale: 'de',
    enabled: [
      { locale: 'de', label: 'Deutsch' },
      { locale: 'en', label: 'English' },
    ],
  }),
  'tour-providers.json': JSON.stringify({
    providers: [{ code: 'matterport', hostnames: ['my.matterport.com'] }],
  }),
};

const BOTH_OFFERS = exampleListing('home-1', {
  translations: [{ locale: 'en', title: 'Bright flat', description: 'A bright flat' }],
  offers: [
    { offerType: 'SALE', price: 450_000_00, currency: 'EUR' },
    { offerType: 'RENT', coldRent: 1_250_50, currency: 'EUR' },
  ],
});

const REQUEST: ListingsRequest = { requestContext: { identity: { sourceIp: '192.0.2.1' } } };

type Send = (command: object, options?: { abortSignal?: AbortSignal }) => Promise<unknown>;

/** Stored listings, one per Query page (`LastEvaluatedKey` = next page number). */
function tableSend(pages: readonly Listing[][]): Send {
  return async (command) => {
    if (command instanceof QueryCommand) {
      const index = Number(command.input.ExclusiveStartKey?.['page'] ?? 0);
      return {
        Items: (pages[index] ?? []).map((l) => toListingItem(l)),
        ...(index < pages.length - 1 && { LastEvaluatedKey: { page: index + 1 } }),
      };
    }
    if (command instanceof GetCommand) {
      const found = pages.flat().find((l) => l.id === command.input.Key?.['id']);
      return found ? { Item: toListingItem(found) } : {};
    }
    return {}; // UpdateCommand of the rate-limit counter: admitted
  };
}

/** Never answers on its own; rejects once the passed signal aborts (SDK behaviour). */
const hanging: Send = (_command, options) =>
  new Promise((_resolve, reject) => {
    options?.abortSignal?.addEventListener('abort', () => reject(new Error('Request aborted')));
  });

async function setup(listingTable: Send) {
  const ssm = new SSMClient({ region: REGION });
  const s3 = new S3Client({ region: REGION });
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  jest.spyOn(ssm, 'send').mockImplementation(async (command: unknown) => {
    if (!(command instanceof GetParametersCommand)) throw new Error('unexpected command');
    const names = command.input.Names ?? [];
    return {
      Parameters: names
        .filter((n) => SSM_VALUES[n] !== undefined)
        .map((n) => ({ Name: n, Value: SSM_VALUES[n] })),
    };
  });
  jest.spyOn(s3, 'send').mockImplementation(async (command: unknown) => {
    if (!(command instanceof GetObjectCommand)) throw new Error('unexpected command');
    const body = FILES[command.input.Key ?? ''];
    if (body === undefined) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    return { Body: { transformToString: async () => body } };
  });
  // The counter update always succeeds; listing reads go to `listingTable`.
  const send = jest
    .spyOn(dynamo, 'send')
    .mockImplementation(((command: object, options?: { abortSignal?: AbortSignal }) =>
      command instanceof QueryCommand || command instanceof GetCommand
        ? listingTable(command, options)
        : Promise.resolve({})) as never);

  const handler = await initListingsHandler(ENV, { ssm, s3, dynamo });
  const commands = () => send.mock.calls.map(([c]) => c.constructor.name);
  const writes = () =>
    send.mock.calls
      .map(([c]) => c as { constructor: { name: string }; input: { TableName?: string } })
      .filter((c) => !['QueryCommand', 'GetCommand'].includes(c.constructor.name))
      .map((c) => [c.constructor.name, c.input.TableName]);
  return { handler, commands, writes };
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const SERVICE_UNAVAILABLE_BODY = {
  errors: [{ code: 'SERVICE_UNAVAILABLE', message: expect.any(String) }],
};

describe('initListingsHandler: success per route', () => {
  it('GET /listings returns the matching listings in API representation', async () => {
    const { handler, commands } = await setup(tableSend([[BOTH_OFFERS]]));

    const res = await handler({ ...REQUEST, resource: '/listings' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { items: Record<string, unknown>[] };
    expect(body).not.toHaveProperty('nextPageToken');
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: 'home-1', area: '75.00', deliveredLocale: 'de' });
    expect(commands()).toEqual(['UpdateCommand', 'QueryCommand']);
  });

  it('GET /listings answers 200 with an empty list without nextPageToken (Req 1.12)', async () => {
    const { handler } = await setup(tableSend([[], []])); // index read to its end, no match

    const res = await handler({ ...REQUEST, resource: '/listings', queryStringParameters: {} });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"items":[]}');
  });

  it('GET /listings/{id} returns both offers of a SALE + RENT listing (Req 2.1)', async () => {
    const { handler, commands } = await setup(tableSend([[BOTH_OFFERS]]));

    const res = await handler({
      ...REQUEST,
      resource: '/listings/{id}',
      pathParameters: { id: 'home-1' },
      headers: { 'Accept-Language': 'en' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      id: 'home-1',
      title: 'Bright flat',
      deliveredLocale: 'en',
      originalLocale: 'de',
      offers: [
        { offerType: 'SALE', price: '450000.00', currency: 'EUR' },
        { offerType: 'RENT', coldRent: '1250.50', currency: 'EUR' },
      ],
    });
    expect(commands()).toEqual(['UpdateCommand', 'GetCommand']);
  });

  it('GET /openapi.json and GET /meta reflect the loaded configuration (Req 3.1, 15.9)', async () => {
    const { handler, commands } = await setup(tableSend([]));

    const openapi = await handler({ ...REQUEST, resource: '/openapi.json' });
    const meta = await handler({ ...REQUEST, resource: '/meta' });

    expect(openapi.statusCode).toBe(200);
    const doc = JSON.parse(openapi.body) as {
      openapi: string;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.components.schemas['EnabledLocale']).toMatchObject({ enum: ['de', 'en'] });
    expect(meta.statusCode).toBe(200);
    expect(JSON.parse(meta.body)).toMatchObject({
      taxonomy: {
        groups: DEFAULT_TAXONOMY_CONFIG.groups.map((g) => ({ code: g.code, types: g.types })),
      },
      locales: { defaultLocale: 'de' },
      defaultCurrency: 'EUR',
      offerTypes: ['SALE', 'RENT'],
      tourProviders: ['my.matterport.com'],
    });
    // Both go through the guard, neither reads listings.
    expect(commands()).toEqual(['UpdateCommand', 'UpdateCommand']);
  });
});

describe('initListingsHandler: downstream failure and deadline (Req 9.5, 9.6)', () => {
  /** `AbortSignal.timeout` on Jest's fake clock (Node's own timer is not faked). */
  function fakeAbortSignalTimeout() {
    jest.useFakeTimers();
    return jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), ms);
      return controller.signal;
    });
  }

  it.each([
    ['GET /listings', { resource: '/listings' }, 'QueryCommand'],
    [
      'GET /listings/{id}',
      { resource: '/listings/{id}', pathParameters: { id: 'x' } },
      'GetCommand',
    ],
  ])(
    '%s answers 503 once DOWNSTREAM_DEADLINE_MS elapses, writing nothing',
    async (_route, req, read) => {
      const timeout = fakeAbortSignalTimeout();
      const { handler, commands, writes } = await setup(hanging);

      let settled = false;
      const pending = handler({ ...REQUEST, ...req }).finally(() => (settled = true));
      await jest.advanceTimersByTimeAsync(DOWNSTREAM_DEADLINE_MS - 1);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      const res = await pending;

      expect(timeout).toHaveBeenCalledWith(DOWNSTREAM_DEADLINE_MS);
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toEqual(SERVICE_UNAVAILABLE_BODY);
      expect(commands()).toEqual(['UpdateCommand', read]);
      expect(writes()).toEqual([['UpdateCommand', 'rate-limit-counters']]);
    },
  );

  it('drops the pages read before the deadline instead of answering partially', async () => {
    fakeAbortSignalTimeout();
    const first = tableSend([[BOTH_OFFERS], []]);
    let queries = 0;
    const { handler, commands } = await setup((command, options) =>
      queries++ === 0 ? first(command, options) : hanging(command, options),
    );

    const pending = handler({ ...REQUEST, resource: '/listings' });
    await jest.advanceTimersByTimeAsync(DOWNSTREAM_DEADLINE_MS);
    const res = await pending;

    expect(commands()).toEqual(['UpdateCommand', 'QueryCommand', 'QueryCommand']);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual(SERVICE_UNAVAILABLE_BODY);
    expect(res.body).not.toContain('home-1');
  });

  it.each([
    ['GET /listings', { resource: '/listings' }],
    ['GET /listings/{id}', { resource: '/listings/{id}', pathParameters: { id: 'x' } }],
  ])('%s maps a DynamoDB error to 503 without details', async (_route, req) => {
    const failure = Object.assign(new Error('arn:aws:dynamodb secret'), {
      name: 'ProvisionedThroughputExceededException',
    });
    const { handler, writes } = await setup(() => Promise.reject(failure));
    const log = jest.spyOn(logger, 'error');

    const res = await handler({ ...REQUEST, ...req });

    expect(res.statusCode).toBe(503);
    expect(res.headers).toMatchObject({ 'Cache-Control': 'no-store' });
    expect(JSON.parse(res.body)).toEqual(SERVICE_UNAVAILABLE_BODY);
    expect(res.body).not.toContain('secret');
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('request failed'), {
      errorName: 'ServiceUnavailableError',
    });
    expect(writes()).toEqual([['UpdateCommand', 'rate-limit-counters']]);
  });
});
