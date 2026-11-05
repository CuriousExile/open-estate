import {
  buildChartModel,
  formatMetricValue,
  formatPointTime,
  isAvailable,
  niceCeiling,
  OTHER_SERIES_KEY,
  seriesKey,
  seriesLabel,
  type TimeSeriesData,
} from '../src/app/portal/shared/metric-chart/metric-chart-model';

const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`;

const series = (points: TimeSeriesData['points'], unit: TimeSeriesData['unit'] = 'count') => ({
  code: 'connector.runs',
  unit,
  interval: 'day' as const,
  points,
});

describe('generic time series (MetricChartComponent model, Req 15.5)', () => {
  it('distinguishes available series from unavailable metrics (Req 14.7)', () => {
    expect(isAvailable(series([]))).toBe(true);
    expect(isAvailable({ code: 'connector.runs', available: false })).toBe(false);
  });

  it('keys and labels dimension sets independent of key order', () => {
    expect(seriesKey({ status: 'SUCCESS', connector: 'a' })).toBe('connector=a|status=SUCCESS');
    expect(seriesKey({ connector: 'a', status: 'SUCCESS' })).toBe('connector=a|status=SUCCESS');
    expect(seriesLabel({ status: 'SUCCESS', connector: 'a' })).toBe('a · SUCCESS');
    expect(seriesKey(undefined)).toBe('');
  });

  it('rounds the axis maximum up to 1, 2 or 5 × 10ⁿ', () => {
    expect(niceCeiling(0)).toBe(1);
    expect(niceCeiling(1)).toBe(1);
    expect(niceCeiling(3)).toBe(5);
    expect(niceCeiling(7)).toBe(10);
    expect(niceCeiling(120)).toBe(200);
    expect(niceCeiling(0.3)).toBe(0.5);
  });

  it('builds one line per dimension set with points in time order', () => {
    const model = buildChartModel(
      series([
        { t: day(2), value: 4, dims: { channel: 'API' } },
        { t: day(1), value: 2, dims: { channel: 'API' } },
        { t: day(1), value: 1, dims: { channel: 'PORTAL' } },
      ]),
      { width: 200, height: 100 },
    );
    expect(model.empty).toBe(false);
    expect(model.lines.map((l) => l.label)).toEqual(['API', 'PORTAL']);
    expect(model.maxValue).toBe(5);
    const [api] = model.lines;
    expect(api?.markers.map((m) => m.t)).toEqual([day(1), day(2)]);
    // First point at the left edge, last at the right edge of the plot.
    expect(api?.markers[0]?.x).toBe(model.plot.left);
    expect(api?.markers[1]?.x).toBe(model.plot.right);
    // Higher values sit higher (smaller y); 0 would be the bottom.
    expect(api?.markers[1]?.y).toBeLessThan(api?.markers[0]?.y ?? 0);
    expect(api?.path).toMatch(/^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);
    expect(model.pointCount).toBe(3);
  });

  it('offers every value as a table with one row per timestamp (accessible fallback)', () => {
    const model = buildChartModel(
      series([
        { t: day(1), value: 2, dims: { channel: 'API' } },
        { t: day(2), value: 4, dims: { channel: 'API' } },
        { t: day(2), value: 1, dims: { channel: 'PORTAL' } },
      ]),
    );
    expect(model.table.columns.map((c) => c.label)).toEqual(['API', 'PORTAL']);
    expect(model.table.rows).toEqual([
      { t: day(1), values: [2, undefined] },
      { t: day(2), values: [4, 1] },
    ]);
  });

  it('sums series beyond maxSeries into one "other" line', () => {
    const points = ['a', 'b', 'c', 'd'].map((connector, i) => ({
      t: day(1),
      value: i + 1,
      dims: { connector },
    }));
    const model = buildChartModel(series(points), { maxSeries: 3, otherLabel: 'Other' });
    expect(model.lines.map((l) => l.key)).toEqual(['connector=c', 'connector=d', OTHER_SERIES_KEY]);
    expect(model.lines[2]).toMatchObject({ label: 'Other', total: 3 });
  });

  it('centres a single timestamp and reports an empty series', () => {
    const single = buildChartModel(series([{ t: day(1), value: 0 }]), { width: 200 });
    expect(single.lines[0]?.markers[0]?.x).toBe((single.plot.left + single.plot.right) / 2);
    expect(single.lines[0]?.markers[0]?.y).toBe(single.plot.bottom);
    expect(single.maxValue).toBe(1);
    expect(buildChartModel(series([])).empty).toBe(true);
  });

  it('labels at most maxTimeTicks timestamps including the first and last', () => {
    const points = Array.from({ length: 30 }, (_, i) => ({ t: day(i + 1), value: i }));
    const { xTicks } = buildChartModel(series(points), { maxTimeTicks: 5 });
    expect(xTicks).toHaveLength(5);
    expect(xTicks[0]?.t).toBe(day(1));
    expect(xTicks[4]?.t).toBe(day(30));
  });

  it('formats values with their unit', () => {
    expect(formatMetricValue(1234, 'count', 'en')).toBe('1,234');
    expect(formatMetricValue(1234, 'count', 'de')).toBe('1.234');
    expect(formatMetricValue(1_500_000, 'bytes', 'en')).toBe('1.5 MB');
    expect(formatMetricValue(512, 'bytes', 'en')).toBe('512 byte');
    expect(formatMetricValue(120, 'milliseconds', 'en')).toBe('120 ms');
  });

  it('shows timestamps as UTC days, with time for hourly series', () => {
    expect(formatPointTime('2026-10-01T23:30:00.000Z', 'day', 'en')).toBe('Oct 1, 2026');
    expect(formatPointTime('2026-10-01T23:30:00.000Z', 'hour', 'en')).toMatch(/11:30/);
    expect(formatPointTime('not a date', 'day', 'en')).toBe('not a date');
  });
});
