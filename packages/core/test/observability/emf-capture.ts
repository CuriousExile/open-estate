import { createMetrics, type Metrics } from '@open-estate/core';

// Test helper: a real Powertools `Metrics` with EMF output enabled (jest.setup disables it
// globally) and the EMF lines written to stdout captured and parsed.

export interface LatencyPoint {
  namespace: string;
  dimensionSets: string[][];
  interface: unknown;
  endpoint: unknown;
  latencyMs: unknown;
  unit: unknown;
}

export interface CountPoint {
  namespace: string;
  dimensionSets: string[][];
  interface: unknown;
  endpoint: unknown;
  statusClass: unknown;
  count: unknown;
  unit: unknown;
}

type EmfLine = Record<string, unknown> & {
  _aws: {
    CloudWatchMetrics: {
      Namespace: string;
      Dimensions: string[][];
      Metrics: { Name: string; Unit: string }[];
    }[];
  };
};

export function captureEmf(
  env: Record<string, string> = { POWERTOOLS_METRICS_NAMESPACE: 'OpenEstateTest' },
): {
  metrics: Metrics;
  /** `RequestLatency` data points in emission order. */
  points: () => LatencyPoint[];
  /** `RequestCount` data points in emission order. */
  countPoints: () => CountPoint[];
  /** Every line written to stdout (EMF and usage lines). */
  lines: () => string[];
} {
  const previous = process.env['POWERTOOLS_METRICS_DISABLED'];
  process.env['POWERTOOLS_METRICS_DISABLED'] = 'false';
  let metrics: Metrics;
  try {
    metrics = createMetrics('test', env);
  } finally {
    process.env['POWERTOOLS_METRICS_DISABLED'] = previous;
  }
  const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const lines = () => write.mock.calls.map(([chunk]) => String(chunk));
  const emf = (metric: string) =>
    lines()
      .filter((line) => line.includes('"_aws"'))
      .map((line) => JSON.parse(line) as EmfLine)
      .filter((line) => metric in line);
  const points = (): LatencyPoint[] =>
    emf('RequestLatency').map((line) => {
      const [directive] = line._aws.CloudWatchMetrics;
      return {
        namespace: directive?.Namespace ?? '',
        dimensionSets: directive?.Dimensions ?? [],
        interface: line['interface'],
        endpoint: line['endpoint'],
        latencyMs: line['RequestLatency'],
        unit: directive?.Metrics.find((m) => m.Name === 'RequestLatency')?.Unit,
      };
    });
  const countPoints = (): CountPoint[] =>
    emf('RequestCount').map((line) => {
      const [directive] = line._aws.CloudWatchMetrics;
      return {
        namespace: directive?.Namespace ?? '',
        dimensionSets: directive?.Dimensions ?? [],
        interface: line['interface'],
        endpoint: line['endpoint'],
        statusClass: line['statusClass'],
        count: line['RequestCount'],
        unit: directive?.Metrics.find((m) => m.Name === 'RequestCount')?.Unit,
      };
    });
  return { metrics, points, countPoints, lines };
}
