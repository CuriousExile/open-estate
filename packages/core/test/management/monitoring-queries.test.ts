import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import {
  createMetricDefinitions,
  InMemoryAgencyStore,
  InMemoryAuditService,
  InMemoryConnectorRunStore,
  InMemoryMetricCounterStore,
  MetricCatalog,
  MonitoringQueries,
  MonitoringService,
  type AgencyActor,
  type ManagedListing,
  type ManagedListingQueryStore,
  type MonitoringTimer,
} from '@open-estate/core';
import {
  ConnectorRunsQuery,
  MetricQuery,
  type ConnectorRunView,
  type Principal,
} from '@open-estate/shared';

const NOW = new Date('2026-03-10T12:00:00Z');
const DAY_MS = 86_400_000;

const actor = (principal: Principal, channel: AgencyActor['channel'] = 'PORTAL'): AgencyActor => ({
  principal,
  channel,
});
const member = (agencyId = 'a1') =>
  actor({ kind: 'user', userId: 'm1', displayName: 'M', role: 'AGENCY_MEMBER', agencyId });
const admin = actor(
  { kind: 'user', userId: 'pa', displayName: 'Root', role: 'PLATFORM_ADMIN' },
  'ADMIN',
);

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

/** Manual timer: `fire()` runs all pending callbacks, as if the deadline expired. */
function manualTimer() {
  const pending = new Set<() => void>();
  const timer: MonitoringTimer = (callback) => {
    pending.add(callback);
    return () => pending.delete(callback);
  };
  return {
    timer,
    fire() {
      for (const callback of [...pending]) {
        pending.delete(callback);
        callback();
      }
    },
  };
}

const listingOf = (id: string, agencyId: string) =>
  ({ listing: { id }, management: { agencyId } }) as unknown as ManagedListing;

function setup(alarmsHandler: () => Promise<unknown> = async () => ({})) {
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
  const send = jest
    .spyOn(cloudWatch, 'send')
    .mockImplementation((async () => alarmsHandler()) as never);
  const audit = new InMemoryAuditService();
  const timer = manualTimer();
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
  const monitoring = new MonitoringService({ catalog, audit, timer: timer.timer });
  const queries = new MonitoringQueries({
    monitoring,
    connectorRuns: runs,
    agencies,
    listings: listings as unknown as ManagedListingQueryStore,
    cloudWatch,
    alarmNamePrefix: 'OE-',
    audit,
    clock: () => NOW,
    timer: timer.timer,
  });
  return { queries, counters, runs, send, timer };
}

const PERIOD = MetricQuery.parse({ from: '2026-03-08T00:00:00Z', to: '2026-03-09T12:00:00Z' });

describe('MonitoringQueries.overview', () => {
  it('returns listing counts and 30 days of changes for the own agency', async () => {
    const { queries, counters } = setup();
    await counters.add({ scope: 'agency#a1', code: 'listing.status.ACTIVE', delta: 2 });
    await counters.add({ scope: 'agency#a2', code: 'listing.status.ACTIVE', delta: 9 });
    const result = await queries.overview(member());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [count, changes] = result.value;
    expect(count).toMatchObject({ code: 'listing.count' });
    expect(count && 'points' in count && count.points.map((p) => p.value)).toEqual([2, 0]);
    expect(changes && 'points' in changes && changes.points).toHaveLength(31 * 4);
  });
});

