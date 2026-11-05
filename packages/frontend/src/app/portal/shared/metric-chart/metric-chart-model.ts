// Framework-free model of the generic SVG time series (design: `MetricChartComponent`, Req 15.5).
// Turns any uniform `TimeSeries` of the Kennzahlenkatalog into lines, axes and a table fallback.
// Kept free of Angular imports so it can be unit-tested with plain Jest; shared by the agency
// monitoring view and the platform monitoring of the Admin_Modus.
import type { METRIC_INTERVALS, METRIC_UNITS } from '@open-estate/shared';

export type MetricUnit = (typeof METRIC_UNITS)[number];
export type MetricInterval = (typeof METRIC_INTERVALS)[number];

/** Uniform time series as delivered by `GET /metrics/{code}` (Req 15.2). */
export interface TimeSeriesData {
  readonly code: string;
  readonly unit: MetricUnit;
  readonly interval: MetricInterval;
  readonly points: readonly {
    readonly t: string;
    readonly value: number;
    readonly dims?: Readonly<Record<string, string>> | undefined;
  }[];
}

/** A metric whose source did not answer in time (Req 14.7). */
export interface UnavailableMetricData {
  readonly code: string;
  readonly available: false;
}

export type MetricResultData = TimeSeriesData | UnavailableMetricData;

export const isAvailable = (metric: MetricResultData): metric is TimeSeriesData =>
  !('available' in metric);

/** Key of the line that collects the series beyond `maxSeries`. */
export const OTHER_SERIES_KEY = '__other__';

export interface ChartMarker {
  readonly x: number;
  readonly y: number;
  readonly t: string;
  readonly value: number;
}

export interface ChartLine {
  /** Stable key from the dimensions (`channel=API`), `''` without dimensions. */
  readonly key: string;
  /** Dimension values for the legend (`API`, `connector-a · SUCCESS`); `''` without dimensions. */
  readonly label: string;
  /** Palette slot (`0`…`PALETTE_SIZE - 1`). */
  readonly color: number;
  /** SVG path (`M x y L x y …`). */
  readonly path: string;
  readonly markers: readonly ChartMarker[];
  readonly total: number;
}

export interface ChartTick {
  readonly position: number;
  readonly value: number;
}

export interface ChartTimeTick {
  readonly position: number;
  readonly t: string;
}

export interface ChartTable {
  /** One column per line, in line order. */
  readonly columns: readonly { readonly key: string; readonly label: string }[];
  /** One row per timestamp (ascending); `undefined` where a line has no point. */
  readonly rows: readonly {
    readonly t: string;
    readonly values: readonly (number | undefined)[];
  }[];
}

export interface ChartModel {
  readonly width: number;
  readonly height: number;
  /** Plot area inside the axes. */
  readonly plot: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
  readonly lines: readonly ChartLine[];
  readonly yTicks: readonly ChartTick[];
  readonly xTicks: readonly ChartTimeTick[];
  readonly maxValue: number;
  readonly pointCount: number;
  readonly empty: boolean;
  readonly table: ChartTable;
}

export interface ChartOptions {
  readonly width?: number;
  readonly height?: number;
  /** Lines shown individually; further series are summed into {@link OTHER_SERIES_KEY}. */
  readonly maxSeries?: number;
  /** Legend label of the summed line. */
  readonly otherLabel?: string;
  /** Maximum number of labelled time ticks. */
  readonly maxTimeTicks?: number;
}

export const PALETTE_SIZE = 6;

const DEFAULTS = { width: 640, height: 240, maxSeries: 6, otherLabel: '…', maxTimeTicks: 6 };
const MARGIN = { left: 56, top: 12, right: 16, bottom: 28 };
const Y_TICKS = 4;

/** Stable key of a dimension set, independent of the key order. */
export function seriesKey(dims: Readonly<Record<string, string>> | undefined): string {
  if (!dims) return '';
  return Object.keys(dims)
    .sort()
    .map((name) => `${name}=${dims[name]}`)
    .join('|');
}

/** Legend label of a dimension set: the values in key order (`connector-a · SUCCESS`). */
export function seriesLabel(dims: Readonly<Record<string, string>> | undefined): string {
  if (!dims) return '';
  return Object.keys(dims)
    .sort()
    .map((name) => dims[name])
    .join(' · ');
}

/** Smallest "nice" number (1, 2, 5 × 10ⁿ) ≥ `value`; `1` for non-positive values. */
export function niceCeiling(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    const candidate = step * magnitude;
    // Rounding guards against 0.30000000000000004-style results.
    if (candidate >= value - magnitude * 1e-9) return Number(candidate.toPrecision(12));
  }
  return 10 * magnitude;
}

interface Group {
  key: string;
  label: string;
  values: Map<string, number>;
  total: number;
}

function groupPoints(series: TimeSeriesData): Group[] {
  const groups = new Map<string, Group>();
  for (const point of series.points) {
    if (!Number.isFinite(point.value) || Number.isNaN(Date.parse(point.t))) continue;
    const key = seriesKey(point.dims);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: seriesLabel(point.dims), values: new Map(), total: 0 };
      groups.set(key, group);
    }
    group.values.set(point.t, (group.values.get(point.t) ?? 0) + point.value);
    group.total += point.value;
  }
  return [...groups.values()];
}

