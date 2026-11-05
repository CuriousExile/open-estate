import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import type { SSMClient } from '@aws-sdk/client-ssm';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  createMetricDefinitions,
  InMemoryAgencyStore,
  InMemoryAuditService,
  InMemoryConnectorRunStore,
  InMemoryMetricCounterStore,
  MetricCatalog,
  MonitoringQueries,
  MonitoringService,
  type ManagedListing,
  type ManagedListingQueryStore,
} from '@open-estate/core';
import { createRouter, type Reply } from '@open-estate/management';
import type { ConnectorRunView, Principal } from '@open-estate/shared';
import {
  createMonitoringRouteGroup,
  createMonitoringRoutes,
  MONITORING_ENV,
} from '../src/routes/monitoring';

const NOW = Date.parse('2026-03-10T12:00:00Z');

const platformAdmin: Principal = {
  kind: 'user',
  userId: 'pa',
  displayName: 'Root',
  role: 'PLATFORM_ADMIN',
};
const agencyAdmin = (agencyId = 'a1'): Principal => ({
  kind: 'user',
  userId: `admin-${agencyId}`,
  displayName: 'A',
  role: 'AGENCY_ADMIN',
  agencyId,
});
const member = (agencyId = 'a1'): Principal => ({
  kind: 'user',
  userId: `member-${agencyId}`,
  displayName: 'M',
  role: 'AGENCY_MEMBER',
  agencyId,
});

const agencyRecord = (agencyId: string) => ({
  agencyId,
  displayName: agencyId,
  state: 'ACTIVE' as const,
  createdAt: '2026-01-01T00:00:00Z',
  agencyAdmins: 1,
});

const run = (runId: string, overrides: Partial<ConnectorRunView> = {}): ConnectorRunView => ({
  runId,
  connectorId: 'crawler',
  agencyId: 'a1',
  startedAt: '2026-03-09T10:00:00Z',
  status: 'SUCCESS',
  imported: 1,
  updated: 0,
  unchanged: 0,
  rejected: 0,
  ...overrides,
});

const listingOf = (id: string, agencyId: string) =>
  ({ listing: { id }, management: { agencyId } }) as unknown as ManagedListing;

async function setup() {
  let tick = 0;
  const auditLog = new InMemoryAuditService({ now: () => NOW + tick++ * 1000 });
  const counters = new InMemoryMetricCounterStore();
  const runs = new InMemoryConnectorRunStore();
  const agencies = new InMemoryAgencyStore([agencyRecord('a1'), agencyRecord('a2')]);
  const stored = [listingOf('l1', 'a1'), listingOf('l2', 'a2')];
  const listings = {
    get: async (id: string) => stored.find((l) => l.listing.id === id) ?? null,
    query: async (filter: { agencyId?: string }) => ({
      items: stored.filter(
        (l) => filter.agencyId === undefined || l.management.agencyId === filter.agencyId,
      ),
    }),
  };
  const cloudWatch = new CloudWatchClient({ region: 'eu-central-1' });
  const send = jest.spyOn(cloudWatch, 'send').mockImplementation((async () => ({
    MetricAlarms: [
      {
        AlarmName: 'OE-latency',
        StateValue: 'ALARM',
        StateTransitionedTimestamp: new Date('2026-03-10T11:00:00Z'),
      },
    ],
    Metrics: [],
  })) as never);
  const catalog = new MetricCatalog(
    createMetricDefinitions({
      counters,
      agencies,
      listings,
      connectorRuns: runs,
      cloudWatch,
      metricsNamespace: 'OpenEstate',
    }),
  );
  const monitoring = new MonitoringService({ catalog, audit: auditLog });
  const queries = new MonitoringQueries({
    monitoring,
    connectorRuns: runs,
    agencies,
    listings: listings as unknown as ManagedListingQueryStore,
    cloudWatch,
    alarmNamePrefix: 'OE-',
    audit: auditLog,
    clock: () => new Date(NOW),
  });
  const router = createRouter(
    createMonitoringRoutes({
      auditLog,
      monitoring,
      queries,
      audit: auditLog,
      clock: () => NOW,
    }),
  );

  async function get(
    path: string,
    principal: Principal,
    query: Record<string, string> = {},
  ): Promise<Reply> {
    const found = router.match('GET', path);
    if (found === undefined) throw new Error(`no route for ${path}`);
    return found.route.run(
      { params: found.params, query, body: '', signal: new AbortController().signal },
      principal,
    );
  }

  return { get, auditLog, counters, runs, send };
}

