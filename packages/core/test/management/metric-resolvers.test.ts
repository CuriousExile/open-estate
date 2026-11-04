import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  GetMetricDataCommand,
  ListMetricsCommand,
} from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  createMetricDefinitions,
  describePlatformAlarms,
  DynamoDbMetricCounterStore,
  InMemoryAgencyStore,
  InMemoryConnectorRunStore,
  InMemoryMetricCounterStore,
  MAX_COUNTER_DAYS,
  METRIC_CODES,
  periodDays,
  type ManagedListing,
  type MetricDefinition,
  type MetricResolverDeps,
} from '@open-estate/core';
import { MetricQuery, type ConnectorRunView } from '@open-estate/shared';

const CREATED = '2026-01-01T00:00:00Z';
const agencyRecord = (agencyId: string, state: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') => ({
  agencyId,
  displayName: agencyId,
  state,
  createdAt: CREATED,
  agencyAdmins: 1,
});

/** CloudWatch client whose `send` is answered by `handler`; records the commands. */
function cloudWatchMock(handler: (command: unknown) => unknown = () => ({})) {
  const client = new CloudWatchClient({ region: 'eu-central-1' });
  const commands: unknown[] = [];
  jest.spyOn(client, 'send').mockImplementation((async (command: unknown) => {
    commands.push(command);
    return handler(command);
  }) as never);
  return { client, commands };
}

/** Listing stub: only `management.agencyId` is read by the resolvers. */
const listingOf = (id: string, agencyId?: string) =>
  ({ listing: { id }, management: { agencyId } }) as unknown as ManagedListing;

function setup(
  options: {
    listings?: ManagedListing[];
    cloudWatch?: CloudWatchClient;
  } = {},
) {
  const counters = new InMemoryMetricCounterStore();
  const runs = new InMemoryConnectorRunStore();
  const agencies = new InMemoryAgencyStore([agencyRecord('a1'), agencyRecord('a2', 'SUSPENDED')]);
  const listings = new Map((options.listings ?? []).map((l) => [l.listing.id, l]));
  const deps: MetricResolverDeps = {
    counters,
    agencies,
    listings: { get: async (id: string) => listings.get(id) ?? null },
    connectorRuns: runs,
    cloudWatch: options.cloudWatch ?? cloudWatchMock().client,
    metricsNamespace: 'OpenEstate',
  };
  const definitions = new Map(createMetricDefinitions(deps).map((d) => [d.code, d]));
  const definition = (code: string) => definitions.get(code) as MetricDefinition;
  const resolve = (code: string, query: Record<string, unknown>) =>
    definition(code).resolve(MetricQuery.parse(query), new AbortController().signal);
  return { counters, runs, definitions, resolve };
}

const PERIOD = { from: '2026-03-01T00:00:00Z', to: '2026-03-03T12:00:00Z' };