/** Keeps the `maxSeries - 1` largest lines (in first-seen order) and sums the rest. */
function limitGroups(groups: Group[], maxSeries: number, otherLabel: string): Group[] {
  if (groups.length <= maxSeries) return groups;
  const keep = new Set(
    [...groups]
      .sort((a, b) => b.total - a.total)
      .slice(0, Math.max(maxSeries - 1, 0))
      .map((group) => group.key),
  );
  const other: Group = { key: OTHER_SERIES_KEY, label: otherLabel, values: new Map(), total: 0 };
  for (const group of groups) {
    if (keep.has(group.key)) continue;
    for (const [t, value] of group.values) other.values.set(t, (other.values.get(t) ?? 0) + value);
    other.total += group.total;
  }
  return [...groups.filter((group) => keep.has(group.key)), other];
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** Evenly spread indexes `0…count-1`, at most `max`, always including the first and last. */
function spreadIndexes(count: number, max: number): number[] {
  if (count <= 0) return [];
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  if (max <= 1) return [0];
  const step = (count - 1) / (max - 1);
  return [...new Set(Array.from({ length: max }, (_, i) => Math.round(i * step)))];
}

/** Lines, axes and table of a time series; values below zero are clamped to the axis. */
export function buildChartModel(series: TimeSeriesData, options: ChartOptions = {}): ChartModel {
  const { width, height, maxSeries, otherLabel, maxTimeTicks } = { ...DEFAULTS, ...options };
  const plot = {
    left: MARGIN.left,
    top: MARGIN.top,
    right: width - MARGIN.right,
    bottom: height - MARGIN.bottom,
  };
  const groups = limitGroups(groupPoints(series), Math.max(maxSeries, 1), otherLabel);
  const times = [...new Set(groups.flatMap((group) => [...group.values.keys()]))].sort(
    (a, b) => Date.parse(a) - Date.parse(b),
  );
  const max = Math.max(0, ...groups.flatMap((group) => [...group.values.values()]));
  const maxValue = niceCeiling(max);

  const first = times.length > 0 ? Date.parse(times[0] as string) : 0;
  const last = times.length > 0 ? Date.parse(times[times.length - 1] as string) : 0;
  const xOf = (t: string): number =>
    last === first
      ? (plot.left + plot.right) / 2
      : plot.left + ((Date.parse(t) - first) / (last - first)) * (plot.right - plot.left);
  const yOf = (value: number): number =>
    plot.bottom - (Math.max(value, 0) / maxValue) * (plot.bottom - plot.top);

  const lines: ChartLine[] = groups.map((group, index) => {
    const markers = times
      .filter((t) => group.values.has(t))
      .map((t) => {
        const value = group.values.get(t) as number;
        return { x: round(xOf(t)), y: round(yOf(value)), t, value };
      });
    const path = markers
      .map((marker, i) => `${i === 0 ? 'M' : 'L'}${marker.x} ${marker.y}`)
      .join(' ');
    return {
      key: group.key,
      label: group.label,
      color: index % PALETTE_SIZE,
      path,
      markers,
      total: group.total,
    };
  });

  const yTicks = Array.from({ length: Y_TICKS + 1 }, (_, i) => {
    const value = Number(((maxValue / Y_TICKS) * i).toPrecision(12));
    return { position: round(yOf(value)), value };
  });
  const xTicks = spreadIndexes(times.length, Math.max(maxTimeTicks, 1)).map((i) => {
    const t = times[i] as string;
    return { position: round(xOf(t)), t };
  });

  return {
    width,
    height,
    plot,
    lines,
    yTicks,
    xTicks,
    maxValue,
    pointCount: lines.reduce((sum, line) => sum + line.markers.length, 0),
    empty: times.length === 0,
    table: {
      columns: lines.map(({ key, label }) => ({ key, label })),
      rows: times.map((t) => ({ t, values: groups.map((group) => group.values.get(t)) })),
    },
  };
}

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

/** Value with its unit for `locale` (`1.5 MB`, `120 ms`, `1,234`). */
export function formatMetricValue(value: number, unit: MetricUnit, locale: string): string {
  const lang = locale || undefined;
  if (!Number.isFinite(value)) return String(value);
  if (unit === 'bytes') {
    let scaled = value;
    let index = 0;
    while (Math.abs(scaled) >= 1000 && index < BYTE_UNITS.length - 1) {
      scaled /= 1000;
      index += 1;
    }
    return new Intl.NumberFormat(lang, {
      style: 'unit',
      unit: BYTE_UNITS[index],
      unitDisplay: 'short',
      maximumFractionDigits: index === 0 ? 0 : 1,
    }).format(scaled);
  }
  if (unit === 'milliseconds') {
    return new Intl.NumberFormat(lang, {
      style: 'unit',
      unit: 'millisecond',
      unitDisplay: 'short',
      maximumFractionDigits: 0,
    }).format(value);
  }
  return new Intl.NumberFormat(lang, { maximumFractionDigits: 2 }).format(value);
}

/**
 * Timestamp of a point for `locale`: date for daily series, date and time for hourly ones. Shown
 * in UTC, since days are UTC calendar days (Req 13.4).
 */
export function formatPointTime(t: string, interval: MetricInterval, locale: string): string {
  const date = new Date(t);
  if (Number.isNaN(date.getTime())) return t;
  return new Intl.DateTimeFormat(locale || undefined, {
    timeZone: 'UTC',
    dateStyle: 'medium',
    ...(interval === 'hour' && { timeStyle: 'short' }),
  }).format(date);
}
