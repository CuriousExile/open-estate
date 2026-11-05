import {
  listAgencies,
  previewDeletion,
  previewRemovePlatformAdmin,
  previewSuspension,
  reload,
  type AdminRequester,
} from '../src/app/portal/admin/admin-api';
import {
  actorText,
  apiKeyRequest,
  confirmation,
  countAlarming,
  deletionCriterion,
  EMPTY_AUDIT_FILTERS,
  endpointRows,
  historyRows,
  parseRateLimit,
  platformPeriod,
  sortAlarms,
  toActivityRow,
  toAgencyRow,
  validateAgencyName,
  validateAuditFilters,
  validateEmail,
} from '../src/app/portal/admin/admin-model';
import { validateAgencyFilter } from '../src/app/portal/listings/listing-table-model';
import type { HttpMethod, ManagementRequestOptions } from '../src/app/management/management-client';

interface Call {
  method: HttpMethod;
  path: string;
  options: ManagementRequestOptions<unknown> | undefined;
}

/** Records the calls and answers with `body`, parsed like the real client. */
function fakeApi(body: unknown): { api: AdminRequester; calls: Call[] } {
  const calls: Call[] = [];
  const api: AdminRequester = {
    request<T>(method: HttpMethod, path: string, options?: ManagementRequestOptions<T>) {
      calls.push({ method, path, options: options as ManagementRequestOptions<unknown> });
      const value = options?.parse ? options.parse(body) : (body as T);
      return Promise.resolve({ ok: true as const, value });
    },
  };
  return { api, calls };
}

const series = (code: string, points: { value: number; dims?: Record<string, string> }[]) => ({
  code,
  unit: 'count' as const,
  interval: 'hour' as const,
  points: points.map((p) => ({ t: '2026-11-01T10:00:00.000Z', ...p })),
});

describe('agency overview (Req 10.3)', () => {
  it('shows counts per status, total and suspension', () => {
    const row = toAgencyRow({
      agencyId: 'a1',
      displayName: 'Nord',
      state: 'SUSPENDED',
      createdAt: '2026-01-01T00:00:00Z',
      memberCount: 3,
      listingCounts: { ACTIVE: 4, INACTIVE: 2 },
    });
    expect(row).toMatchObject({ suspended: true, listingTotal: 6, lastChangedAt: undefined });
  });

  it('validates display names and the agency filter', () => {
    expect(validateAgencyName('  Nord  ')).toEqual({ ok: true, value: 'Nord' });
    expect(validateAgencyName(' ')).toMatchObject({ ok: false, params: { min: 1, max: 200 } });
    expect(validateAgencyFilter(' ')).toEqual({ ok: true, agencyId: undefined });
    expect(validateAgencyFilter(' a1 ')).toEqual({ ok: true, agencyId: 'a1' });
    expect(validateAgencyFilter('x'.repeat(129))).toMatchObject({ ok: false });
  });

  it('lists agencies with the state filter', async () => {
    const { api, calls } = fakeApi({ items: [] });
    await listAgencies(api, { state: 'ACTIVE' });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/agencies' });
    expect(calls[0]?.options?.query).toMatchObject({ state: 'ACTIVE' });
  });
});

