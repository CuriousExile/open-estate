import { gzipSync } from 'node:zlib';
import type { CloudWatchLogsDecodedData, CloudWatchLogsEvent } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  aggregateUsage,
  createStdoutUsageRecorder,
  createUsageAggregatorHandler,
  dayCounterExpiry,
  decodeLogsEvent,
  DynamoDbMetricCounterStore,
  formatUsageLine,
  InMemoryMetricCounterStore,
  METRIC_COUNTER_DAY_RETENTION_SECONDS,
  parseUsageLine,
  USAGE_COUNTER_CODES,
  type UsageLogEvent,
} from '@open-estate/core';

const T1 = Date.parse('2026-11-03T10:00:00Z');
const T1_LATE = Date.parse('2026-11-03T23:59:59.999Z');
const T2 = Date.parse('2026-11-04T00:00:00Z');

const { detailViews, searchImpressions } = USAGE_COUNTER_CODES;

function logsEvent(
  events: UsageLogEvent[],
  messageType: CloudWatchLogsDecodedData['messageType'] = 'DATA_MESSAGE',
): CloudWatchLogsEvent {
  const data: CloudWatchLogsDecodedData = {
    owner: '123456789012',
    logGroup: '/aws/lambda/api',
    logStream: 'stream',
    subscriptionFilters: ['usage'],
    messageType,
    logEvents: events.map((e, i) => ({ id: String(i), ...e })),
  };
  return { awslogs: { data: gzipSync(JSON.stringify(data)).toString('base64') } };
}

const line = (kind: 'detail' | 'impression', items: { id: string; agencyId?: string }[]) =>
  formatUsageLine(kind, items);

describe('usage line', () => {
  it('round-trips through parseUsageLine, also behind a runtime prefix', () => {
    const text = line('impression', [{ id: 'l-1', agencyId: 'a-1' }, { id: 'l-2' }]);
    const parsed = {
      usage: { kind: 'impression', items: [{ id: 'l-1', agencyId: 'a-1' }, { id: 'l-2' }] },
    };
    expect(parseUsageLine(text)).toEqual(parsed);
    expect(parseUsageLine(`2026-11-03T10:00:00Z\treq-1\tINFO\t${text}\n`)).toEqual(parsed);
  });

  it('copies only id and agencyId of each item', () => {
    const items = [{ id: 'l-1', agencyId: 'a-1', sourceIp: '192.0.2.1', apiKey: 'k' }];
    expect(JSON.parse(formatUsageLine('detail', items))).toEqual({
      usage: { kind: 'detail', items: [{ id: 'l-1', agencyId: 'a-1' }] },
    });
  });

  it.each([
    'START RequestId: 1',
    '{"level":"INFO","message":"x"}',
    '{"usage":{"kind":"click","items":[]}}',
    '{"usage":{"kind":"detail","items":[{"id":""}]}}',
    '{"usage":',
  ])('rejects %s', (message) => {
    expect(parseUsageLine(message)).toBeNull();
  });

  it('stdout recorder writes one line per call with items, none without', () => {
    const write = jest.fn();
    const recorder = createStdoutUsageRecorder(write);
    recorder.record('impression', []);
    recorder.record('detail', [{ id: 'l-1' }]);
    expect(write.mock.calls).toEqual([[`${line('detail', [{ id: 'l-1' }])}\n`]]);
  });

  it('stdout recorder never throws', () => {
    const recorder = createStdoutUsageRecorder(() => {
      throw new Error('EPIPE');
    });
    expect(() => recorder.record('detail', [{ id: 'l-1' }])).not.toThrow();
  });
});

describe('aggregateUsage', () => {
  it('counts per (listing, day) and (agency, day); one increment per key', () => {
    const { increments, lines, skipped } = aggregateUsage([
      {
        timestamp: T1,
        message: line('impression', [{ id: 'l-1', agencyId: 'a-1' }, { id: 'l-2' }]),
      },
      { timestamp: T1_LATE, message: line('impression', [{ id: 'l-1', agencyId: 'a-1' }]) },
      { timestamp: T1, message: line('detail', [{ id: 'l-1', agencyId: 'a-1' }]) },
      { timestamp: T2, message: line('detail', [{ id: 'l-1', agencyId: 'a-1' }]) },
      { timestamp: T2, message: '{"level":"INFO","message":"other"}' },
    ]);
    expect(lines).toBe(4);
    expect(skipped).toBe(1);
    expect(increments).toEqual([
      { scope: 'agency#_none', code: searchImpressions, day: '2026-11-03', delta: 1 },
      { scope: 'agency#a-1', code: detailViews, day: '2026-11-03', delta: 1 },
      { scope: 'agency#a-1', code: detailViews, day: '2026-11-04', delta: 1 },
      { scope: 'agency#a-1', code: searchImpressions, day: '2026-11-03', delta: 2 },
      { scope: 'listing#l-1', code: detailViews, day: '2026-11-03', delta: 1 },
      { scope: 'listing#l-1', code: detailViews, day: '2026-11-04', delta: 1 },
      { scope: 'listing#l-1', code: searchImpressions, day: '2026-11-03', delta: 2 },
      { scope: 'listing#l-2', code: searchImpressions, day: '2026-11-03', delta: 1 },
    ]);
  });
});

