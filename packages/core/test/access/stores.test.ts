import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  ConfigError,
  DEFAULT_RATE_LIMIT,
  DynamoDbApiKeyStore,
  DynamoDbRateLimitCounterStore,
  SsmAccessConfigSource,
} from '@open-estate/core';

const documentClient = () =>
  DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));

describe('DynamoDbRateLimitCounterStore', () => {
  const input = { counterKey: 'ip:a#1767268800', limit: 60, expiresAtEpochSeconds: 1767268860 };

  it('sends a conditional ADD with TTL and admits on success', async () => {
    const client = documentClient();
    const send = jest.spyOn(client, 'send').mockImplementation(async () => ({}));
    const store = new DynamoDbRateLimitCounterStore({ client, tableName: 'counters' });

    await expect(store.tryIncrement(input)).resolves.toBe(true);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(UpdateCommand);
    expect((command as UpdateCommand).input).toEqual({
      TableName: 'counters',
      Key: { counterKey: 'ip:a#1767268800' },
      UpdateExpression: 'ADD #count :one SET #ttl = :ttl',
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
      ExpressionAttributeNames: { '#count': 'count', '#ttl': 'expiresAt' },
      ExpressionAttributeValues: { ':one': 1, ':limit': 60, ':ttl': 1767268860 },
    });
  });

  it('uses configured key and TTL attribute names', async () => {
    const client = documentClient();
    const send = jest.spyOn(client, 'send').mockImplementation(async () => ({}));
    const store = new DynamoDbRateLimitCounterStore({
      client,
      tableName: 't',
      keyAttribute: 'pk',
      ttlAttribute: 'ttl',
    });
    await store.tryIncrement(input);
    expect((send.mock.calls[0]?.[0] as UpdateCommand).input).toMatchObject({
      Key: { pk: input.counterKey },
      ExpressionAttributeNames: { '#ttl': 'ttl' },
    });
  });

  it('rejects when the condition fails', async () => {
    const client = documentClient();
    jest.spyOn(client, 'send').mockImplementation(async () => {
      throw new ConditionalCheckFailedException({ message: 'failed', $metadata: {} });
    });
    const store = new DynamoDbRateLimitCounterStore({ client, tableName: 'counters' });
    await expect(store.tryIncrement(input)).resolves.toBe(false);
  });

  it('propagates other errors', async () => {
    const client = documentClient();
    jest.spyOn(client, 'send').mockImplementation(async () => {
      throw new Error('throttled');
    });
    const store = new DynamoDbRateLimitCounterStore({ client, tableName: 'counters' });
    await expect(store.tryIncrement(input)).rejects.toThrow('throttled');
  });
});

describe('DynamoDbApiKeyStore', () => {
  const record = {
    keyId: 'k1',
    keyHash: 'abc',
    status: 'active',
    expiresAt: '2027-01-01T00:00:00Z',
    rateLimit: { requests: 10, windowSeconds: 60 },
  };

  it('queries the byHash index and returns the parsed record', async () => {
    const client = documentClient();
    const send = jest
      .spyOn(client, 'send')
      .mockImplementation(async () => ({ Items: [{ ...record, createdAt: 'x' }] }));
    const store = new DynamoDbApiKeyStore({ client, tableName: 'keys' });

    await expect(store.findByHash('abc')).resolves.toEqual(record);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(QueryCommand);
    expect((command as QueryCommand).input).toEqual({
      TableName: 'keys',
      IndexName: 'byHash',
      KeyConditionExpression: '#keyHash = :keyHash',
      ExpressionAttributeNames: { '#keyHash': 'keyHash' },
      ExpressionAttributeValues: { ':keyHash': 'abc' },
      Limit: 1,
    });
  });

  it('returns null for an unknown hash', async () => {
    const client = documentClient();
    jest.spyOn(client, 'send').mockImplementation(async () => ({ Items: [] }));
    const store = new DynamoDbApiKeyStore({ client, tableName: 'keys', indexName: 'idx' });
    await expect(store.findByHash('nope')).resolves.toBeNull();
  });

  it('throws on malformed items instead of granting access', async () => {
    const client = documentClient();
    jest
      .spyOn(client, 'send')
      .mockImplementation(async () => ({ Items: [{ ...record, status: 'unknown' }] }));
    const store = new DynamoDbApiKeyStore({ client, tableName: 'keys' });
    await expect(store.findByHash('abc')).rejects.toThrow();
  });
});

describe('SsmAccessConfigSource', () => {
  function setup(parameters: { Name: string; Value: string }[]) {
    const client = new SSMClient({ region: 'eu-central-1' });
    const send = jest
      .spyOn(client, 'send')
      .mockImplementation(async () => ({ Parameters: parameters }));
    const source = new SsmAccessConfigSource({
      client,
      accessModeParameter: '/oe/test/access-mode',
      rateLimitParameter: '/oe/test/rate-limit',
    });
    return { source, send };
  }

  it('reads access mode and rate limit from the configured parameters', async () => {
    const { source, send } = setup([
      { Name: '/oe/test/access-mode', Value: 'api-keys' },
      { Name: '/oe/test/rate-limit', Value: '{"requests":100,"windowSeconds":30}' },
    ]);
    await expect(source.load()).resolves.toEqual({
      mode: 'api-keys',
      rateLimit: { requests: 100, windowSeconds: 30 },
    });
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetParametersCommand);
    expect((command as GetParametersCommand).input).toEqual({
      Names: ['/oe/test/access-mode', '/oe/test/rate-limit'],
    });
  });

  it('falls back to open mode and 60 requests per 60 s when parameters are missing', async () => {
    await expect(setup([]).source.load()).resolves.toEqual({
      mode: 'open',
      rateLimit: DEFAULT_RATE_LIMIT,
    });
    expect(DEFAULT_RATE_LIMIT).toEqual({ requests: 60, windowSeconds: 60 });
  });

  it.each([
    ['/oe/test/access-mode', 'closed'],
    ['/oe/test/rate-limit', 'not json'],
    ['/oe/test/rate-limit', '{"requests":0,"windowSeconds":60}'],
    ['/oe/test/rate-limit', '{"requests":10001,"windowSeconds":60}'],
    ['/oe/test/rate-limit', '{"requests":60,"windowSeconds":3601}'],
    ['/oe/test/rate-limit', '{"requests":1.5,"windowSeconds":60}'],
  ])('rejects invalid %s value %p with CONFIG_INVALID', async (Name, Value) => {
    const error = await setup([{ Name, Value }])
      .source.load()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID', names: [Name] });
  });

  it('accepts the range boundaries', async () => {
    const low = setup([{ Name: '/oe/test/rate-limit', Value: '{"requests":1,"windowSeconds":1}' }]);
    await expect(low.source.load()).resolves.toMatchObject({
      rateLimit: { requests: 1, windowSeconds: 1 },
    });
    const high = setup([
      { Name: '/oe/test/rate-limit', Value: '{"requests":10000,"windowSeconds":3600}' },
    ]);
    await expect(high.source.load()).resolves.toMatchObject({
      rateLimit: { requests: 10000, windowSeconds: 3600 },
    });
  });
});
