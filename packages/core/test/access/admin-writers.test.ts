import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetParametersCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  DynamoDbApiKeyStore,
  InMemoryApiKeyStore,
  SsmAccessConfigSource,
  SsmAccessConfigWriter,
  StaticAccessConfigSource,
  type ApiKeyRecord,
} from '@open-estate/core';

const documentClient = () =>
  DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));

const record: ApiKeyRecord = { keyId: 'k1', keyHash: 'abc', status: 'active' };

describe('DynamoDbApiKeyStore (admin writes)', () => {
  it('creates with attribute_not_exists(keyId)', async () => {
    const client = documentClient();
    const send = jest.spyOn(client, 'send').mockImplementation(async () => ({}));
    await new DynamoDbApiKeyStore({ client, tableName: 'keys' }).create(record);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutCommand);
    expect((command as PutCommand).input).toEqual({
      TableName: 'keys',
      Item: record,
      ConditionExpression: 'attribute_not_exists(#keyId)',
      ExpressionAttributeNames: { '#keyId': 'keyId' },
    });
  });

  it('revokes with attribute_exists(keyId) and returns the updated record', async () => {
    const client = documentClient();
    const send = jest
      .spyOn(client, 'send')
      .mockImplementation(async () => ({ Attributes: { ...record, status: 'revoked' } }));
    const store = new DynamoDbApiKeyStore({ client, tableName: 'keys' });
    await expect(store.revoke('k1')).resolves.toEqual({ ...record, status: 'revoked' });
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(UpdateCommand);
    expect((command as UpdateCommand).input).toEqual({
      TableName: 'keys',
      Key: { keyId: 'k1' },
      UpdateExpression: 'SET #attribute = :value',
      ConditionExpression: 'attribute_exists(#keyId)',
      ExpressionAttributeNames: { '#attribute': 'status', '#keyId': 'keyId' },
      ExpressionAttributeValues: { ':value': 'revoked' },
      ReturnValues: 'ALL_NEW',
    });
  });

  it('sets a key rate limit', async () => {
    const client = documentClient();
    const rateLimit = { requests: 5, windowSeconds: 10 };
    const send = jest
      .spyOn(client, 'send')
      .mockImplementation(async () => ({ Attributes: { ...record, rateLimit } }));
    const store = new DynamoDbApiKeyStore({ client, tableName: 'keys' });
    await expect(store.setRateLimit('k1', rateLimit)).resolves.toEqual({ ...record, rateLimit });
    expect((send.mock.calls[0]?.[0] as UpdateCommand).input).toMatchObject({
      ExpressionAttributeNames: { '#attribute': 'rateLimit' },
      ExpressionAttributeValues: { ':value': rateLimit },
    });
  });

  it('returns null for an unknown key and propagates other errors', async () => {
    const client = documentClient();
    const send = jest.spyOn(client, 'send').mockImplementationOnce(async () => {
      throw new ConditionalCheckFailedException({ message: 'failed', $metadata: {} });
    });
    const store = new DynamoDbApiKeyStore({ client, tableName: 'keys' });
    await expect(store.revoke('nope')).resolves.toBeNull();

    send.mockImplementationOnce(async () => {
      throw new Error('throttled');
    });
    await expect(store.setRateLimit('k1', { requests: 1, windowSeconds: 1 })).rejects.toThrow(
      'throttled',
    );
  });
});

describe('InMemoryApiKeyStore (admin writes)', () => {
  it('creates, rejects duplicate ids, updates by id and returns null for unknown ids', async () => {
    const store = new InMemoryApiKeyStore();
    await store.create(record);
    await expect(store.create({ ...record, keyHash: 'other' })).rejects.toThrow();
    await expect(store.setRateLimit('k1', { requests: 2, windowSeconds: 3 })).resolves.toEqual({
      ...record,
      rateLimit: { requests: 2, windowSeconds: 3 },
    });
    await expect(store.revoke('k1')).resolves.toMatchObject({ status: 'revoked' });
    await expect(store.findByHash('abc')).resolves.toMatchObject({ status: 'revoked' });
    await expect(store.revoke('unknown')).resolves.toBeNull();
  });
});

describe('SsmAccessConfigWriter', () => {
  const options = (client: SSMClient) => ({
    client,
    accessModeParameter: '/oe/test/access-mode',
    rateLimitParameter: '/oe/test/rate-limit',
  });

  it('overwrites the parameters in the format SsmAccessConfigSource reads', async () => {
    const client = new SSMClient({ region: 'eu-central-1' });
    const stored = new Map<string, string>();
    jest.spyOn(client, 'send').mockImplementation(async (command: unknown) => {
      if (command instanceof PutParameterCommand) {
        expect(command.input).toMatchObject({ Type: 'String', Overwrite: true });
        stored.set(command.input.Name ?? '', command.input.Value ?? '');
        return {};
      }
      const names = (command as GetParametersCommand).input.Names ?? [];
      return {
        Parameters: names.flatMap((Name) =>
          stored.has(Name) ? [{ Name, Value: stored.get(Name) }] : [],
        ),
      };
    });
    const writer = new SsmAccessConfigWriter(options(client));
    // Extra properties are not written.
    await writer.setRateLimit({ requests: 100, windowSeconds: 30, extra: 1 } as never);
    await writer.setAccessMode('api-keys');

    expect(stored.get('/oe/test/rate-limit')).toBe('{"requests":100,"windowSeconds":30}');
    await expect(new SsmAccessConfigSource(options(client)).load()).resolves.toEqual({
      mode: 'api-keys',
      rateLimit: { requests: 100, windowSeconds: 30 },
    });
  });

  it('never writes an out-of-range limit', async () => {
    const client = new SSMClient({ region: 'eu-central-1' });
    const send = jest.spyOn(client, 'send').mockImplementation(async () => ({}));
    await expect(
      new SsmAccessConfigWriter(options(client)).setRateLimit({ requests: 0, windowSeconds: 60 }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('StaticAccessConfigSource (writer)', () => {
  it('applies rate limit and mode changes', async () => {
    const source = new StaticAccessConfigSource({
      mode: 'open',
      rateLimit: { requests: 60, windowSeconds: 60 },
    });
    await source.setRateLimit({ requests: 1, windowSeconds: 2 });
    await source.setAccessMode('api-keys');
    await expect(source.load()).resolves.toEqual({
      mode: 'api-keys',
      rateLimit: { requests: 1, windowSeconds: 2 },
    });
  });
});
