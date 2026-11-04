import { CfnOutput, Duration, Stack, type RemovalPolicy, type StackProps } from 'aws-cdk-lib';
import {
  Alarm,
  AlarmStatusWidget,
  ComparisonOperator,
  Dashboard,
  GraphWidget,
  Metric,
  TextWidget,
  TreatMissingData,
  type IWidget,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { LISTINGS_ENDPOINTS, LISTINGS_ROUTES } from '@open-estate/api';
import {
  REQUEST_LATENCY_METRIC,
  type RequestInterface,
  type RequestLatencyDimensions,
} from '@open-estate/core';
import { MCP_ENDPOINTS } from '@open-estate/mcp';
import type { Construct } from 'constructs';
import { METRICS_NAMESPACE, type ApiStack } from './api-stack';
import type { SearchStack } from './search-stack';

/**
 * `p95(RequestLatency) > 2000 ms` (Req 2.4, 11.3: p95 ≤ 2 s). The 2 s are a performance target
 * under reference load, not a timeout (design: "Observability"). Two consecutive 5-min periods
 * must breach, i.e. a sustained p95 over 10 min — the shortest window Req 11.4 asks p95 for — so a
 * single cold start or short spike does not page. Low traffic makes p95 noisy (with few requests
 * per period it is close to the maximum); no traffic is not an incident (NOT_BREACHING).
 */
export const LATENCY_ALARM = {
  statistic: 'p95',
  thresholdMs: 2000,
  period: Duration.minutes(5),
  evaluationPeriods: 2,
  datapointsToAlarm: 2,
} as const;

/** One `RequestLatency` series: exactly the dimensions the handlers emit (Task 19.1). */
export interface LatencySeries {
  readonly interface: RequestInterface;
  readonly endpoint: string;
}

const API_ENDPOINTS: readonly LatencySeries[] = LISTINGS_ENDPOINTS.map((endpoint) => ({
  interface: 'api',
  endpoint,
}));
const MCP_LATENCY_ENDPOINTS: readonly LatencySeries[] = MCP_ENDPOINTS.map((endpoint) => ({
  interface: 'mcp',
  endpoint,
}));

/**
 * Series with a latency alarm: every API route and every MCP endpoint. Search/detail are the Req
 * 2.4/11.3 targets; `openapi`/`meta` and `list_property_types`/`protocol` (initialize,
 * tools/list) are what agents call to discover the interface, so they are alarmed with the same
 * target. Not `api/unknown`: unrouted requests (normally answered by the gateway's 404) are
 * caller-driven noise, counted on the dashboard only.
 */
export const LATENCY_ALARM_SERIES: readonly LatencySeries[] = [
  ...API_ENDPOINTS.filter(({ endpoint }) => endpoint in LISTINGS_ROUTES),
  ...MCP_LATENCY_ENDPOINTS,
];

/**
 * `RequestLatency` of one series with `statistic`. No label: a labeled metric would make the
 * alarm a metric-math `Metrics` array instead of a plain metric alarm.
 */
export function requestLatencyMetric(
  series: LatencySeries,
  statistic: string,
  period: Duration = LATENCY_ALARM.period,
): Metric {
  const dimensionsMap: Record<keyof RequestLatencyDimensions, string> = {
    interface: series.interface,
    endpoint: series.endpoint,
  };
  return new Metric({
    namespace: METRICS_NAMESPACE,
    metricName: REQUEST_LATENCY_METRIC,
    dimensionsMap,
    statistic,
    period,
  });
}

export interface MonitoringStackProps extends StackProps {
  readonly api: Pick<ApiStack, 'api' | 'listingsFunction' | 'mcpFunction'>;
  /** Present with `searchProvider=opensearch`: indexer and DLQ widgets. */
  readonly search?: Pick<SearchStack, 'indexer' | 'deadLetterQueue'>;
  readonly removalPolicy: RemovalPolicy;
}

const WIDGET_HEIGHT = 6;
const DASHBOARD_PERIOD = Duration.minutes(1);

/**
 * Operations view of the read side (design: "Observability", Req 11.4): one p95 latency alarm per
 * {@link LATENCY_ALARM_SERIES} entry and a dashboard with p50/p95/p99 and request counts per
 * endpoint, Lambda errors/throttles, API Gateway 4xx/5xx and — with OpenSearch — indexer iterator
 * age and DLQ depth. Separate from the ApiStack so it can change without touching the API; it
 * only references other stacks, nothing references it (no cycle).
 *
 * Alarms notify the `AlarmTopic`; subscriptions are not managed here (ops subscribe themselves,
 * e.g. `aws sns subscribe --topic-arn <AlarmTopicArn> --protocol email --notification-endpoint
 * ops@example.org`). The topic uses a customer managed key because CloudWatch cannot publish to
 * a topic encrypted with the AWS managed `alias/aws/sns` key.
 */
export class MonitoringStack extends Stack {
  readonly alarmTopic: Topic;
  readonly latencyAlarms: readonly Alarm[];
  readonly dashboard: Dashboard;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const cloudWatch = new ServicePrincipal('cloudwatch.amazonaws.com');
    const key = new Key(this, 'AlarmTopicKey', {
      description: 'Open Estate alarm topic encryption',
      enableKeyRotation: true,
      removalPolicy: props.removalPolicy,
    });
    key.grant(cloudWatch, 'kms:Decrypt', 'kms:GenerateDataKey*');
    this.alarmTopic = new Topic(this, 'AlarmTopic', {
      displayName: 'Open Estate: operational alarms',
      masterKey: key,
      enforceSSL: true,
    });
    // The enforceSSL policy replaces the default topic policy, so CloudWatch needs an explicit
    // allow; limited to alarms of this account.
    this.alarmTopic.addToResourcePolicy(
      new PolicyStatement({
        actions: ['sns:Publish'],
        principals: [cloudWatch],
        resources: [this.alarmTopic.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );
    const action = new SnsAction(this.alarmTopic);

    this.latencyAlarms = LATENCY_ALARM_SERIES.map((series) => {
      const alarm = new Alarm(this, `RequestLatencyP95-${series.interface}-${series.endpoint}`, {
        alarmName: `${id}-RequestLatencyP95-${series.interface}-${series.endpoint}`,
        alarmDescription:
          `p95 RequestLatency of ${series.interface}/${series.endpoint} above ` +
          `${LATENCY_ALARM.thresholdMs} ms (Req 2.4, 11.3)`,
        metric: requestLatencyMetric(series, LATENCY_ALARM.statistic),
        threshold: LATENCY_ALARM.thresholdMs,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: LATENCY_ALARM.evaluationPeriods,
        datapointsToAlarm: LATENCY_ALARM.datapointsToAlarm,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(action);
      alarm.addOkAction(action);
      return alarm;
    });

    this.dashboard = new Dashboard(this, 'Dashboard', {
      dashboardName: id,
      defaultInterval: Duration.hours(3),
      widgets: dashboardRows(props, this.latencyAlarms),
    });

    new CfnOutput(this, 'AlarmTopicArn', {
      description: 'SNS topic of the operational alarms; subscribe ops endpoints here',
      value: this.alarmTopic.topicArn,
    });
    new CfnOutput(this, 'DashboardName', {
      description: 'CloudWatch dashboard of the Search_API and MCP_Server',
      value: this.dashboard.dashboardName,
    });
  }
}

function dashboardRows(props: MonitoringStackProps, alarms: readonly Alarm[]): IWidget[][] {
  const { api, listingsFunction, mcpFunction } = props.api;
  const stage = api.deploymentStage;
  const rows: IWidget[][] = [
    [
      new TextWidget({
        markdown:
          `# Open Estate read side\n\`${METRICS_NAMESPACE}/${REQUEST_LATENCY_METRIC}\` by ` +
          `interface and endpoint; target p95 ≤ ${LATENCY_ALARM.thresholdMs} ms.`,
        width: 24,
        height: 2,
      }),
    ],
    [new AlarmStatusWidget({ title: 'Latency alarms', alarms: [...alarms], width: 24, height: 3 })],
    latencyWidgets(API_ENDPOINTS.filter(({ endpoint }) => endpoint in LISTINGS_ROUTES)),
    latencyWidgets(MCP_LATENCY_ENDPOINTS),
    [
      requestCountWidget('Search_API requests', API_ENDPOINTS),
      requestCountWidget('MCP_Server requests', MCP_LATENCY_ENDPOINTS),
    ],
    [
      lambdaHealthWidget('Listings Lambda', listingsFunction),
      lambdaHealthWidget('MCP Lambda', mcpFunction),
      graph('API Gateway errors', [
        stage.metricClientError({ period: DASHBOARD_PERIOD, label: '4XXError' }),
        stage.metricServerError({ period: DASHBOARD_PERIOD, label: '5XXError' }),
      ]),
      graph('API Gateway latency', [
        stage.metricLatency({ period: DASHBOARD_PERIOD, statistic: 'p95', label: 'Latency p95' }),
        stage.metricIntegrationLatency({
          period: DASHBOARD_PERIOD,
          statistic: 'p95',
          label: 'IntegrationLatency p95',
        }),
      ]),
    ],
  ];
  if (props.search !== undefined) {
    const { indexer, deadLetterQueue } = props.search;
    rows.push([
      lambdaHealthWidget('Indexer Lambda', indexer),
      graph('Indexer iterator age (ms)', [
        indexer.metric('IteratorAge', {
          period: DASHBOARD_PERIOD,
          statistic: 'Maximum',
          label: 'IteratorAge max',
        }),
      ]),
      graph('Indexer DLQ depth', [
        deadLetterQueue.metricApproximateNumberOfMessagesVisible({
          period: DASHBOARD_PERIOD,
          statistic: 'Maximum',
          label: 'Messages visible',
        }),
      ]),
    ]);
  }
  return rows;
}

/** p50/p95/p99 per endpoint, with the alarm threshold as annotation; one row per interface. */
function latencyWidgets(series: readonly LatencySeries[]): GraphWidget[] {
  const width = Math.max(6, Math.floor(24 / series.length));
  return series.map(
    (s) =>
      new GraphWidget({
        title: `${s.interface}/${s.endpoint} RequestLatency (ms)`,
        left: ['p50', 'p95', 'p99'].map((stat) =>
          requestLatencyMetric(s, stat, DASHBOARD_PERIOD).with({ label: stat }),
        ),
        leftAnnotations: [{ value: LATENCY_ALARM.thresholdMs, label: 'p95 target' }],
        width,
        height: WIDGET_HEIGHT,
      }),
  );
}

/** Requests per endpoint: SampleCount of `RequestLatency` (one data point per request). */
function requestCountWidget(title: string, series: readonly LatencySeries[]): GraphWidget {
  return new GraphWidget({
    title,
    left: series.map((s) =>
      requestLatencyMetric(s, 'SampleCount', DASHBOARD_PERIOD).with({ label: s.endpoint }),
    ),
    stacked: true,
    width: 12,
    height: WIDGET_HEIGHT,
  });
}

function lambdaHealthWidget(title: string, fn: IFunction): GraphWidget {
  return graph(`${title} errors / throttles`, [
    fn.metricErrors({ period: DASHBOARD_PERIOD, label: 'Errors' }),
    fn.metricThrottles({ period: DASHBOARD_PERIOD, label: 'Throttles' }),
  ]);
}

function graph(title: string, left: Metric[]): GraphWidget {
  return new GraphWidget({ title, left, width: 6, height: WIDGET_HEIGHT });
}
