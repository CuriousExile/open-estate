import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { SSMClient } from '@aws-sdk/client-ssm';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  createAdminHandlerFromEnv,
  createDeletionWorkflowFromEnv,
  DynamoDbAuditLog,
  DynamoDbDeletionBlocklistStore,
  DynamoDbDeletionListingStore,
  DynamoDbDeletionRequestStore,
  StepFunctionsDeletionWorkflowStarter,
  type DeletionRequestRecord,
} from '@open-estate/admin';
import { ConfigError, LISTINGS_BY_SOURCE_INDEX } from '@open-estate/core';

const documentClient = () =>
  DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));

const conditionFailed = () =>
  new ConditionalCheckFailedException({ message: 'failed', $metadata: {} });

const cancelled = (...codes: string[]) =>
  new TransactionCanceledException({
    message: 'cancelled',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

const RECORD: DeletionRequestRecord = {
  requestId: 'req-1',
  criterion: { source: 'partner-a' },
  status: 'OPEN',
  requestedBy: 'arn:aws:iam::1:user/a',
  requestedAt: '2026-01-01T12:00:00.000Z',
  removedCount: 0,
};
const EXECUTED = { ...RECORD, status: 'EXECUTED', executedAt: '2026-01-01T13:00:00.000Z' };

const inputOf = (send: jest.SpyInstance, call = 0) =>
  (send.mock.calls[call]?.[0] as { input: unknown }).input;

describe('DynamoDbDeletionRequestStore', () => {
  it('creates conditionally and reads strongly consistent', async () => {
    const client = documentClient();
    const send = jest
      .spyOn(client, 'send')
      .mockImplementation(async (command) =>
        command instanceof GetCommand ? { Item: RECORD } : {},
      );
    const store = new DynamoDbDeletionRequestStore({ client, tableName: 'DeletionRequests' });

    await store.create(RECORD);
    await expect(store.get('req-1')).resolves.toEqual(RECORD);

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(PutCommand);
    expect(inputOf(send, 0)).toEqual({
      TableName: 'DeletionRequests',
      Item: RECORD,
      ConditionExpression: 'attribute_not_exists(#key)',
      ExpressionAttributeNames: { '#key': 'requestId' },
    });
    expect(inputOf(send, 1)).toEqual({
      TableName: 'DeletionRequests',
      Key: { requestId: 'req-1' },
      ConsistentRead: true,
    });
  });

  it('markExecuted updates only OPEN requests and otherwise returns the current state', async () => {
    const client = documentClient();
    const send = jest
      .spyOn(client, 'send')
      .mockImplementationOnce(async () => ({ Attributes: EXECUTED }))
      .mockImplementationOnce(async () => {
        throw conditionFailed();
      })
      .mockImplementationOnce(async () => ({ Item: EXECUTED }))
      .mockImplementationOnce(async () => {
        throw conditionFailed();
      })
      .mockImplementationOnce(async () => ({}));
    const store = new DynamoDbDeletionRequestStore({ client, tableName: 'DeletionRequests' });

    await expect(store.markExecuted('req-1', EXECUTED.executedAt)).resolves.toEqual(EXECUTED);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(UpdateCommand);
    expect(inputOf(send, 0)).toMatchObject({
      Key: { requestId: 'req-1' },
      ConditionExpression: 'attribute_exists(#key) AND #status = :open',
      ExpressionAttributeValues: { ':executed': 'EXECUTED', ':open': 'OPEN' },
    });
    await expect(store.markExecuted('req-1', 'later')).resolves.toEqual(EXECUTED);
    await expect(store.markExecuted('missing', 'later')).resolves.toBeNull();
  });
});

describe('DynamoDbDeletionListingStore', () => {
  const create = () => {
    const client = documentClient();
    const store = new DynamoDbDeletionListingStore({
      client,
      listingsTable: 'Listings',
      deletionRequestsTable: 'DeletionRequests',
    });
    return { client, store };
  };

  it('find reads only key attributes', async () => {
    const { client, store } = create();
    const send = jest
      .spyOn(client, 'send')
      .mockImplementationOnce(async () => ({ Item: { id: 'L-1', source: 'partner-a' } }))
      .mockImplementationOnce(async () => ({}));

    await expect(store.find('L-1')).resolves.toEqual({ listingId: 'L-1', source: 'partner-a' });
    await expect(store.find('L-2')).resolves.toBeNull();
    expect(inputOf(send)).toEqual({
      TableName: 'Listings',
      Key: { id: 'L-1' },
      ProjectionExpression: '#id, #source',
      ExpressionAttributeNames: { '#id': 'id', '#source': 'source' },
      ConsistentRead: true,
    });
  });

  it('listBySource queries the bySource GSI and round-trips the cursor', async () => {
    const { client, store } = create();
    const lastKey = { id: 'A-2', source: 'partner-a' };
    const send = jest
      .spyOn(client, 'send')
      .mockImplementationOnce(async () => ({
        Items: [{ id: 'A-1' }, { id: 'A-2' }],
        LastEvaluatedKey: lastKey,
      }))
      .mockImplementationOnce(async () => ({ Items: [{ id: 'A-3' }] }));

    const first = await store.listBySource('partner-a', { limit: 2 });
    expect(first.targets).toEqual([
      { listingId: 'A-1', source: 'partner-a' },
      { listingId: 'A-2', source: 'partner-a' },
    ]);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(QueryCommand);
    expect(inputOf(send, 0)).toMatchObject({
      IndexName: LISTINGS_BY_SOURCE_INDEX,
      KeyConditionExpression: '#source = :source',
      ExpressionAttributeValues: { ':source': 'partner-a' },
      Limit: 2,
    });

    const second = await store.listBySource('partner-a', {
      limit: 2,
      ...(first.nextCursor !== undefined && { cursor: first.nextCursor }),
    });
    expect(inputOf(send, 1)).toMatchObject({ ExclusiveStartKey: lastKey });
    expect(second).toEqual({ targets: [{ listingId: 'A-3', source: 'partner-a' }] });
  });

  it('removeForRequest deletes and counts in one transaction; a gone listing is not counted', async () => {
    const { client, store } = create();
    const send = jest
      .spyOn(client, 'send')
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => {
        throw cancelled('ConditionalCheckFailed', 'None');
      })
      .mockImplementationOnce(async () => {
        throw cancelled('None', 'ConditionalCheckFailed');
      });

    await expect(store.removeForRequest('L-1', 'req-1')).resolves.toBe(true);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(TransactWriteCommand);
    expect(inputOf(send, 0)).toEqual({
      TransactItems: [
        {
          Delete: {
            TableName: 'Listings',
            Key: { id: 'L-1' },
            ConditionExpression: 'attribute_exists(#id)',
            ExpressionAttributeNames: { '#id': 'id' },
          },
        },
        {
          Update: {
            TableName: 'DeletionRequests',
            Key: { requestId: 'req-1' },
            UpdateExpression: 'ADD #removedCount :one',
            ConditionExpression: 'attribute_exists(#key)',
            ExpressionAttributeNames: { '#removedCount': 'removedCount', '#key': 'requestId' },
            ExpressionAttributeValues: { ':one': 1 },
          },
        },
      ],
    });
    await expect(store.removeForRequest('L-1', 'req-1')).resolves.toBe(false);
    // Unknown request: the listing stays (transaction cancelled) and the error surfaces.
    await expect(store.removeForRequest('L-1', 'missing')).rejects.toThrow('cancelled');
  });

  it('inspect reads status, agency and Custom_Id strongly consistent', async () => {
    const { client, store } = create();
    const send = jest.spyOn(client, 'send').mockImplementationOnce(async () => ({
      Item: { id: 'L-1', source: 'agency:a', status: 'INACTIVE', agencyId: 'a', customId: 'C-1' },
    }));

    await expect(store.inspect('L-1')).resolves.toEqual({
      listingId: 'L-1',
      source: 'agency:a',
      status: 'INACTIVE',
      agencyId: 'a',
      customId: 'C-1',
    });
    expect(inputOf(send)).toMatchObject({ Key: { id: 'L-1' }, ConsistentRead: true });
  });

  it('releases the Custom_Id key and decrements counters in the removal transaction', async () => {
    const client = documentClient();
    const store = new DynamoDbDeletionListingStore({
      client,
      listingsTable: 'Listings',
      deletionRequestsTable: 'DeletionRequests',
      listingKeysTable: 'ListingKeys',
      metricCountersTable: 'MetricCounters',
    });
    const send = jest.spyOn(client, 'send').mockImplementation(async () => ({}));

    await store.removeForRequest('L-1', 'req-1', {
      customKey: { owner: 'a', customId: 'C-1' },
      counters: [{ scope: 'agency#a', code: 'history.version_count', delta: -3 }],
    });

    const items = (inputOf(send) as { TransactItems: Record<string, unknown>[] }).TransactItems;
    expect(items).toHaveLength(4);
    expect(items[2]).toEqual({
      Delete: {
        TableName: 'ListingKeys',
        Key: { customKey: 'a#C-1' },
        ConditionExpression: '#listingId = :listingId',
        ExpressionAttributeNames: { '#listingId': 'listingId' },
        ExpressionAttributeValues: { ':listingId': 'L-1' },
      },
    });
    expect(items[3]).toMatchObject({
      Update: {
        TableName: 'MetricCounters',
        Key: { scope: 'agency#a', sk: 'history.version_count#current' },
        ExpressionAttributeValues: { ':delta': -3 },
      },
    });
  });

  it('refuses a removal it cannot write completely', async () => {
    const { store } = create();
    await expect(
      store.removeForRequest('L-1', 'req-1', { customKey: { owner: 'a', customId: 'C-1' } }),
    ).rejects.toThrow('listingKeysTable is not configured');
  });
});

describe('DynamoDbDeletionRequestStore: incomplete listings', () => {
  it('tracks incomplete listings in a string set beside the record', async () => {
    const client = documentClient();
    const send = jest
      .spyOn(client, 'send')
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => ({
        Item: { incompleteListingIds: new Set(['L-2', 'L-1']) },
      }))
      .mockImplementationOnce(async () => {
        throw conditionFailed();
      });
    const store = new DynamoDbDeletionRequestStore({ client, tableName: 'DeletionRequests' });

    await store.markIncomplete('req-1', 'L-1');
    await store.markComplete('req-1', 'L-1');
    await expect(store.incompleteListings('req-1')).resolves.toEqual(['L-1', 'L-2']);
    await expect(store.markIncomplete('missing', 'L-1')).rejects.toThrow(
      'Deletion request missing not found',
    );

    expect(inputOf(send, 0)).toEqual({
      TableName: 'DeletionRequests',
      Key: { requestId: 'req-1' },
      UpdateExpression: 'ADD #incomplete :ids',
      ConditionExpression: 'attribute_exists(#key)',
      ExpressionAttributeNames: { '#key': 'requestId', '#incomplete': 'incompleteListingIds' },
      ExpressionAttributeValues: { ':ids': new Set(['L-1']) },
    });
    expect(inputOf(send, 1)).toMatchObject({ UpdateExpression: 'DELETE #incomplete :ids' });
  });

  it('get keeps the Admin_API record unchanged (no incomplete attribute)', async () => {
    const client = documentClient();
    jest.spyOn(client, 'send').mockImplementation(async () => ({
      Item: { ...RECORD, incompleteListingIds: new Set(['L-1']) },
    }));
    const store = new DynamoDbDeletionRequestStore({ client, tableName: 'DeletionRequests' });
    await expect(store.get('req-1')).resolves.toEqual(RECORD);
  });
});

