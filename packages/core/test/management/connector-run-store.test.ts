import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  CONNECTOR_RUN_RETENTION_SECONDS,
  DynamoDbConnectorRunStore,
  encodeKeyCursor,
  InMemoryConnectorRunStore,
  connectorRunExpiry,
  connectorRunSortKey,
} from '@open-estate/core';

const RUN = {
  runId: 'run-1',
  connectorId: 'partner-db',
  agencyId: 'agency-1',
  startedAt: '2026-03-01T10:00:00.000Z',
  endedAt: '2026-03-01T10:05:00.000Z',
  status: 'SUCCESS',
  imported: 2,
  updated: 1,
  unchanged: 4,
  rejected: 1,
  flagged: 0,
};
const REJECTION = { listingId: 'L-1', customId: 'C-1', fields: ['price'], reason: 'Required' };
const EXPIRES = Date.parse(RUN.startedAt) / 1000 + CONNECTOR_RUN_RETENTION_SECONDS;

function mockSend(results: unknown[] = []) {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
  const send = jest
    .spyOn(client, 'send')
    .mockImplementation(async () => (results.length > 0 ? results.shift() : {}));
  const command = (index = 0) => send.mock.calls[index]?.[0] as { input: Record<string, unknown> };
  const store = new DynamoDbConnectorRunStore({
    client,
    runsTableName: 'ConnectorRuns',
    rejectionsTableName: 'RunRejections',
    retryDelayMs: 0,
  });
  return { store, send, command };
}

describe('connector run keys', () => {
  it('normalizes the start for sortable keys and expires 100 days after the start', () => {
    expect(connectorRunSortKey('2026-03-01T11:00:00+01:00', 'r')).toBe(
      '2026-03-01T10:00:00.000Z#r',
    );
    expect(connectorRunExpiry(RUN.startedAt)).toBe(EXPIRES);
    expect(() => connectorRunExpiry('yesterday')).toThrow();
  });
});

