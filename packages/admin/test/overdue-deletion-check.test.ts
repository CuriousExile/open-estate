import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  createOverdueCheckFromEnv,
  createOverdueDeletionCheck,
  DELETION_OVERDUE_AFTER_MS,
  DynamoDbDeletionRequestStore,
  InMemoryDeletionListingStore,
  InMemoryDeletionRequestStore,
  InMemoryOverdueDeletionNotifier,
  SnsOverdueDeletionNotifier,
  type DeletionCriterion,
  type DeletionRequestRecord,
  type OverdueDeletionNotice,
  type OverdueDeletionNotifier,
} from '@open-estate/admin';
import { ConfigError } from '@open-estate/core';

const REQUESTED_AT = Date.parse('2026-01-01T12:00:00.000Z');
const ADMIN = 'arn:aws:iam::123456789012:user/alice';
const region = 'eu-central-1';

function record(
  requestId: string,
  criterion: DeletionCriterion,
  overrides: Partial<DeletionRequestRecord> = {},
): DeletionRequestRecord {
  return {
    requestId,
    criterion,
    status: 'OPEN',
    requestedBy: ADMIN,
    requestedAt: new Date(REQUESTED_AT).toISOString(),
    removedCount: 0,
    ...overrides,
  };
}

function setup(options: { now: number; pageSize?: number; notifier?: OverdueDeletionNotifier }) {
  const requests = new InMemoryDeletionRequestStore();
  const listings = new InMemoryDeletionListingStore({ requests });
  const fake = new InMemoryOverdueDeletionNotifier();
  let now = options.now;
  const check = createOverdueDeletionCheck({
    requests,
    listings,
    notifier: options.notifier ?? fake,
    clock: () => now,
    ...(options.pageSize !== undefined && { pageSize: options.pageSize }),
  });
  return { requests, listings, sent: fake.sent, check, setNow: (ms: number) => (now = ms) };
}

const DAY = DELETION_OVERDUE_AFTER_MS;