describe('DynamoDbDeletionBlocklistStore', () => {
  it('blocks conditionally (keeps an existing entry) and unblocks via DeleteItem', async () => {
    const client = documentClient();
    const send = jest
      .spyOn(client, 'send')
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => {
        throw conditionFailed();
      })
      .mockImplementationOnce(async () => ({ Attributes: { listingId: 'L-1' } }))
      .mockImplementationOnce(async () => ({}));
    const store = new DynamoDbDeletionBlocklistStore({ client, tableName: 'DeletionBlocklist' });
    const entry = {
      listingId: 'L-1',
      source: 'partner-a',
      deletedAt: '2026-01-01T12:00:00.000Z',
      requestId: 'req-1',
    };

    await store.block(entry);
    await expect(store.block(entry)).resolves.toBeUndefined();
    expect(inputOf(send, 0)).toEqual({
      TableName: 'DeletionBlocklist',
      Item: entry,
      ConditionExpression: 'attribute_not_exists(#key)',
      ExpressionAttributeNames: { '#key': 'listingId' },
    });

    await expect(store.unblock('L-1')).resolves.toBe(true);
    expect(send.mock.calls[2]?.[0]).toBeInstanceOf(DeleteCommand);
    expect(inputOf(send, 2)).toEqual({
      TableName: 'DeletionBlocklist',
      Key: { listingId: 'L-1' },
      ReturnValues: 'ALL_OLD',
    });
    await expect(store.unblock('L-2')).resolves.toBe(false);
  });

  it('blockAll blocks id and Custom_Id key in one transaction, keeping existing entries', async () => {
    const client = documentClient();
    const send = jest.spyOn(client, 'send').mockImplementation(async () => ({}));
    const store = new DynamoDbDeletionBlocklistStore({ client, tableName: 'DeletionBlocklist' });
    const entry = (listingId: string) => ({
      listingId,
      source: 'agency:a',
      deletedAt: '2026-01-01T12:00:00.000Z',
      requestId: 'req-1',
    });

    await store.blockAll([entry('L-1'), entry('custom#a#C-1')]);

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(TransactWriteCommand);
    const items = (inputOf(send) as { TransactItems: { Update: Record<string, unknown> }[] })
      .TransactItems;
    expect(items.map((item) => item.Update['Key'])).toEqual([
      { listingId: 'L-1' },
      { listingId: 'custom#a#C-1' },
    ]);
    expect(items[0]?.Update).toMatchObject({
      UpdateExpression: expect.stringContaining('#deletedAt = if_not_exists(#deletedAt'),
      ExpressionAttributeValues: { ':requestId': 'req-1' },
    });
    expect(items[0]?.Update['ConditionExpression']).toBeUndefined();
  });
});

