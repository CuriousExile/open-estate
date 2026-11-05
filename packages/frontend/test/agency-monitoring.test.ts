import de from '../public/i18n/de.json';
import en from '../public/i18n/en.json';
import type { ManagementRequestOptions } from '../src/app/management/management-client';
import {
  defaultPeriod,
  genericMetrics,
  isProblemRun,
  OWN_VIEW_CODES,
  periodErrorKey,
  preferredInterval,
  resolvePeriod,
  summarizeOverview,
  toRejectionRow,
  toRunRow,
  totalOf,
  usageListingRows,
  usageTotals,
  type MetricDefinitionData,
} from '../src/app/portal/monitoring/agency-monitoring-model';
import {
  fetchConnectorRuns,
  fetchMetric,
  fetchOverview,
  fetchRejections,
  fetchUsage,
  type MonitoringGetter,
} from '../src/app/portal/monitoring/monitoring-api';

const T = '2026-11-05T12:00:00.000Z';

describe('agency monitoring overview (Req 13.1, 13.6)', () => {
  it('counts listings per status and changes per channel', () => {
    const summary = summarizeOverview([
      {
        code: 'listing.count',
        unit: 'count',
        interval: 'day',
        points: [
          { t: T, value: 7, dims: { status: 'ACTIVE' } },
          { t: T, value: 2, dims: { status: 'INACTIVE' } },
        ],
      },
      {
        code: 'listing.changes',
        unit: 'count',
        interval: 'day',
        points: [
          { t: '2026-11-04T00:00:00.000Z', value: 3, dims: { channel: 'PORTAL' } },
          { t: '2026-11-05T00:00:00.000Z', value: 1, dims: { channel: 'PORTAL' } },
          { t: '2026-11-05T00:00:00.000Z', value: 5, dims: { channel: 'IMPORT' } },
        ],
      },
    ]);
    expect(summary.listings).toEqual({
      available: true,
      value: { byStatus: { ACTIVE: 7, INACTIVE: 2 }, total: 9 },
    });
    expect(summary.changes).toEqual({
      available: true,
      value: { byChannel: { PORTAL: 4, API: 0, IMPORT: 5, ADMIN: 0 }, total: 9 },
    });
  });

  it('marks slow or missing metrics as not available (Req 14.7)', () => {
    const summary = summarizeOverview([{ code: 'listing.count', available: false }]);
    expect(summary.listings).toEqual({ available: false });
    expect(summary.changes).toEqual({ available: false });
  });
});

describe('connector runs (Req 13.2, 13.3, 13.6)', () => {
  const run = {
    runId: 'r1',
    connectorId: 'openimmo',
    startedAt: '2026-11-05T10:00:00.000Z',
    status: 'SUCCESS',
    imported: 1,
    updated: 2,
    unchanged: 3,
    rejected: 0,
  };

  it('flags runs with status FAILURE or rejections as problems', () => {
    expect(isProblemRun(run)).toBe(false);
    expect(isProblemRun({ ...run, rejected: 1 })).toBe(true);
    expect(isProblemRun({ ...run, status: 'FAILURE' })).toBe(true);
  });

  it('maps a run to a row with translated status and running state', () => {
    const row = toRunRow({ ...run, status: 'FAILURE' }, 'en');
    expect(row).toMatchObject({
      connectorId: 'openimmo',
      statusKey: 'portal.monitoring.runs.status.FAILURE',
      ended: undefined,
      failed: true,
      problem: true,
      counts: { imported: 1, updated: 2, unchanged: 3, rejected: 0 },
    });
    expect(toRunRow({ ...run, status: 'CUSTOM' }, 'en').statusKey).toBeUndefined();
    expect(toRunRow({ ...run, endedAt: '2026-11-05T10:05:00.000Z' }, 'en').ended).toBeDefined();
  });

  it('shows the Custom_Id before the listing id and the field names of a rejection', () => {
    expect(
      toRejectionRow({ listingId: 'l1', customId: 'C-1', fields: ['price', 'area'], reason: 'x' }),
    ).toEqual({ identifier: 'C-1', fields: 'price, area', reason: 'x' });
    expect(toRejectionRow({ fields: [], reason: 'x' }).identifier).toBeUndefined();
  });
});