describe('MonitoringQueries.usage', () => {
  it('returns totals and per-listing series of the own agency only', async () => {
    const { queries, counters } = setup();
    const code = 'listing.detail_views';
    await counters.add({ scope: 'agency#a1', code, day: '2026-03-08', delta: 4 });
    await counters.add({ scope: 'listing#l1', code, day: '2026-03-08', delta: 4 });
    const result = await queries.usage(member(), PERIOD, { limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.listings.map((l) => l.listingId)).toEqual(['l1']);
    const [views] = result.value.totals;
    expect(views && 'points' in views && views.points.map((p) => p.value)).toEqual([4, 0]);
  });
});

describe('MonitoringQueries.connectorRuns', () => {
  it('lists the own agency runs of the last 90 days by default', async () => {
    const { queries, runs } = setup();
    runs.putRun(run('r1'));
    runs.putRun(run('r2', { agencyId: 'a2' }));
    runs.putRun(run('r3', { startedAt: new Date(NOW.getTime() - 91 * DAY_MS).toISOString() }));
    const result = await queries.connectorRuns(member(), ConnectorRunsQuery.parse({}));
    expect(result.ok && result.value.items.map((r) => r.runId)).toEqual(['r1']);
  });

  it('filters problem runs (failure or rejections) across agencies for platform admins', async () => {
    const { queries, runs } = setup();
    runs.putRun(run('ok'));
    runs.putRun(run('fail', { status: 'FAILURE', agencyId: 'a2' }));
    runs.putRun(run('rej', { rejected: 2, startedAt: '2026-03-09T11:00:00Z' }));
    const result = await queries.connectorRuns(admin, ConnectorRunsQuery.parse({}), {
      problemsOnly: true,
    });
    expect(result.ok && result.value.items.map((r) => r.runId)).toEqual(['rej', 'fail']);
    const byAgency = await queries.connectorRuns(
      admin,
      ConnectorRunsQuery.parse({ agencyId: 'a2', status: 'FAILURE' }),
    );
    expect(byAgency.ok && byAgency.value.items.map((r) => r.runId)).toEqual(['fail']);
  });

  it('answers another agency with NOT_FOUND', async () => {
    const { queries } = setup();
    const result = await queries.connectorRuns(
      member(),
      ConnectorRunsQuery.parse({ agencyId: 'a2' }),
    );
    expect(!result.ok && result.error.map((e) => e.code)).toEqual(['NOT_FOUND']);
  });
});

describe('MonitoringQueries.runRejections', () => {
  it('returns rejections of an own run and NOT_FOUND for unknown or foreign runs', async () => {
    const { queries, runs } = setup();
    runs.putRun(run('r1', { rejected: 1 }));
    runs.putRun(run('r2', { agencyId: 'a2' }));
    runs.addRejection('r1', { customId: 'C-1', fields: ['price'], reason: 'INVALID' });

    const own = await queries.runRejections(member(), 'r1', { limit: 10 });
    expect(own.ok && own.value.items).toEqual([
      { customId: 'C-1', fields: ['price'], reason: 'INVALID' },
    ]);
    for (const runId of ['r2', 'missing']) {
      const result = await queries.runRejections(member(), runId, { limit: 10 });
      expect(!result.ok && result.error.map((e) => e.code)).toEqual(['NOT_FOUND']);
    }
  });
});

describe('MonitoringQueries platform views', () => {
  it('rejects agency actors', async () => {
    const { queries } = setup();
    const alarms = await queries.alarms(member());
    expect(!alarms.ok && alarms.error.map((e) => e.code)).toEqual(['FORBIDDEN']);
    const activity = await queries.agencyActivity(member(), PERIOD);
    expect(!activity.ok && activity.error.map((e) => e.code)).toEqual(['FORBIDDEN']);
    const platform = await queries.platform(member(), PERIOD);
    expect(!platform.ok && platform.error.map((e) => e.code)).toEqual(['METRIC_NOT_ALLOWED']);
    const history = await queries.historySize(member(), PERIOD);
    expect(!history.ok && history.error.map((e) => e.code)).toEqual(['METRIC_NOT_ALLOWED']);
  });

  it('returns the alarms, or available false when the source misses the deadline', async () => {
    const changed = new Date('2026-03-09T00:00:00Z');
    const { queries } = setup(async () => ({
      MetricAlarms: [
        { AlarmName: 'OE-x', StateValue: 'ALARM', StateTransitionedTimestamp: changed },
      ],
    }));
    await expect(queries.alarms(admin)).resolves.toEqual({
      ok: true,
      value: {
        available: true,
        alarms: [{ name: 'OE-x', state: 'ALARM', updatedAt: changed.toISOString() }],
      },
    });

    const slow = setup(() => new Promise(() => undefined));
    const pending = slow.queries.alarms(admin);
    await Promise.resolve();
    slow.timer.fire();
    await expect(pending).resolves.toEqual({ ok: true, value: { available: false } });
  });

  it('reports activity per agency and the history size per agency and platform-wide', async () => {
    const { queries, counters } = setup();
    await counters.add({ scope: 'agency#a1', code: 'history.version_count', delta: 3 });
    await counters.add({ scope: 'agency#a2', code: 'history.version_count', delta: 4 });
    const activity = await queries.agencyActivity(admin, PERIOD);
    expect(
      activity.ok && activity.value.map((v) => [v.agencyId, v.metrics.map((m) => m.code)]),
    ).toEqual([
      [
        'a1',
        ['listing.changes', 'listing.count', 'listing.detail_views', 'listing.search_impressions'],
      ],
      [
        'a2',
        ['listing.changes', 'listing.count', 'listing.detail_views', 'listing.search_impressions'],
      ],
    ]);
    const history = await queries.historySize(admin, PERIOD);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    const [versions] = history.value;
    expect(versions && 'points' in versions && versions.points.map((p) => p.value)).toEqual([
      3, 4, 0, 7,
    ]);
  });
});