const body = (reply: Reply) => {
  if (reply.kind !== 'success') throw new Error(`expected success, got ${JSON.stringify(reply)}`);
  return reply.body as Record<string, unknown>;
};
const errorCodes = (reply: Reply) =>
  reply.kind === 'failure' ? reply.errors.map((e) => e.code) : [];

const PERIOD = { from: '2026-03-08T00:00:00Z', to: '2026-03-09T12:00:00Z' };

describe('GET /audit-log', () => {
  async function withEntries() {
    const ctx = await setup();
    for (const [agencyId, action] of [
      ['a1', 'listing.update'],
      ['a2', 'agency.update'],
      ['a1', 'member.add'],
    ] as const) {
      await ctx.auditLog.append({
        category: 'management',
        actor: { kind: 'user', userId: 'u1', displayName: 'U' },
        channel: 'PORTAL',
        action,
        target: `x/${action}`,
        agencyId,
        result: 'SUCCESS',
      });
    }
    return ctx;
  }

  it('returns all entries newest first for Plattform_Admins, paged and without category', async () => {
    const { get } = await withEntries();
    const first = body(await get('/audit-log', platformAdmin, { pageSize: '2' }));
    const items = first['items'] as { action: string }[];
    expect(items.map((e) => e.action)).toEqual(['member.add', 'agency.update']);
    expect(items[0]).not.toHaveProperty('category');
    const second = body(
      await get('/audit-log', platformAdmin, {
        pageSize: '2',
        pageToken: first['nextPageToken'] as string,
      }),
    );
    expect((second['items'] as { action: string }[]).map((e) => e.action)).toEqual([
      'listing.update',
    ]);
    expect(second).not.toHaveProperty('nextPageToken');
  });

  it('restricts Agentur_Admins to their own agency (Req 11.5)', async () => {
    const { get } = await withEntries();
    const items = body(await get('/audit-log', agencyAdmin('a1')))['items'] as {
      agencyId: string;
    }[];
    expect(items.map((e) => e.agencyId)).toEqual(['a1', 'a1']);
  });

  it('applies the action filter', async () => {
    const { get } = await withEntries();
    const items = body(await get('/audit-log', platformAdmin, { action: 'agency.update' }))[
      'items'
    ] as unknown[];
    expect(items).toHaveLength(1);
  });

  it('rejects another agency with 404 and audits it, a missing permission with 403', async () => {
    const { get, auditLog } = await withEntries();
    expect(errorCodes(await get('/audit-log', agencyAdmin('a1'), { agencyId: 'a2' }))).toEqual([
      'NOT_FOUND',
    ]);
    expect(auditLog.entries.at(-1)).toMatchObject({
      action: 'audit.query',
      result: 'NOT_FOUND',
      agencyId: 'a1',
    });
    expect(errorCodes(await get('/audit-log', member('a1')))).toEqual(['FORBIDDEN']);
  });

  it('maps an unknown page token to 400 INVALID_PAGE_TOKEN', async () => {
    const { get } = await withEntries();
    expect(errorCodes(await get('/audit-log', platformAdmin, { pageToken: 'bm9wZQ' }))).toEqual([
      'INVALID_PAGE_TOKEN',
    ]);
  });
});