describe('UsageAggregator handler', () => {
  it('decodes the gzip+base64 payload and skips control messages', () => {
    const events = [{ timestamp: T1, message: line('detail', [{ id: 'l-1' }]) }];
    expect(decodeLogsEvent(logsEvent(events))).toEqual(events);
    expect(decodeLogsEvent(logsEvent(events, 'CONTROL_MESSAGE'))).toEqual([]);
  });

  it('writes counters the usage resolvers read (listDays per listing and agency)', async () => {
    const counters = new InMemoryMetricCounterStore();
    const handler = createUsageAggregatorHandler({ counters });

    await handler(
      logsEvent([
        { timestamp: T1, message: line('impression', [{ id: 'l-1', agencyId: 'a-1' }]) },
        { timestamp: T1, message: line('impression', [{ id: 'l-2', agencyId: 'a-1' }]) },
      ]),
    );
    // A second batch adds to the same counters.
    const result = await handler(
      logsEvent([{ timestamp: T2, message: line('impression', [{ id: 'l-1', agencyId: 'a-1' }]) }]),
    );

    expect(result).toEqual({ lines: 1, skipped: 0, writes: 2 });
    expect(
      await counters.listDays('agency#a-1', searchImpressions, '2026-11-01', '2026-11-30'),
    ).toEqual([
      { day: '2026-11-03', value: 2 },
      { day: '2026-11-04', value: 1 },
    ]);
    expect(
      await counters.listDays('listing#l-1', searchImpressions, '2026-11-01', '2026-11-30'),
    ).toEqual([
      { day: '2026-11-03', value: 1 },
      { day: '2026-11-04', value: 1 },
    ]);
  });

  it('sends exactly one ADD per counter and batch with a 100-day TTL', async () => {
    const send = jest.fn(async () => ({}));
    const counters = new DynamoDbMetricCounterStore({
      client: { send } as unknown as DynamoDBDocumentClient,
      tableName: 'metric-counters',
    });
    const log = jest.fn();
    const handler = createUsageAggregatorHandler({ counters, log });

    const events = Array.from({ length: 30 }, () => ({
      timestamp: T1,
      message: line('detail', [{ id: 'l-1', agencyId: 'a-1' }]),
    }));
    await handler(logsEvent(events));

    const inputs = send.mock.calls.map(
      (call) => (call as unknown as [{ input: Record<string, unknown> }])[0].input,
    );
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input).toMatchObject({
        TableName: 'metric-counters',
        UpdateExpression: 'ADD #value :delta SET #ttl = :ttl',
        ExpressionAttributeValues: { ':delta': 30, ':ttl': dayCounterExpiry('2026-11-03') },
      });
    }
    expect(inputs.map((i) => i['Key'])).toEqual([
      { scope: 'agency#a-1', sk: `${detailViews}#2026-11-03` },
      { scope: 'listing#l-1', sk: `${detailViews}#2026-11-03` },
    ]);
    expect(dayCounterExpiry('2026-11-03')).toBe(
      Date.parse('2026-11-04T00:00:00Z') / 1000 + METRIC_COUNTER_DAY_RETENTION_SECONDS,
    );
    expect(METRIC_COUNTER_DAY_RETENTION_SECONDS).toBe(100 * 86_400);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ lines: 30, skipped: 0, writes: 2 }));
  });

  it('rejects the batch when a write fails, so Lambda retries it', async () => {
    const counters = {
      add: jest.fn(async () => {
        throw new Error('ProvisionedThroughputExceededException');
      }),
    };
    const handler = createUsageAggregatorHandler({ counters });
    await expect(
      handler(logsEvent([{ timestamp: T1, message: line('detail', [{ id: 'l-1' }]) }])),
    ).rejects.toThrow('ProvisionedThroughputExceededException');
  });
});