describe('periodDays', () => {
  it('lists every UTC day touched by the period', () => {
    expect(periodDays(PERIOD)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03']);
  });

  it('cuts long periods to the retained days', () => {
    const days = periodDays({ from: '2025-01-01T00:00:00Z', to: '2026-03-03T00:00:00Z' });
    expect(days).toHaveLength(MAX_COUNTER_DAYS);
    expect(days.at(-1)).toBe('2026-03-03');
  });
});

describe('createMetricDefinitions', () => {
  it('provides the initial catalog with its scopes', () => {
    const { definitions } = setup();
    expect([...definitions.values()].map((d) => [d.code, d.scope])).toEqual([
      ['listing.count', 'agency'],
      ['listing.changes', 'agency'],
      ['listing.detail_views', 'agency'],
      ['listing.search_impressions', 'agency'],
      ['connector.runs', 'agency'],
      ['api.latency_p95', 'platform'],
      ['api.requests', 'platform'],
      ['api.responses', 'platform'],
      ['history.version_count', 'platform'],
      ['history.storage_bytes', 'platform'],
    ]);
  });
});

describe('MetricCounters resolvers', () => {
  it('listing.count: current value per status, agency or platform sum incl. _none', async () => {
    const { counters, resolve } = setup();
    await counters.add({ scope: 'agency#a1', code: 'listing.status.ACTIVE', delta: 3 });
    await counters.add({ scope: 'agency#a2', code: 'listing.status.ACTIVE', delta: 2 });
    await counters.add({ scope: 'agency#_none', code: 'listing.status.INACTIVE', delta: 1 });

    const own = await resolve(METRIC_CODES.listingCount, { ...PERIOD, agencyId: 'a1' });
    expect(own.points).toEqual([
      { t: '2026-03-03T12:00:00.000Z', value: 3, dims: { status: 'ACTIVE' } },
      { t: '2026-03-03T12:00:00.000Z', value: 0, dims: { status: 'INACTIVE' } },
    ]);
    const all = await resolve(METRIC_CODES.listingCount, PERIOD);
    expect(all.points.map((p) => p.value)).toEqual([5, 1]);
  });

  it('listing.changes: one point per day and channel, zero for unwritten days', async () => {
    const { counters, resolve } = setup();
    await counters.add({
      scope: 'agency#a1',
      code: 'listing.changes.IMPORT',
      day: '2026-03-02',
      delta: 4,
    });
    await counters.add({
      scope: 'agency#a1',
      code: 'listing.changes.IMPORT',
      day: '2026-02-01',
      delta: 9,
    });
    const series = await resolve(METRIC_CODES.listingChanges, { ...PERIOD, agencyId: 'a1' });
    expect(series.points).toHaveLength(3 * 4);
    expect(series.points.filter((p) => p.value > 0)).toEqual([
      { t: '2026-03-02T00:00:00.000Z', value: 4, dims: { channel: 'IMPORT' } },
    ]);
  });

  it('usage: agency total per day, listing series, foreign listing without points', async () => {
    const { counters, resolve } = setup({
      listings: [listingOf('l1', 'a1'), listingOf('l2', 'a2')],
    });
    const code = METRIC_CODES.detailViews;
    await counters.add({ scope: 'agency#a1', code, day: '2026-03-01', delta: 7 });
    await counters.add({ scope: 'listing#l1', code, day: '2026-03-01', delta: 5 });
    await counters.add({ scope: 'listing#l2', code, day: '2026-03-01', delta: 2 });

    const total = await resolve(code, { ...PERIOD, agencyId: 'a1' });
    expect(total.points.map((p) => p.value)).toEqual([7, 0, 0]);
    const listing = await resolve(code, { ...PERIOD, agencyId: 'a1', listingId: 'l1' });
    expect(listing.points[0]).toEqual({
      t: '2026-03-01T00:00:00.000Z',
      value: 5,
      dims: { listing: 'l1' },
    });
    const foreign = await resolve(code, { ...PERIOD, agencyId: 'a1', listingId: 'l2' });
    expect(foreign.points).toEqual([]);
    const unknown = await resolve(code, { ...PERIOD, listingId: 'nope' });
    expect(unknown.points).toEqual([]);
  });

  it('history.*: value per agency plus the platform total without dims', async () => {
    const { counters, resolve } = setup();
    await counters.add({ scope: 'agency#a1', code: 'history.storage_bytes', delta: 100 });
    await counters.add({ scope: 'agency#_none', code: 'history.storage_bytes', delta: 20 });
    const all = await resolve(METRIC_CODES.storageBytes, PERIOD);
    expect(all.unit).toBe('bytes');
    expect(all.points.map(({ value, dims }) => [dims?.agency, value])).toEqual([
      ['a1', 100],
      ['a2', 0],
      ['_none', 20],
      [undefined, 120],
    ]);
    const one = await resolve(METRIC_CODES.storageBytes, { ...PERIOD, agencyId: 'a1' });
    expect(one.points.map((p) => p.value)).toEqual([100]);
  });
});

describe('connector.runs', () => {
  const run = (runId: string, overrides: Partial<ConnectorRunView> = {}): ConnectorRunView => ({
    runId,
    connectorId: 'crawler',
    agencyId: 'a1',
    startedAt: '2026-03-01T10:15:00Z',
    status: 'SUCCESS',
    imported: 1,
    updated: 0,
    unchanged: 0,
    rejected: 0,
    ...overrides,
  });

  it('counts runs per interval bucket, connector and status within the agency', async () => {
    const { runs, resolve } = setup();
    runs.putRun(run('r1'));
    runs.putRun(run('r2', { startedAt: '2026-03-01T22:00:00Z' }));
    runs.putRun(run('r3', { status: 'FAILURE' }));
    runs.putRun(run('r4', { agencyId: 'a2' }));
    runs.putRun(run('r5', { startedAt: '2026-02-01T00:00:00Z' }));

    const daily = await resolve(METRIC_CODES.connectorRuns, { ...PERIOD, agencyId: 'a1' });
    expect(daily.points).toEqual([
      {
        t: '2026-03-01T00:00:00.000Z',
        value: 1,
        dims: { connector: 'crawler', status: 'FAILURE' },
      },
      {
        t: '2026-03-01T00:00:00.000Z',
        value: 2,
        dims: { connector: 'crawler', status: 'SUCCESS' },
      },
    ]);
    const hourly = await resolve(METRIC_CODES.connectorRuns, {
      ...PERIOD,
      agencyId: 'a1',
      interval: 'hour',
    });
    expect(hourly.points.map((p) => [p.t, p.value])).toEqual([
      ['2026-03-01T10:00:00.000Z', 1],
      ['2026-03-01T10:00:00.000Z', 1],
      ['2026-03-01T22:00:00.000Z', 1],
    ]);
  });
});

describe('CloudWatch resolvers', () => {
  const t1 = new Date('2026-03-01T00:00:00Z');
  const latencySeries = [
    {
      Dimensions: [
        { Name: 'interface', Value: 'search' },
        { Name: 'endpoint', Value: 'GET /listings' },
      ],
    },
    { Dimensions: [{ Name: 'endpoint', Value: 'old' }] },
  ];
  const countSeries = ['2xx', '4xx', '429', '5xx'].map((statusClass) => ({
    Dimensions: [
      { Name: 'interface', Value: 'search' },
      { Name: 'endpoint', Value: 'GET /listings' },
      { Name: 'statusClass', Value: statusClass },
    ],
  }));
  const countValue: Record<string, number> = { '2xx': 90, '4xx': 8, '429': 3, '5xx': 2 };

  function cloudWatch() {
    return cloudWatchMock((command) => {
      if (command instanceof ListMetricsCommand) {
        return command.input.MetricName === 'RequestCount'
          ? { Metrics: countSeries }
          : { Metrics: latencySeries };
      }
      if (command instanceof GetMetricDataCommand) {
        return {
          MetricDataResults: (command.input.MetricDataQueries ?? []).map((query) => {
            const dims = query.MetricStat?.Metric?.Dimensions ?? [];
            const statusClass = dims.find((d) => d.Name === 'statusClass')?.Value;
            return {
              Id: query.Id,
              Timestamps: [t1],
              Values: [statusClass === undefined ? 123 : (countValue[statusClass] ?? 0)],
            };
          }),
        };
      }
      return {};
    });
  }

  it('api.latency_p95 queries p95 of RequestLatency for series with interface and endpoint', async () => {
    const { client, commands } = cloudWatch();
    const { resolve } = setup({ cloudWatch: client });
    const series = await resolve(METRIC_CODES.latencyP95, PERIOD);
    expect(series.points).toEqual([
      {
        t: t1.toISOString(),
        value: 123,
        dims: { interface: 'search', endpoint: 'GET /listings' },
      },
    ]);
    const data = commands.find((c) => c instanceof GetMetricDataCommand) as GetMetricDataCommand;
    expect(data.input.MetricDataQueries).toEqual([
      expect.objectContaining({
        MetricStat: expect.objectContaining({ Stat: 'p95', Period: 86_400 }),
      }),
    ]);
    expect(data.input.MetricDataQueries?.[0]?.MetricStat?.Metric?.Namespace).toBe('OpenEstate');
  });

  it('api.requests sums all status classes without counting 429 twice', async () => {
    const { client } = cloudWatch();
    const { resolve } = setup({ cloudWatch: client });
    const series = await resolve(METRIC_CODES.requests, PERIOD);
    expect(series.points).toEqual([
      {
        t: t1.toISOString(),
        value: 100,
        dims: { interface: 'search', endpoint: 'GET /listings' },
      },
    ]);
  });

  it('api.responses returns 4xx, 429 and 5xx and honours the endpoint filter', async () => {
    const { client } = cloudWatch();
    const { resolve } = setup({ cloudWatch: client });
    const series = await resolve(METRIC_CODES.responses, PERIOD);
    expect(series.points.map((p) => [p.dims?.statusClass, p.value])).toEqual([
      ['429', 3],
      ['4xx', 8],
      ['5xx', 2],
    ]);
    const filtered = await resolve(METRIC_CODES.responses, { ...PERIOD, endpoint: 'other' });
    expect(filtered.points).toEqual([]);
    const qualified = await resolve(METRIC_CODES.responses, {
      ...PERIOD,
      endpoint: 'search/GET /listings',
    });
    expect(qualified.points).toHaveLength(3);
  });
});

describe('describePlatformAlarms', () => {
  it('reads metric and composite alarms by name prefix over all pages, sorted by name', async () => {
    const changed = new Date('2026-03-01T08:00:00Z');
    const { client, commands } = cloudWatchMock((command) => {
      const input = (command as DescribeAlarmsCommand).input;
      return input.NextToken === undefined
        ? {
            MetricAlarms: [
              { AlarmName: 'OE-b', StateValue: 'ALARM', StateTransitionedTimestamp: changed },
              { StateValue: 'OK' },
            ],
            NextToken: 'next',
          }
        : {
            CompositeAlarms: [
              { AlarmName: 'OE-a', StateValue: 'OK', StateUpdatedTimestamp: changed },
            ],
          };
    });
    const alarms = await describePlatformAlarms(client, 'OE-', new AbortController().signal);
    expect(alarms).toEqual([
      { name: 'OE-a', state: 'OK', updatedAt: changed.toISOString() },
      { name: 'OE-b', state: 'ALARM', updatedAt: changed.toISOString() },
    ]);
    expect(commands).toHaveLength(2);
    expect((commands[0] as DescribeAlarmsCommand).input).toEqual({
      AlarmNamePrefix: 'OE-',
      AlarmTypes: ['MetricAlarm', 'CompositeAlarm'],
      NextToken: undefined,
    });
  });
});

describe('MetricCounterStore.listDays', () => {
  it('in memory: only days of the range, ordered, without current values', async () => {
    const store = new InMemoryMetricCounterStore();
    await store.add({ scope: 's', code: 'c', day: '2026-03-02', delta: 2 });
    await store.add({ scope: 's', code: 'c', day: '2026-03-01', delta: 1 });
    await store.add({ scope: 's', code: 'c', day: '2026-03-09', delta: 9 });
    await store.add({ scope: 's', code: 'c', delta: 5 });
    await store.add({ scope: 's', code: 'cx', day: '2026-03-01', delta: 5 });
    await expect(store.listDays('s', 'c', '2026-03-01', '2026-03-05')).resolves.toEqual([
      { day: '2026-03-01', value: 1 },
      { day: '2026-03-02', value: 2 },
    ]);
    await expect(store.listDays('s', 'c', 'bad', '2026-03-05')).rejects.toThrow();
  });

  it('DynamoDB: one key-range query per page', async () => {
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
    const send = jest
      .spyOn(client, 'send')
      .mockImplementationOnce((async () => ({
        Items: [{ scope: 's', sk: 'c#2026-03-01', value: 1 }],
        LastEvaluatedKey: { scope: 's', sk: 'c#2026-03-01' },
      })) as never)
      .mockImplementationOnce((async () => ({
        Items: [{ scope: 's', sk: 'c#2026-03-02', value: 2 }],
      })) as never);
    const store = new DynamoDbMetricCounterStore({ client, tableName: 'MetricCounters' });
    await expect(store.listDays('s', 'c', '2026-03-01', '2026-03-05')).resolves.toEqual([
      { day: '2026-03-01', value: 1 },
      { day: '2026-03-02', value: 2 },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    const first = send.mock.calls[0]?.[0] as QueryCommand;
    expect(first).toBeInstanceOf(QueryCommand);
    expect(first.input.ExpressionAttributeValues).toEqual({
      ':scope': 's',
      ':from': 'c#2026-03-01',
      ':to': 'c#2026-03-05',
    });
    expect((send.mock.calls[1]?.[0] as QueryCommand).input.ExclusiveStartKey).toEqual({
      scope: 's',
      sk: 'c#2026-03-01',
    });
  });
});
