import {
  InMemoryAuditService,
  MetricCatalog,
  MONITORING_SOURCE_DEADLINE_MS,
  MonitoringService,
  type AgencyActor,
  type MetricDefinition,
  type MonitoringTimer,
} from '@open-estate/core';
import {
  MetricDefinitionView,
  MetricQuery,
  MetricResult,
  type Principal,
} from '@open-estate/shared';

const actor = (principal: Principal, channel: AgencyActor['channel'] = 'PORTAL'): AgencyActor => ({
  principal,
  channel,
});
const member = (agencyId = 'agy-1') =>
  actor({ kind: 'user', userId: 'm1', displayName: 'M', role: 'AGENCY_MEMBER', agencyId });
const admin = actor(
  { kind: 'user', userId: 'pa', displayName: 'Root', role: 'PLATFORM_ADMIN' },
  'ADMIN',
);
const machineWithout = actor(
  { kind: 'machine', keyId: 'k1', label: 'CRM', agencyId: 'agy-1', permissions: ['listing:read'] },
  'API',
);

const PERIOD = MetricQuery.parse({ from: '2026-03-01T00:00:00Z', to: '2026-03-03T00:00:00Z' });

/** Trivial test definition: one point per day, value = number of resolve calls; records queries. */
function definition(
  code: string,
  overrides: Partial<MetricDefinition> = {},
): MetricDefinition & { queries: MetricQuery[] } {
  const queries: MetricQuery[] = [];
  return {
    code,
    description: `Test metric ${code}`,
    unit: 'count',
    scope: 'agency',
    intervals: ['day'],
    dimensions: ['listing'],
    queries,
    async resolve(q) {
      queries.push(q);
      return {
        code,
        unit: 'count',
        interval: q.interval,
        points: [{ t: q.from, value: queries.length, dims: { agency: q.agencyId ?? '*' } }],
      };
    },
    ...overrides,
  };
}

/** Manual timer: `fire()` runs all pending callbacks, as if the deadline expired. */
function manualTimer() {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 0;
  const timer: MonitoringTimer = (callback, ms) => {
    const id = next++;
    pending.set(id, { callback, ms });
    return () => pending.delete(id);
  };
  return {
    timer,
    pending,
    fire() {
      for (const [id, { callback }] of [...pending]) {
        pending.delete(id);
        callback();
      }
    },
  };
}

function setup(definitions: MetricDefinition[], timer = manualTimer()) {
  const audit = new InMemoryAuditService();
  const service = new MonitoringService({
    catalog: new MetricCatalog(definitions),
    audit,
    timer: timer.timer,
  });
  return { service, audit, timer };
}

describe('MetricCatalog', () => {
  it('rejects duplicate codes and lists by scope in registration order', () => {
    expect(() => new MetricCatalog([definition('a.b'), definition('a.b')])).toThrow(/a\.b/);
    const catalog = new MetricCatalog([
      definition('p.one', { scope: 'platform' }),
      definition('a.one'),
      definition('a.two'),
    ]);
    expect(catalog.list(['agency']).map((d) => d.code)).toEqual(['a.one', 'a.two']);
    expect(catalog.list(['agency', 'platform']).map((d) => d.code)).toEqual([
      'p.one',
      'a.one',
      'a.two',
    ]);
    expect(catalog.get('missing')).toBeUndefined();
  });
});

describe('MonitoringService.catalog', () => {
  const defs = () => [
    definition('listing.count'),
    definition('api.requests', { scope: 'platform' }),
  ];

  it('lists only agency metrics for agency actors and all for Plattform_Admins (Req 15.1)', async () => {
    const { service } = setup(defs());
    const own = await service.catalog(member());
    const all = await service.catalog(admin);
    expect(own).toEqual({
      ok: true,
      value: [
        {
          code: 'listing.count',
          description: 'Test metric listing.count',
          unit: 'count',
          scope: 'agency',
          intervals: ['day'],
          dimensions: ['listing'],
        },
      ],
    });
    expect(all.ok && all.value.map((v) => v.code)).toEqual(['listing.count', 'api.requests']);
    if (all.ok) for (const view of all.value) MetricDefinitionView.parse(view);
  });

  it('rejects actors without monitoring:read with FORBIDDEN and audits it', async () => {
    const { service, audit } = setup(defs());
    const result = await service.catalog(machineWithout);
    expect(!result.ok && result.error.map((e) => e.code)).toEqual(['FORBIDDEN']);
    expect(audit.entries.map((e) => [e.category, e.action, e.result])).toEqual([
      ['access-denied', 'metric.catalog', 'FORBIDDEN'],
    ]);
  });
});

