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

export function captureEmf(
  env: Record<string, string> = { POWERTOOLS_METRICS_NAMESPACE: 'OpenEstateTest' },
): {
  metrics: Metrics;
  points: () => LatencyPoint[];
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
  const points = (): LatencyPoint[] =>
    write.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((line) => line.includes('"_aws"'))
      .map((line) => {
        const emf = JSON.parse(line) as Record<string, unknown> & {
          _aws: {
            CloudWatchMetrics: {
              Namespace: string;
              Dimensions: string[][];
              Metrics: { Name: string; Unit: string }[];
            }[];
          };
        };
        const [directive] = emf._aws.CloudWatchMetrics;
        return {
          namespace: directive?.Namespace ?? '',
          dimensionSets: directive?.Dimensions ?? [],
          interface: emf['interface'],
          endpoint: emf['endpoint'],
          latencyMs: emf['RequestLatency'],
          unit: directive?.Metrics.find((m) => m.Name === 'RequestLatency')?.Unit,
        };
      });
  return { metrics, points };
}