describe('DynamoDbAuditLog with a stable id', () => {
  it('uses the id as sort-key suffix, so a re-append overwrites the same item', async () => {
    const client = documentClient();
    const send = jest.spyOn(client, 'send').mockImplementation(async () => ({}));
    const log = new DynamoDbAuditLog({ client, tableName: 'AuditLog', newId: () => 'random' });
    await log.append({
      type: 'deletion',
      action: 'deletion.executed',
      actor: 'arn',
      at: '2026-01-01T13:00:00.000Z',
      id: 'req-1',
      details: {},
    });
    expect(inputOf(send)).toMatchObject({
      Item: { category: 'deletion', timestampId: '2026-01-01T13:00:00.000Z#req-1' },
    });
  });
});

describe('StepFunctionsDeletionWorkflowStarter', () => {
  it('starts an execution named after the request id', async () => {
    const client = new SFNClient({ region: 'eu-central-1' });
    const send = jest.spyOn(client, 'send').mockImplementation(async () => ({}));
    await new StepFunctionsDeletionWorkflowStarter({
      client,
      stateMachineArn: 'arn:sm',
    }).start('req-1');
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(StartExecutionCommand);
    expect(inputOf(send)).toEqual({
      stateMachineArn: 'arn:sm',
      name: 'req-1',
      input: '{"requestId":"req-1"}',
    });
  });
});