describe('MonitoringService.query', () => {
  it('returns the uniform time series, scoped to the actor agency (Req 15.2, 2.7)', async () => {
    const def = definition('listing.detail_views');
    const { service, timer } = setup([def]);
    const result = await service.query(member(), 'listing.detail_views', PERIOD);
    expect(result).toEqual({
      ok: true,
      value: {
        code: 'listing.detail_views',
        unit: 'count',
        interval: 'day',
        points: [{ t: PERIOD.from, value: 1, dims: { agency: 'agy-1' } }],
      },
    });
    if (result.ok) MetricResult.parse(result.value);
    expect(def.queries[0]?.agencyId).toBe('agy-1');
    expect(timer.pending.size).toBe(0);
  });

  it('lets Plattform_Admins query platform-wide or filter by agency', async () => {
    const def = definition('listing.count');
    const { service } = setup([def]);
    await service.query(admin, 'listing.count', PERIOD);
    await service.query(admin, 'listing.count', { ...PERIOD, agencyId: 'agy-2' });
    expect(def.queries.map((q) => q.agencyId)).toEqual([undefined, 'agy-2']);
  });

  it('answers 400 UNKNOWN_METRIC with the code (Req 15.4)', async () => {
    const { service, audit } = setup([definition('listing.count')]);
    const result = await service.query(member(), 'listing.nope', PERIOD);
    expect(result).toEqual({
      ok: false,
      error: [
        expect.objectContaining({ code: 'UNKNOWN_METRIC', details: { code: 'listing.nope' } }),
      ],
    });
    expect(audit.entries.map((e) => [e.action, e.target, e.result])).toEqual([
      ['metric.get', 'metric/listing.nope', 'UNKNOWN_METRIC'],
    ]);
  });

  it('answers 403 METRIC_NOT_ALLOWED for platform metrics of agency actors (Req 15.4)', async () => {
    const def = definition('api.requests', { scope: 'platform', dimensions: ['endpoint'] });
    const { service } = setup([def]);
    const denied = await service.query(member(), 'api.requests', PERIOD);
    expect(denied).toEqual({
      ok: false,
      error: [
        expect.objectContaining({ code: 'METRIC_NOT_ALLOWED', details: { code: 'api.requests' } }),
      ],
    });
    expect(def.queries).toEqual([]);
    expect((await service.query(admin, 'api.requests', PERIOD)).ok).toBe(true);
  });

  it('answers NOT_FOUND for another agency and FORBIDDEN without monitoring:read', async () => {
    const def = definition('listing.count');
    const { service } = setup([def]);
    const foreign = await service.query(member(), 'listing.count', {
      ...PERIOD,
      agencyId: 'agy-2',
    });
    const missing = await service.query(machineWithout, 'listing.count', PERIOD);
    expect(!foreign.ok && foreign.error[0]?.code).toBe('NOT_FOUND');
    expect(!missing.ok && missing.error[0]?.code).toBe('FORBIDDEN');
    expect(def.queries).toEqual([]);
  });

  it('rejects unsupported intervals and dimension filters with INVALID_PARAMETER', async () => {
    const { service } = setup([definition('listing.count')]);
    const hour = await service.query(admin, 'listing.count', { ...PERIOD, interval: 'hour' });
    const endpoint = await service.query(admin, 'listing.count', { ...PERIOD, endpoint: '/x' });
    expect(!hour.ok && hour.error[0]).toMatchObject({
      code: 'INVALID_PARAMETER',
      field: 'interval',
    });
    expect(!endpoint.ok && endpoint.error[0]).toMatchObject({
      code: 'INVALID_PARAMETER',
      field: 'endpoint',
    });
  });

  it('marks a source as unavailable when the deadline expires and aborts it (Req 14.7)', async () => {
    let signal: AbortSignal | undefined;
    const slow = definition('listing.count', {
      resolve: (_q, s) => {
        signal = s;
        return new Promise(() => undefined);
      },
    });
    const { service, timer } = setup([slow]);
    const pending = service.query(member(), 'listing.count', PERIOD);
    await Promise.resolve();
    expect([...timer.pending.values()].map((t) => t.ms)).toEqual([MONITORING_SOURCE_DEADLINE_MS]);
    timer.fire();
    expect(await pending).toEqual({ ok: true, value: { code: 'listing.count', available: false } });
    expect(signal?.aborted).toBe(true);
  });

  it('marks a failing source as unavailable instead of failing the call', async () => {
    const failing = definition('listing.count', {
      resolve: () => Promise.reject(new Error('down')),
    });
    const { service, timer } = setup([failing]);
    expect(await service.query(member(), 'listing.count', PERIOD)).toEqual({
      ok: true,
      value: { code: 'listing.count', available: false },
    });
    expect(timer.pending.size).toBe(0);
  });
});

describe('MonitoringService.resolveMany', () => {
  it('returns available series and marks only the late sources (Req 14.7)', async () => {
    const slow = definition('listing.changes', { resolve: () => new Promise(() => undefined) });
    const { service, timer } = setup([definition('listing.count'), slow]);
    const pending = service.resolveMany(admin, ['listing.count', 'listing.changes'], PERIOD);
    await new Promise((resolve) => setImmediate(resolve));
    timer.fire();
    const result = await pending;
    expect(result.ok && result.value).toEqual([
      expect.objectContaining({ code: 'listing.count', points: expect.any(Array) }),
      { code: 'listing.changes', available: false },
    ]);
  });

  it('fails before calling any source when one code is rejected', async () => {
    const def = definition('listing.count');
    const { service } = setup([def, definition('api.requests', { scope: 'platform' })]);
    const result = await service.resolveMany(member(), ['listing.count', 'api.requests'], PERIOD);
    expect(!result.ok && result.error[0]?.code).toBe('METRIC_NOT_ALLOWED');
    expect(def.queries).toEqual([]);
  });

  it('uses the real timer by default', async () => {
    const service = new MonitoringService({
      catalog: new MetricCatalog([
        definition('listing.count', { resolve: () => new Promise(() => undefined) }),
      ]),
      audit: new InMemoryAuditService(),
      deadlineMs: 5,
    });
    expect(await service.query(member(), 'listing.count', PERIOD)).toEqual({
      ok: true,
      value: { code: 'listing.count', available: false },
    });
  });
});
