import { createHash } from 'node:crypto';
import {
  DescribeAlarmsCommand,
  GetMetricDataCommand,
  ListMetricsCommand,
  type CloudWatchClient,
  type Dimension,
} from '@aws-sdk/client-cloudwatch';
import {
  MONITORED_REQUEST_COUNT_METRIC,
  REQUEST_LATENCY_METRIC,
  REQUEST_STATUS_CLASSES,
  type Clock,
} from '@open-estate/core';

// DEV ONLY: stand-in for CloudWatch so the platform monitoring of the local demo is not empty.
// Every series is SYNTHETIC — deterministic pseudo-random values derived from series and
// timestamp — and says nothing about the local server's real traffic or latency.

/** Name prefix of the fake alarms (the `ALARM_NAME_PREFIX` of a deployment). */
export const FAKE_ALARM_PREFIX = 'OpenEstate-local-';

const ENDPOINTS: readonly { interface: string; route: string; weight: number }[] = [
  { interface: 'api', route: 'search', weight: 1 },
  { interface: 'api', route: 'detail', weight: 0.6 },
  { interface: 'api', route: 'meta', weight: 0.2 },
  { interface: 'mcp', route: 'search_listings', weight: 0.3 },
  { interface: 'mcp', route: 'get_listing', weight: 0.15 },
  { interface: 'management', route: 'listings', weight: 0.1 },
];

/** Share of requests per status class (`429` is a subset of `4xx`). */
const STATUS_SHARE: Readonly<Record<string, number>> = {
  '2xx': 0.95,
  '4xx': 0.04,
  '429': 0.005,
  '5xx': 0.002,
};

/** Deterministic value in [0, 1) for a series and timestamp. */
function noise(...parts: string[]): number {
  const digest = createHash('sha256').update(parts.join('|')).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/** CloudWatch dimension (helper keeps dimension names out of `Name:` literals). */
const dim = (name: string, dimValue: string): Dimension => ({ Name: name, Value: dimValue });

const dimsOf = (dims: Dimension[] | undefined): Record<string, string> =>
  Object.fromEntries((dims ?? []).map((d) => [d.Name ?? '', d.Value ?? '']));

function listMetrics(metricName: string | undefined) {
  if (metricName === REQUEST_LATENCY_METRIC) {
    return ENDPOINTS.map((e) => ({
      MetricName: metricName,
      Dimensions: [dim('interface', e.interface), dim('endpoint', e.route)],
    }));
  }
  if (metricName === MONITORED_REQUEST_COUNT_METRIC) {
    return ENDPOINTS.flatMap((e) =>
      REQUEST_STATUS_CLASSES.map((statusClass) => ({
        MetricName: metricName,
        Dimensions: [
          dim('interface', e.interface),
          dim('endpoint', e.route),
          dim('statusClass', statusClass),
        ],
      })),
    );
  }
  return [];
}

/** One synthetic data point of a series at `t` with a daily traffic curve. */
function value(metricName: string, dims: Record<string, string>, t: Date, periodSeconds: number) {
  const key = JSON.stringify(dims);
  const r = noise(metricName, key, t.toISOString());
  if (metricName === REQUEST_LATENCY_METRIC) {
    const base = dims['interface'] === 'mcp' ? 140 : dims['interface'] === 'management' ? 180 : 90;
    return Math.round(base + r * base * 0.8);
  }
  const weight =
    ENDPOINTS.find((e) => e.interface === dims['interface'] && e.route === dims['endpoint'])
      ?.weight ?? 0.1;
  const hour = t.getUTCHours();
  const daily = 0.35 + 0.65 * Math.sin((Math.PI * Math.max(0, hour - 5)) / 18) ** 2;
  const perHour = 240 * weight * daily * (0.8 + 0.4 * r);
  const share = STATUS_SHARE[dims['statusClass'] ?? '2xx'] ?? 0;
  return Math.round(perHour * (periodSeconds / 3600) * share);
}

/** A `CloudWatchClient` look-alike answering `ListMetrics`, `GetMetricData`, `DescribeAlarms`. */
export function createFakeCloudWatch(clock: Clock): CloudWatchClient {
  const send = async (command: unknown): Promise<unknown> => {
    if (command instanceof ListMetricsCommand) {
      return { Metrics: listMetrics(command.input.MetricName) };
    }
    if (command instanceof GetMetricDataCommand) {
      const { MetricDataQueries = [], StartTime, EndTime } = command.input;
      const start = StartTime instanceof Date ? StartTime.getTime() : clock() - 86_400_000;
      const end = Math.min(EndTime instanceof Date ? EndTime.getTime() : clock(), clock());
      return {
        MetricDataResults: MetricDataQueries.map((query) => {
          const stat = query.MetricStat;
          const period = stat?.Period ?? 3600;
          const metricName = stat?.Metric?.MetricName ?? '';
          const dims = dimsOf(stat?.Metric?.Dimensions);
          const step = period * 1000;
          const timestamps: Date[] = [];
          for (let t = Math.ceil(start / step) * step; t <= end; t += step)
            timestamps.push(new Date(t));
          return {
            Id: query.Id,
            Timestamps: timestamps,
            Values: timestamps.map((t) => value(metricName, dims, t, period)),
            StatusCode: 'Complete',
          };
        }),
      };
    }
    if (command instanceof DescribeAlarmsCommand) {
      const at = new Date(clock() - 3 * 3_600_000);
      const prefix = command.input.AlarmNamePrefix ?? FAKE_ALARM_PREFIX;
      return {
        MetricAlarms: [
          { AlarmName: `${prefix}Api-5xx-rate`, StateValue: 'OK', StateUpdatedTimestamp: at },
          { AlarmName: `${prefix}Api-latency-p95`, StateValue: 'OK', StateUpdatedTimestamp: at },
          {
            AlarmName: `${prefix}Connector-failures`,
            StateValue: 'ALARM',
            StateUpdatedTimestamp: new Date(clock() - 2 * 86_400_000),
          },
          {
            AlarmName: `${prefix}Indexer-iterator-age`,
            StateValue: 'INSUFFICIENT_DATA',
            StateUpdatedTimestamp: at,
          },
        ],
        CompositeAlarms: [],
      };
    }
    throw new Error('Fake CloudWatch: unsupported command');
  };
  return { send } as unknown as CloudWatchClient;
}