describe('usage period (Req 13.5)', () => {
  it('preselects the last 30 UTC days including today', () => {
    expect(defaultPeriod(new Date('2026-11-05T23:30:00.000Z'))).toEqual({
      from: '2026-10-07',
      to: '2026-11-05',
    });
  });

  it('resolves 1 to 90 days to whole UTC days', () => {
    expect(resolvePeriod({ from: '2026-11-05', to: '2026-11-05' })).toEqual({
      ok: true,
      from: '2026-11-05T00:00:00.000Z',
      to: '2026-11-05T23:59:59.999Z',
      days: 1,
    });
    const ninety = resolvePeriod({ from: '2026-08-08', to: '2026-11-05' });
    expect(ninety).toMatchObject({ ok: true, days: 90 });
  });

  it('rejects invalid, reversed and too long periods', () => {
    expect(resolvePeriod({ from: '', to: '2026-11-05' })).toEqual({ ok: false, error: 'invalid' });
    expect(resolvePeriod({ from: '2026-02-31', to: '2026-03-05' })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(resolvePeriod({ from: '2026-11-06', to: '2026-11-05' })).toEqual({
      ok: false,
      error: 'reversed',
    });
    expect(resolvePeriod({ from: '2026-08-07', to: '2026-11-05' })).toEqual({
      ok: false,
      error: 'tooLong',
    });
  });

  it('sums the usage per listing and keeps unavailable metrics apart', () => {
    const view = {
      totals: [
        {
          code: 'listing.detail_views',
          unit: 'count' as const,
          interval: 'day' as const,
          points: [
            { t: T, value: 2 },
            { t: T, value: 3 },
          ],
        },
      ],
      listings: [
        {
          listingId: 'l1',
          metrics: [
            {
              code: 'listing.search_impressions',
              unit: 'count' as const,
              interval: 'day' as const,
              points: [{ t: T, value: 9, dims: { listing: 'l1' } }],
            },
            { code: 'listing.detail_views', available: false as const },
          ],
        },
      ],
    };
    const totals = usageTotals(view);
    expect(totalOf(totals.detailViews)).toBe(5);
    expect(totals.searchImpressions).toEqual({
      code: 'listing.search_impressions',
      available: false,
    });
    expect(usageListingRows(view)).toEqual([
      { listingId: 'l1', detailViews: undefined, searchImpressions: 9 },
    ]);
  });
});

describe('generic catalog metrics (Req 15.5)', () => {
  const definition = (
    code: string,
    overrides: Partial<MetricDefinitionData> = {},
  ): MetricDefinitionData => ({
    code,
    description: code,
    scope: 'agency',
    intervals: ['hour', 'day'],
    ...overrides,
  });

  it('lists every agency metric without an own view, including new ones', () => {
    const catalog = [
      ...OWN_VIEW_CODES.map((code) => definition(code)),
      definition('connector.runs'),
      definition('api.requests', { scope: 'platform' }),
      definition('listing.future_metric'),
    ];
    expect(genericMetrics(catalog).map((m) => m.code)).toEqual([
      'connector.runs',
      'listing.future_metric',
    ]);
  });

  it('prefers daily aggregation', () => {
    expect(preferredInterval(definition('a'))).toBe('day');
    expect(preferredInterval(definition('a', { intervals: ['hour'] }))).toBe('hour');
  });
});

describe('monitoring API calls', () => {
  function getter(body: unknown) {
    const calls: { path: string; options: Omit<ManagementRequestOptions<unknown>, 'body'> }[] = [];
    const api: MonitoringGetter = {
      get: (path, options = {}) => {
        calls.push({ path, options: options as never });
        try {
          const parse = options.parse ?? ((value: unknown) => value as never);
          return Promise.resolve({ ok: true, value: parse(body) });
        } catch (error) {
          return Promise.resolve({
            ok: false,
            error: { kind: 'invalid-response', status: 200, message: String(error) },
          });
        }
      },
    };
    return { api, calls };
  }

  it('reads the overview metrics including unavailable ones', async () => {
    const { api, calls } = getter({
      metrics: [{ code: 'listing.count', available: false }],
    });
    const result = await fetchOverview(api);
    expect(calls[0]?.path).toBe('/monitoring/overview');
    expect(result).toEqual({ ok: true, value: [{ code: 'listing.count', available: false }] });
  });

  it('asks only for problem runs when filtered', async () => {
    const { api, calls } = getter({ items: [] });
    await fetchConnectorRuns(api, { problemsOnly: true, pageToken: 'p2' });
    await fetchConnectorRuns(api, { problemsOnly: false });
    expect(calls[0]?.options.query).toEqual({ problemsOnly: 'true', pageToken: 'p2' });
    expect(calls[1]?.options.query).toEqual({ problemsOnly: undefined, pageToken: undefined });
  });

  it('encodes run ids and metric codes in the path', async () => {
    const { api, calls } = getter({ items: [] });
    await fetchRejections(api, 'run/1');
    expect(calls[0]?.path).toBe('/monitoring/connector-runs/run%2F1/rejections');
    const metric = getter({ code: 'connector.runs', unit: 'count', interval: 'day', points: [] });
    await fetchMetric(metric.api, 'connector.runs', {
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-05T23:59:59.999Z',
      interval: 'day',
    });
    expect(metric.calls[0]).toMatchObject({
      path: '/metrics/connector.runs',
      options: {
        query: {
          from: '2026-11-01T00:00:00.000Z',
          to: '2026-11-05T23:59:59.999Z',
          interval: 'day',
        },
      },
    });
  });

  it('rejects a usage response of the wrong shape', async () => {
    const { api } = getter({ totals: 'nope' });
    const result = await fetchUsage(api, { from: T, to: T });
    expect(result.ok).toBe(false);
  });
});

describe('monitoring translations', () => {
  const keys = (file: Record<string, string>) =>
    Object.keys(file)
      .filter((key) => key.startsWith('portal.monitoring.'))
      .sort();

  it('has every monitoring key in English and German', () => {
    expect(keys(de)).toEqual(keys(en));
  });

  it('has the period error and run status keys', () => {
    const file = en as Record<string, string>;
    for (const error of ['invalid', 'reversed', 'tooLong'] as const) {
      expect(file[periodErrorKey(error)]).toBeTruthy();
    }
    expect(file[toRunRow({ ...runFor('SUCCESS') }, 'en').statusKey ?? '']).toBeTruthy();
    expect(file[toRunRow({ ...runFor('FAILURE') }, 'en').statusKey ?? '']).toBeTruthy();
  });
});

function runFor(status: string) {
  return {
    runId: 'r',
    connectorId: 'c',
    startedAt: T,
    status,
    imported: 0,
    updated: 0,
    unchanged: 0,
    rejected: 0,
  };
}