describe('GET /metrics and /metrics/{code}', () => {
  it('lists only agency metrics for agency actors (Req 15.1)', async () => {
    const { get } = await setup();
    const scopes = (reply: Reply) =>
      new Set((body(reply)['metrics'] as { scope: string }[]).map((m) => m.scope));
    expect(scopes(await get('/metrics', member()))).toEqual(new Set(['agency']));
    expect(scopes(await get('/metrics', platformAdmin))).toEqual(new Set(['agency', 'platform']));
  });

  it('returns a time series, 400 for unknown and 403 for platform codes (Req 15.2, 15.4)', async () => {
    const { get, counters } = await setup();
    await counters.add({ scope: 'agency#a1', code: 'listing.status.ACTIVE', delta: 3 });
    const series = body(await get('/metrics/listing.count', member(), PERIOD));
    expect(series).toMatchObject({ code: 'listing.count', unit: 'count', interval: 'day' });
    expect((series['points'] as { value: number }[]).map((p) => p.value)).toEqual([3, 0]);

    const unknown = await get('/metrics/nope.metric', member(), PERIOD);
    expect(unknown).toMatchObject({
      kind: 'failure',
      errors: [{ code: 'UNKNOWN_METRIC', details: { code: 'nope.metric' } }],
    });
    const platform = await get('/metrics/api.requests', member(), PERIOD);
    expect(platform).toMatchObject({
      kind: 'failure',
      errors: [{ code: 'METRIC_NOT_ALLOWED', details: { code: 'api.requests' } }],
    });
  });

  it('validates the period', async () => {
    const { get } = await setup();
    expect(errorCodes(await get('/metrics/listing.count', member(), {}))).toContain(
      'INVALID_PARAMETER',
    );
  });
});

describe('agency monitoring views', () => {
  it('GET /monitoring/overview returns listing counts and changes (Req 13.1)', async () => {
    const { get } = await setup();
    const metrics = body(await get('/monitoring/overview', member()))['metrics'] as {
      code: string;
    }[];
    expect(metrics.map((m) => m.code)).toEqual(['listing.count', 'listing.changes']);
  });

  it('GET /monitoring/connector-runs is agency-scoped and filters problem runs', async () => {
    const { get, runs } = await setup();
    runs.putRun(run('r1'));
    runs.putRun(run('r2', { status: 'FAILURE', startedAt: '2026-03-09T11:00:00Z' }));
    runs.putRun(run('r3', { agencyId: 'a2' }));
    const ids = (reply: Reply) => (body(reply)['items'] as { runId: string }[]).map((r) => r.runId);
    expect(ids(await get('/monitoring/connector-runs', member()))).toEqual(['r2', 'r1']);
    expect(
      ids(await get('/monitoring/connector-runs', member(), { problemsOnly: 'true' })),
    ).toEqual(['r2']);
    expect(ids(await get('/monitoring/connector-runs', platformAdmin, { agencyId: 'a2' }))).toEqual(
      ['r3'],
    );
    expect(
      errorCodes(await get('/monitoring/connector-runs', member(), { agencyId: 'a2' })),
    ).toEqual(['NOT_FOUND']);
  });

  it('GET /monitoring/connector-runs/{runId}/rejections hides runs of other agencies', async () => {
    const { get, runs } = await setup();
    await runs.record(run('r1', { rejected: 1 }), [
      { listingId: 'l1', fields: ['price'], reason: 'invalid' },
    ]);
    const items = body(await get('/monitoring/connector-runs/r1/rejections', member()))['items'];
    expect(items).toEqual([{ listingId: 'l1', fields: ['price'], reason: 'invalid' }]);
    expect(errorCodes(await get('/monitoring/connector-runs/r1/rejections', member('a2')))).toEqual(
      ['NOT_FOUND'],
    );
  });

  it('GET /monitoring/usage returns totals and per-listing series (Req 13.5)', async () => {
    const { get, counters } = await setup();
    await counters.add({
      scope: 'listing#l1',
      code: 'listing.detail_views',
      day: '2026-03-09',
      delta: 4,
    });
    const view = body(await get('/monitoring/usage', member(), PERIOD));
    expect((view['totals'] as { code: string }[]).map((m) => m.code)).toEqual([
      'listing.detail_views',
      'listing.search_impressions',
    ]);
    const listings = view['listings'] as { listingId: string; metrics: { points: unknown[] }[] }[];
    expect(listings.map((l) => l.listingId)).toEqual(['l1']);
    expect(listings[0]?.metrics[0]?.points).toContainEqual({
      t: '2026-03-09T00:00:00.000Z',
      value: 4,
      dims: { listing: 'l1' },
    });
  });

  it('GET /monitoring/usage rejects periods over 90 days', async () => {
    const { get } = await setup();
    const reply = await get('/monitoring/usage', member(), {
      from: '2025-12-01T00:00:00Z',
      to: '2026-03-09T00:00:00Z',
    });
    expect(reply).toMatchObject({
      kind: 'failure',
      errors: [{ code: 'INVALID_RANGE', field: 'from' }],
    });
  });
});