describe('createOverdueDeletionCheck', () => {
  it('notifies only requests OPEN for strictly more than 24 h; exactly 24 h is not overdue', async () => {
    const { requests, sent, check, setNow } = setup({ now: REQUESTED_AT + DAY });
    await requests.create(record('req-1', { listingId: 'L-1' }));

    await expect(check()).resolves.toEqual({ checked: 0, notified: 0, skipped: 0, failed: 0 });
    expect(sent).toEqual([]);

    setNow(REQUESTED_AT + DAY + 1);
    await expect(check()).resolves.toMatchObject({ checked: 1, notified: 1 });
    expect(sent.map((notice) => notice.requestId)).toEqual(['req-1']);
  });

  it('ignores younger and EXECUTED requests and keeps notified requests OPEN', async () => {
    const now = REQUESTED_AT + 2 * DAY;
    const { requests, sent, check } = setup({ now });
    await requests.create(record('old', { listingId: 'L-1' }));
    await requests.create(
      record('young', { listingId: 'L-2' }, { requestedAt: new Date(now - DAY + 1).toISOString() }),
    );
    await requests.create(
      record(
        'done',
        { listingId: 'L-3' },
        { status: 'EXECUTED', executedAt: '2026-01-01T13:00:00.000Z' },
      ),
    );

    await check();

    expect(sent.map((notice) => notice.requestId)).toEqual(['old']);
    await expect(requests.get('old')).resolves.toMatchObject({
      status: 'OPEN',
      notifiedAt: new Date(now).toISOString(),
    });
    await expect(requests.get('young')).resolves.not.toHaveProperty('notifiedAt');
  });

  it('notifies each request once, not on every hourly run', async () => {
    const { requests, sent, check, setNow } = setup({ now: REQUESTED_AT + DAY + 1 });
    await requests.create(record('req-1', { listingId: 'L-1' }));

    await check();
    setNow(REQUESTED_AT + DAY + 1 + 60 * 60 * 1000);
    await expect(check()).resolves.toEqual({ checked: 1, notified: 0, skipped: 1, failed: 0 });
    expect(sent).toHaveLength(1);
  });

  it('pages through all overdue requests', async () => {
    const { requests, sent, check } = setup({ now: REQUESTED_AT + 2 * DAY, pageSize: 2 });
    for (let i = 0; i < 5; i += 1) {
      await requests.create(
        record(
          `req-${i}`,
          { listingId: `L-${i}` },
          { requestedAt: new Date(REQUESTED_AT + i).toISOString() },
        ),
      );
    }

    await expect(check()).resolves.toMatchObject({ checked: 5, notified: 5 });
    expect(sent.map((notice) => notice.requestId)).toEqual([
      'req-0',
      'req-1',
      'req-2',
      'req-3',
      'req-4',
    ]);
  });

  it('reports the remaining listings of a source (paged) and of a listing id', async () => {
    const { requests, listings, sent, check } = setup({ now: REQUESTED_AT + 2 * DAY, pageSize: 2 });
    for (const id of ['A-1', 'A-2', 'A-3', 'A-4', 'A-5']) listings.put({ id, source: 'partner-a' });
    listings.put({ id: 'B-1', source: 'partner-b' });
    await requests.create(record('by-source', { source: 'partner-a' }, { removedCount: 2 }));
    await requests.create(record('present', { listingId: 'B-1' }));
    await requests.create(record('gone', { listingId: 'X-1' }));

    await check();

    const remaining = Object.fromEntries(sent.map((n) => [n.requestId, n.remainingCount]));
    expect(remaining).toEqual({ 'by-source': 5, present: 1, gone: 0 });
  });

  it('routes by adminArn and carries no listing content or admin identity in the message', async () => {
    const sns = new SNSClient({ region });
    const send = jest.spyOn(sns, 'send').mockImplementation(async () => ({}));
    const notifier = new SnsOverdueDeletionNotifier({ client: sns, topicArn: 'arn:aws:sns:topic' });
    const { requests, listings, check } = setup({ now: REQUESTED_AT + 2 * DAY, notifier });
    listings.put({ id: 'L-1', source: 'partner-a' });
    await requests.create(record('req-1', { source: 'partner-a' }));

    await check();

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PublishCommand);
    const input = (command as PublishCommand).input;
    expect(input).toMatchObject({
      TopicArn: 'arn:aws:sns:topic',
      MessageAttributes: {
        adminArn: { DataType: 'String', StringValue: ADMIN },
        requesterId: { DataType: 'String', StringValue: ADMIN },
        requestId: { DataType: 'String', StringValue: 'req-1' },
        remainingCount: { DataType: 'Number', StringValue: '1' },
      },
    });
    expect(input.Message).toBe(
      'Deletion request req-1 (source "partner-a", requested 2026-01-01T12:00:00.000Z) has not ' +
        'been fully executed within 24 hours: 1 listing is not yet removed. The request stays OPEN.',
    );
    expect(input.Message).not.toContain(ADMIN);
    expect(input.Subject).not.toContain(ADMIN);
  });

  it('logs a failed notification without content, continues and retries on the next run', async () => {
    const delivered: OverdueDeletionNotice[] = [];
    let failFor = 'req-1';
    const notifier: OverdueDeletionNotifier = {
      async notify(notice) {
        if (notice.requestId === failFor)
          throw Object.assign(new Error(ADMIN), { name: 'SnsDown' });
        delivered.push(notice);
      },
    };
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { requests, check } = setup({ now: REQUESTED_AT + 2 * DAY, notifier });
    await requests.create(record('req-1', { listingId: 'L-1' }));
    await requests.create(
      record(
        'req-2',
        { listingId: 'L-2' },
        { requestedAt: new Date(REQUESTED_AT + 1).toISOString() },
      ),
    );

    await expect(check()).resolves.toEqual({ checked: 2, notified: 1, skipped: 0, failed: 1 });
    expect(delivered.map((n) => n.requestId)).toEqual(['req-2']);
    expect(error).toHaveBeenCalledWith('Overdue deletion check: notification failed', {
      requestId: 'req-1',
      errorName: 'SnsDown',
    });
    await expect(requests.get('req-1')).resolves.not.toHaveProperty('notifiedAt');

    failFor = '';
    await expect(check()).resolves.toMatchObject({ notified: 1, skipped: 1 });
    expect(delivered.map((n) => n.requestId)).toEqual(['req-2', 'req-1']);
    error.mockRestore();
  });
});