describe('production wiring', () => {
  const ENV = {
    API_KEYS_TABLE_NAME: 'ApiKeys',
    AUDIT_LOG_TABLE_NAME: 'AuditLog',
    ACCESS_MODE_PARAMETER_NAME: '/oe/test/access-mode',
    RATE_LIMIT_PARAMETER_NAME: '/oe/test/rate-limit',
    LISTINGS_TABLE_NAME: 'Listings',
    DELETION_REQUESTS_TABLE_NAME: 'DeletionRequests',
    DELETION_BLOCKLIST_TABLE_NAME: 'DeletionBlocklist',
    DELETION_STATE_MACHINE_ARN: 'arn:sm',
  };

  it('POST /admin/deletions: existence check, OPEN request, StartExecution', async () => {
    const dynamo = documentClient();
    const sfn = new SFNClient({ region: 'eu-central-1' });
    const dynamoSend = jest
      .spyOn(dynamo, 'send')
      .mockImplementation(async (command) =>
        command instanceof GetCommand ? { Item: { id: 'L-1', source: 'partner-a' } } : {},
      );
    const sfnSend = jest.spyOn(sfn, 'send').mockImplementation(async () => ({}));
    const handler = createAdminHandlerFromEnv(ENV, {
      dynamo,
      ssm: new SSMClient({ region: 'eu-central-1' }),
      sfn,
    });

    const res = await handler({
      httpMethod: 'POST',
      path: '/admin/deletions',
      body: '{"listingId":"L-1"}',
      requestContext: { identity: { userArn: 'arn:aws:iam::1:user/a' } },
    });

    expect(res.statusCode).toBe(202);
    const { requestId } = JSON.parse(res.body) as { requestId: string };
    expect(inputOf(dynamoSend, 0)).toMatchObject({ TableName: 'Listings', Key: { id: 'L-1' } });
    expect(inputOf(dynamoSend, 1)).toMatchObject({
      TableName: 'DeletionRequests',
      Item: { requestId, status: 'OPEN', criterion: { listingId: 'L-1' }, removedCount: 0 },
    });
    expect(inputOf(sfnSend)).toMatchObject({ stateMachineArn: 'arn:sm', name: requestId });
  });

  it('deletion workflow from env names every missing variable', () => {
    const error = (() => {
      try {
        createDeletionWorkflowFromEnv({ LISTINGS_TABLE_NAME: 'Listings' }, documentClient());
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({
      code: 'CONFIG_MISSING',
      names: [
        'DELETION_REQUESTS_TABLE_NAME',
        'DELETION_BLOCKLIST_TABLE_NAME',
        'AUDIT_LOG_TABLE_NAME',
        'LISTING_VERSIONS_TABLE_NAME',
        'LISTING_KEYS_TABLE_NAME',
        'METRIC_COUNTERS_TABLE_NAME',
        'SNAPSHOT_BUCKET_NAME',
        'DUPLICATE_INDEX_TABLE_NAME',
        'IDEMPOTENCY_KEYS_TABLE_NAME',
        'DUPLICATE_REPORTS_TABLE_NAME',
      ],
    });
  });
});