describe('platform monitoring views', () => {
  it('reject agency actors with 403', async () => {
    const { get } = await setup();
    expect(errorCodes(await get('/monitoring/alarms', member()))).toEqual(['FORBIDDEN']);
    expect(errorCodes(await get('/monitoring/agency-activity', member(), PERIOD))).toEqual([
      'FORBIDDEN',
    ]);
    expect(errorCodes(await get('/monitoring/history-size', member()))).toEqual([
      'METRIC_NOT_ALLOWED',
    ]);
  });

  it('GET /monitoring/platform enforces 1 hour to 30 days (Req 14.1)', async () => {
    const { get } = await setup();
    const short = await get('/monitoring/platform', platformAdmin, {
      from: '2026-03-09T10:00:00Z',
      to: '2026-03-09T10:30:00Z',
    });
    expect(errorCodes(short)).toEqual(['INVALID_RANGE']);
    const metrics = body(await get('/monitoring/platform', platformAdmin, PERIOD))['metrics'] as {
      code: string;
    }[];
    expect(metrics.map((m) => m.code)).toEqual([
      'api.latency_p95',
      'api.requests',
      'api.responses',
    ]);
  });

  it('GET /monitoring/alarms returns alarm states (Req 14.2)', async () => {
    const { get } = await setup();
    expect(body(await get('/monitoring/alarms', platformAdmin))).toEqual({
      available: true,
      alarms: [{ name: 'OE-latency', state: 'ALARM', updatedAt: '2026-03-10T11:00:00.000Z' }],
    });
  });

  it('GET /monitoring/agency-activity returns one entry per agency (Req 14.4)', async () => {
    const { get } = await setup();
    const agencies = body(await get('/monitoring/agency-activity', platformAdmin, PERIOD))[
      'agencies'
    ] as { agencyId: string; metrics: unknown[] }[];
    expect(agencies.map((a) => a.agencyId)).toEqual(['a1', 'a2']);
    expect(agencies[0]?.metrics).toHaveLength(4);
  });

  it('GET /monitoring/history-size returns per-agency values and the total (Req 14.5)', async () => {
    const { get, counters } = await setup();
    await counters.add({ scope: 'agency#a1', code: 'history.version_count', delta: 5 });
    const [count] = body(await get('/monitoring/history-size', platformAdmin))['metrics'] as {
      points: { value: number; dims?: Record<string, string>; t: string }[];
    }[];
    expect(count?.points.at(-1)).toEqual({ t: '2026-03-10T12:00:00.000Z', value: 5 });
    expect(count?.points[0]).toMatchObject({ value: 5, dims: { agency: 'a1' } });
  });
});

describe('monitoringRoutes group', () => {
  const env = Object.fromEntries(
    [...Object.values(MONITORING_ENV), 'AGENCIES_TABLE_NAME', 'AUDIT_LOG_TABLE_NAME'].map(
      (name) => [name, `${name.toLowerCase()}-value`],
    ),
  );
  const context = (values: Record<string, string | undefined>) => ({
    env: values,
    clients: { dynamo: {} as DynamoDBDocumentClient, ssm: {} as SSMClient },
    shared: {
      frontendOrigin: 'https://example.org',
      audit: new InMemoryAuditService(),
      clock: () => NOW,
    },
  });
  const group = createMonitoringRouteGroup({
    cloudWatch: new CloudWatchClient({ region: 'eu-central-1' }),
  });

  it('registers every audit, monitoring and metric route', () => {
    expect(group.create(context(env)).map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /audit-log',
      'GET /monitoring/overview',
      'GET /monitoring/connector-runs',
      'GET /monitoring/connector-runs/{runId}/rejections',
      'GET /monitoring/usage',
      'GET /monitoring/platform',
      'GET /monitoring/alarms',
      'GET /monitoring/agency-activity',
      'GET /monitoring/history-size',
      'GET /metrics',
      'GET /metrics/{code}',
    ]);
  });

  it('names every missing variable', () => {
    const partial = { ...env, METRICS_NAMESPACE: undefined, ALARM_NAME_PREFIX: ' ' };
    expect(() => group.create(context(partial))).toThrow(
      expect.objectContaining({ names: ['METRICS_NAMESPACE', 'ALARM_NAME_PREFIX'] }) as Error,
    );
  });
});