describe('destructive confirmations (Req 10.8)', () => {
  it('previews with dryRun=true before executing', async () => {
    const preview = { dryRun: true, affectedListings: 12, affectedUsers: 3 };
    const { api, calls } = fakeApi(preview);
    const suspension = await previewSuspension(api, 'a/1');
    await previewDeletion(api, { source: 'crawler' });
    await previewRemovePlatformAdmin(api, 'u1');
    expect(suspension).toEqual({ ok: true, value: preview });
    expect(calls.map((c) => [c.method, c.path, c.options?.query, c.options?.body])).toEqual([
      ['PATCH', '/agencies/a%2F1', { dryRun: 'true' }, { state: 'SUSPENDED' }],
      ['POST', '/platform/deletions', { dryRun: 'true' }, { source: 'crawler' }],
      ['DELETE', '/platform-admins/u1', { dryRun: 'true' }, undefined],
    ]);
  });

  it('states the affected counts of the preview', () => {
    const c = confirmation('suspendAgency', 'Nord', {
      dryRun: true,
      affectedListings: 12,
      affectedUsers: 3,
    });
    expect(c.title).toEqual({
      key: 'portal.admin.confirm.suspendAgency',
      params: { target: 'Nord' },
    });
    expect(c.lines.slice(0, 2)).toEqual([
      { key: 'portal.admin.confirm.affectedListings', params: { count: 12 } },
      { key: 'portal.admin.confirm.affectedUsers', params: { count: 3 } },
    ]);
    expect(confirmation('deletion', 'L-1', { dryRun: true, affectedListings: 0 }).lines[0]).toEqual(
      {
        key: 'portal.admin.confirm.affectedListings',
        params: { count: 0 },
      },
    );
    expect(confirmation('revokeApiKey', 'k1', undefined).lines[0]?.key).toBe(
      'portal.admin.confirm.noPreview',
    );
  });
});

describe('platform monitoring (Req 14.1–14.7)', () => {
  it('builds periods within 1 hour and 30 days', () => {
    const now = new Date('2026-11-05T12:00:00.000Z');
    expect(platformPeriod('1h', now)).toEqual({
      from: '2026-11-05T11:00:00.000Z',
      to: '2026-11-05T12:00:00.000Z',
      interval: 'hour',
    });
    expect(platformPeriod('30d', now)).toMatchObject({
      from: '2026-10-06T12:00:00.000Z',
      interval: 'day',
    });
  });

  it('aggregates per endpoint and marks unavailable metrics', () => {
    const search = { interface: 'search', endpoint: 'GET /listings' };
    const rows = endpointRows([
      series('api.latency_p95', [
        { value: 80, dims: search },
        { value: 120, dims: search },
      ]),
      series('api.requests', [
        { value: 10, dims: search },
        { value: 5, dims: search },
      ]),
      { code: 'api.responses', available: false },
    ]);
    expect(rows).toEqual([
      {
        key: 'search/GET /listings',
        ...search,
        latencyP95: 120,
        requests: 15,
        status4xx: undefined,
        status429: undefined,
        status5xx: undefined,
      },
    ]);
    // A metric missing from the answer counts as not available too.
    expect(
      endpointRows([
        series('api.responses', [{ value: 2, dims: { ...search, statusClass: '5xx' } }]),
      ]),
    ).toEqual([
      expect.objectContaining({
        status5xx: 2,
        status4xx: 0,
        requests: undefined,
        latencyP95: undefined,
      }),
    ]);
  });

  it('lists alarms in state ALARM first', () => {
    const alarms = sortAlarms([
      { name: 'b', state: 'OK' as const, updatedAt: '' },
      { name: 'c', state: 'INSUFFICIENT_DATA' as const, updatedAt: '' },
      { name: 'a', state: 'ALARM' as const, updatedAt: '' },
    ]);
    expect(alarms.map((a) => a.name)).toEqual(['a', 'c', 'b']);
    expect(countAlarming(alarms)).toBe(1);
  });

  it('summarizes agency activity and history size', () => {
    const activity = toActivityRow({
      agencyId: 'a1',
      metrics: [
        series('listing.count', [{ value: 4, dims: { status: 'ACTIVE' } }]),
        { code: 'listing.changes', available: false },
        series('listing.detail_views', [{ value: 2 }, { value: 3 }]),
      ],
    });
    expect(activity.overview.listings).toMatchObject({ available: true });
    expect(activity.overview.changes).toEqual({ available: false });
    expect(activity.detailViews).toBe(5);
    expect(activity.searchImpressions).toBeUndefined();

    const rows = historyRows([
      series('history.version_count', [
        { value: 7, dims: { agency: 'b' } },
        { value: 3, dims: { agency: 'a' } },
        { value: 10 },
      ]),
      { code: 'history.storage_bytes', available: false },
    ]);
    expect(rows).toEqual([
      { agencyId: 'a', versions: 3, bytes: undefined },
      { agencyId: 'b', versions: 7, bytes: undefined },
      { agencyId: undefined, versions: 10, bytes: undefined },
    ]);
  });
});