describe('DynamoDbConnectorRunStore.record', () => {
  it('writes summary and run marker, then the rejections with seq 1…n, all with TTL', async () => {
    const { store, send, command } = mockSend();
    await store.record(RUN, [REJECTION, { fields: ['id'], reason: 'Identität fehlt' }]);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(BatchWriteCommand);
    expect(command(0).input).toEqual({
      RequestItems: {
        ConnectorRuns: [
          {
            PutRequest: {
              Item: { ...RUN, runKey: `${RUN.startedAt}#run-1`, expiresAt: EXPIRES },
            },
          },
        ],
        RunRejections: [
          {
            PutRequest: {
              Item: {
                runId: 'run-1',
                seq: 0,
                connectorId: 'partner-db',
                agencyId: 'agency-1',
                startedAt: RUN.startedAt,
                expiresAt: EXPIRES,
              },
            },
          },
        ],
      },
    });
    expect(command(1).input).toEqual({
      RequestItems: {
        RunRejections: [
          {
            PutRequest: {
              Item: {
                ...REJECTION,
                runId: 'run-1',
                seq: 1,
                agencyId: 'agency-1',
                expiresAt: EXPIRES,
              },
            },
          },
          {
            PutRequest: {
              Item: {
                fields: ['id'],
                reason: 'Identität fehlt',
                runId: 'run-1',
                seq: 2,
                agencyId: 'agency-1',
                expiresAt: EXPIRES,
              },
            },
          },
        ],
      },
    });
  });

  it('splits rejections into batches of 25 and retries unprocessed items', async () => {
    const rejections = Array.from({ length: 30 }, (_, i) => ({
      listingId: `L-${i}`,
      fields: ['price'],
      reason: 'Required',
    }));
    const unprocessed = { RunRejections: [{ PutRequest: { Item: { runId: 'run-1', seq: 1 } } }] };
    const { store, send, command } = mockSend([{}, { UnprocessedItems: unprocessed }, {}, {}]);
    await store.record(RUN, rejections);
    const sizes = send.mock.calls.map(
      (_, i) =>
        ((command(i).input['RequestItems'] as Record<string, unknown[]>)['RunRejections'] ?? [])
          .length,
    );
    expect(sizes).toEqual([1, 25, 1, 5]);
  });

  it('throws when items stay unprocessed', async () => {
    const unprocessed = { ConnectorRuns: [{ PutRequest: { Item: {} } }] };
    const { store } = mockSend(
      Array.from({ length: 5 }, () => ({ UnprocessedItems: unprocessed })),
    );
    await expect(store.record(RUN, [])).rejects.toThrow(/unprocessed/);
  });

  it('refuses values that do not match the run view', async () => {
    const { store, send } = mockSend();
    await expect(store.record({ ...RUN, imported: -1 }, [])).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('DynamoDbConnectorRunStore.query', () => {
  const item = { ...RUN, runKey: `${RUN.startedAt}#run-1`, expiresAt: EXPIRES };
  const period = { from: '2026-03-01T00:00:00Z', to: '2026-03-02T00:00:00+00:00' };
  const range = {
    ':from': '2026-03-01T00:00:00.000Z',
    ':to': '2026-03-02T00:00:00.000Z#\uffff',
  };

  it('queries the byAgency index newest first with filters and cursor', async () => {
    const lastKey = { agencyId: 'agency-1', runKey: item.runKey, connectorId: 'partner-db' };
    const { store, send, command } = mockSend([{ Items: [item], LastEvaluatedKey: lastKey }]);
    const cursor = encodeKeyCursor({ agencyId: 'agency-1', runKey: 'x', connectorId: 'c' });
    const page = await store.query(
      { ...period, agencyId: 'agency-1', connectorId: 'partner-db', problemsOnly: true },
      { limit: 10, cursor },
    );
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(QueryCommand);
    expect(command().input).toEqual({
      TableName: 'ConnectorRuns',
      IndexName: 'byAgency',
      Limit: 10,
      ExclusiveStartKey: { agencyId: 'agency-1', runKey: 'x', connectorId: 'c' },
      KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :from AND :to',
      FilterExpression: '#connectorId = :connectorId AND (#status = :failure OR #rejected > :zero)',
      ExpressionAttributeNames: {
        '#pk': 'agencyId',
        '#sk': 'runKey',
        '#connectorId': 'connectorId',
        '#status': 'status',
        '#rejected': 'rejected',
      },
      ExpressionAttributeValues: {
        ...range,
        ':pk': 'agency-1',
        ':connectorId': 'partner-db',
        ':failure': 'FAILURE',
        ':zero': 0,
      },
      ScanIndexForward: false,
    });
    expect(page).toEqual({ items: [RUN], nextCursor: encodeKeyCursor(lastKey) });
  });

  it('queries the table by connector and scans without agency and connector', async () => {
    const byConnector = mockSend([{ Items: [item] }]);
    await byConnector.store.query(
      { ...period, connectorId: 'partner-db', status: 'FAILURE' },
      {
        limit: 5,
      },
    );
    expect(byConnector.command().input).toMatchObject({
      TableName: 'ConnectorRuns',
      KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :from AND :to',
      FilterExpression: '#status = :status',
      ExpressionAttributeValues: { ':pk': 'partner-db', ':status': 'FAILURE' },
    });
    expect(byConnector.command().input).not.toHaveProperty('IndexName');

    const older = { ...item, runId: 'run-0', startedAt: '2026-03-01T08:00:00.000Z' };
    const all = mockSend([{ Items: [older, item] }]);
    const page = await all.store.query(period, { limit: 5 });
    expect(all.send.mock.calls[0]?.[0]).toBeInstanceOf(ScanCommand);
    expect(all.command().input).toMatchObject({
      FilterExpression: '#sk BETWEEN :from AND :to',
      ExpressionAttributeValues: range,
    });
    expect(page.items.map((run) => run.runId)).toEqual(['run-1', 'run-0']);
  });
});

describe('DynamoDbConnectorRunStore.rejections', () => {
  it('resolves the agency from the run marker and queries the rejections after it', async () => {
    const marker = { runId: 'run-1', seq: 0, connectorId: 'partner-db', agencyId: 'agency-1' };
    const rejection = { ...REJECTION, runId: 'run-1', seq: 1, agencyId: 'agency-1' };
    const { store, send, command } = mockSend([{ Item: marker }, { Items: [rejection] }]);
    const page = await store.rejections('run-1', { limit: 50 });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand);
    expect(command(0).input).toEqual({
      TableName: 'RunRejections',
      Key: { runId: 'run-1', seq: 0 },
    });
    expect(command(1).input).toEqual({
      TableName: 'RunRejections',
      KeyConditionExpression: '#pk = :pk AND #sk > :marker',
      ExpressionAttributeNames: { '#pk': 'runId', '#sk': 'seq' },
      ExpressionAttributeValues: { ':pk': 'run-1', ':marker': 0 },
      Limit: 50,
    });
    expect(page).toEqual({ items: [REJECTION], agencyId: 'agency-1' });
  });

  it('returns null for unknown runs and an empty page for runs without rejections', async () => {
    await expect(mockSend([{}]).store.rejections('gone', { limit: 5 })).resolves.toBeNull();
    const marker = { runId: 'run-2', seq: 0, connectorId: 'partner-db' };
    await expect(
      mockSend([{ Item: marker }, { Items: [] }]).store.rejections('run-2', { limit: 5 }),
    ).resolves.toEqual({ items: [] });
  });
});

describe('InMemoryConnectorRunStore.record', () => {
  it('stores the run and its rejections for the reader', async () => {
    const store = new InMemoryConnectorRunStore();
    const { agencyId, ...withoutAgency } = RUN;
    await store.record(RUN, [REJECTION]);
    await store.record({ ...withoutAgency, runId: 'run-2', rejected: 0 }, []);
    const runs = await store.query({ from: RUN.startedAt, to: RUN.endedAt }, { limit: 10 });
    expect(runs.items.map((run) => run.runId).sort()).toEqual(['run-1', 'run-2']);
    await expect(store.rejections('run-1', { limit: 10 })).resolves.toEqual({
      items: [REJECTION],
      agencyId,
    });
    await expect(store.rejections('run-2', { limit: 10 })).resolves.toEqual({ items: [] });
  });
});