describe('DynamoDbDeletionRequestStore overdue support', () => {
  const documentClient = () => DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const inputOf = (send: jest.SpyInstance, call = 0) =>
    (send.mock.calls[call]?.[0] as { input: unknown }).input;

  it('queries byStatus for OPEN before the cutoff, reading only keys, with a cursor', async () => {
    const client = documentClient();
    const lastKey = { requestId: 'req-2', status: 'OPEN', requestedAt: '2026-01-01T00:00:00.000Z' };
    const send = jest
      .spyOn(client, 'send')
      .mockImplementationOnce(async () => ({
        Items: [{ requestId: 'req-1' }, { requestId: 'req-2' }],
        LastEvaluatedKey: lastKey,
      }))
      .mockImplementationOnce(async () => ({ Items: [{ requestId: 'req-3' }] }));
    const store = new DynamoDbDeletionRequestStore({ client, tableName: 'DeletionRequests' });

    const first = await store.listOpenRequestedBefore('2026-01-02T00:00:00.000Z', { limit: 2 });
    expect(first.requestIds).toEqual(['req-1', 'req-2']);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(QueryCommand);
    expect(inputOf(send, 0)).toEqual({
      TableName: 'DeletionRequests',
      IndexName: 'byStatus',
      KeyConditionExpression: '#status = :open AND #requestedAt < :before',
      ProjectionExpression: '#key',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#requestedAt': 'requestedAt',
        '#key': 'requestId',
      },
      ExpressionAttributeValues: { ':open': 'OPEN', ':before': '2026-01-02T00:00:00.000Z' },
      Limit: 2,
    });

    const cursor = first.nextCursor;
    expect(cursor).toBeDefined();
    const second = await store.listOpenRequestedBefore('2026-01-02T00:00:00.000Z', {
      limit: 2,
      ...(cursor !== undefined && { cursor }),
    });
    expect(second).toEqual({ requestIds: ['req-3'] });
    expect(inputOf(send, 1)).toMatchObject({ ExclusiveStartKey: lastKey });
  });

  it('markNotified sets notifiedAt only once on OPEN requests and leaves the status', async () => {
    const client = documentClient();
    const send = jest
      .spyOn(client, 'send')
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => {
        throw new ConditionalCheckFailedException({ message: 'failed', $metadata: {} });
      });
    const store = new DynamoDbDeletionRequestStore({ client, tableName: 'DeletionRequests' });

    await expect(store.markNotified('req-1', '2026-01-03T00:00:00.000Z')).resolves.toBe(true);
    await expect(store.markNotified('req-1', '2026-01-03T01:00:00.000Z')).resolves.toBe(false);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(UpdateCommand);
    expect(inputOf(send, 0)).toEqual({
      TableName: 'DeletionRequests',
      Key: { requestId: 'req-1' },
      UpdateExpression: 'SET #notifiedAt = :notifiedAt',
      ConditionExpression:
        'attribute_exists(#key) AND #status = :open AND attribute_not_exists(#notifiedAt)',
      ExpressionAttributeNames: {
        '#key': 'requestId',
        '#status': 'status',
        '#notifiedAt': 'notifiedAt',
      },
      ExpressionAttributeValues: { ':open': 'OPEN', ':notifiedAt': '2026-01-03T00:00:00.000Z' },
    });
  });
});

describe('createOverdueCheckFromEnv', () => {
  const ENV = {
    LISTINGS_TABLE_NAME: 'Listings',
    DELETION_REQUESTS_TABLE_NAME: 'DeletionRequests',
    OVERDUE_TOPIC_ARN: 'arn:aws:sns:topic',
  };

  it('names every missing variable', () => {
    const error = (() => {
      try {
        createOverdueCheckFromEnv({ LISTINGS_TABLE_NAME: 'Listings' });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({
      code: 'CONFIG_MISSING',
      names: ['DELETION_REQUESTS_TABLE_NAME', 'OVERDUE_TOPIC_ARN'],
    });
  });

  it('wires DynamoDB and SNS from the environment', async () => {
    const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
    const sns = new SNSClient({ region });
    jest.spyOn(dynamo, 'send').mockImplementation(async (command) => {
      if (command instanceof QueryCommand) return { Items: [{ requestId: 'req-1' }] };
      if (command instanceof GetCommand) {
        return command.input.TableName === 'Listings'
          ? {}
          : { Item: record('req-1', { listingId: 'L-1' }) };
      }
      return {};
    });
    const publish = jest.spyOn(sns, 'send').mockImplementation(async () => ({}));

    await expect(createOverdueCheckFromEnv(ENV, { dynamo, sns })()).resolves.toMatchObject({
      notified: 1,
    });
    expect((publish.mock.calls[0]?.[0] as PublishCommand).input).toMatchObject({
      TopicArn: 'arn:aws:sns:topic',
      MessageAttributes: { remainingCount: { StringValue: '0' } },
    });
  });
});