describe('operations (Req 10.7)', () => {
  it('validates deletion criteria, rate limits, API keys and e-mails', () => {
    expect(deletionCriterion('source', ' crawler ')).toEqual({
      ok: true,
      value: { source: 'crawler' },
    });
    expect(deletionCriterion('listingId', '')).toMatchObject({ ok: false, field: 'deletionValue' });
    expect(parseRateLimit('100', '60')).toEqual({
      ok: true,
      value: { requests: 100, windowSeconds: 60 },
    });
    expect(parseRateLimit('0', '60')).toMatchObject({ ok: false, field: 'requests' });
    expect(parseRateLimit('10', '3601')).toMatchObject({ ok: false, field: 'windowSeconds' });
    expect(parseRateLimit('1.5', '60')).toMatchObject({ ok: false, field: 'requests' });

    const now = new Date('2026-11-05T12:00:00.000Z');
    expect(apiKeyRequest({ expiresAt: '', requests: '', windowSeconds: '' }, now)).toEqual({
      ok: true,
      value: {},
    });
    expect(
      apiKeyRequest({ expiresAt: '2026-11-06T12:00:00Z', requests: '5', windowSeconds: '1' }, now),
    ).toEqual({
      ok: true,
      value: {
        expiresAt: '2026-11-06T12:00:00.000Z',
        rateLimit: { requests: 5, windowSeconds: 1 },
      },
    });
    expect(
      apiKeyRequest({ expiresAt: '2026-11-01T00:00:00Z', requests: '', windowSeconds: '' }, now),
    ).toMatchObject({
      ok: false,
      field: 'expiresAt',
    });
    expect(validateEmail(' a@example.org ')).toEqual({ ok: true, value: 'a@example.org' });
    expect(validateEmail('nope')).toMatchObject({ ok: false });
  });

  it('parses reload outcomes', async () => {
    const functions = [
      { functionName: 'api', status: 'updated', previousConfigVersion: null, configVersion: '1' },
      { functionName: 'mcp', status: 'failed', error: 'denied' },
    ];
    const { api, calls } = fakeApi({ functions });
    expect(await reload(api)).toEqual({ ok: true, value: functions });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/platform/reload' });
  });
});

describe('platform audit log (Req 11.4)', () => {
  it('turns UTC days into the period and rejects reversed periods', () => {
    expect(
      validateAuditFilters({
        ...EMPTY_AUDIT_FILTERS,
        agencyId: ' a1 ',
        from: '2026-11-01',
        to: '2026-11-02',
      }),
    ).toEqual({
      ok: true,
      query: {
        agencyId: 'a1',
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-11-02T23:59:59.999Z',
      },
    });
    expect(validateAuditFilters({ ...EMPTY_AUDIT_FILTERS, from: '2026-02-31' })).toMatchObject({
      ok: false,
      field: 'from',
      messageKey: 'portal.admin.error.date',
    });
    expect(
      validateAuditFilters({ ...EMPTY_AUDIT_FILTERS, from: '2026-11-03', to: '2026-11-02' }),
    ).toMatchObject({ ok: false, field: 'from', messageKey: 'portal.admin.error.reversed' });
  });

  it('names the actor of an entry', () => {
    expect(actorText({ kind: 'user', userId: 'u1', displayName: 'Ada' })).toEqual({
      kindKey: 'portal.admin.auditLog.actor.user',
      name: 'Ada',
    });
    expect(actorText(undefined).kindKey).toBe('portal.admin.auditLog.actor.none');
  });
});
