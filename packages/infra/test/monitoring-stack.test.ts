import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { LISTINGS_ROUTES } from '@open-estate/api';
import { DEFAULT_METRICS_NAMESPACE, REQUEST_LATENCY_METRIC } from '@open-estate/core';
import { MCP_PROTOCOL_ENDPOINT, TOOL_NAMES } from '@open-estate/mcp';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ApiStack } from '../src/api-stack';
import { resolveEnvironment, resolvePlatformSettings } from '../src/config';
import { DataStack, frontendOriginParameterName } from '../src/data-stack';
import { LATENCY_ALARM, LATENCY_ALARM_SERIES, MonitoringStack } from '../src/monitoring-stack';
import { SearchStack } from '../src/search-stack';

const CDK_CONTEXT = (
  JSON.parse(readFileSync(path.join(__dirname, '../cdk.json'), 'utf8')) as {
    context: Record<string, unknown>;
  }
).context;

/** Data, Search (if enabled), Api and Monitoring wired like `app.ts`; bundling skipped. */
function synthApp(envName: string, context: Record<string, unknown> = {}) {
  const config = resolveEnvironment(envName);
  const app = new App({ context: { ...CDK_CONTEXT, 'aws:cdk:bundling-stacks': [], ...context } });
  const settings = resolvePlatformSettings((key) => app.node.tryGetContext(key));
  const data = new DataStack(app, `${config.stackPrefix}-Data`, { environment: config, settings });
  const search =
    settings.searchProvider === 'opensearch'
      ? new SearchStack(app, `${config.stackPrefix}-Search`, {
          envName: config.envName,
          listings: data.listingsTable,
          removalPolicy: config.removalPolicy,
        })
      : undefined;
  const api = new ApiStack(app, `${config.stackPrefix}-Api`, {
    tables: {
      listings: data.listingsTable,
      apiKeys: data.apiKeysTable,
      rateLimitCounters: data.rateLimitCountersTable,
    },
    config: { configBucket: data.configBucket, parameterNames: data.parameterNames },
    cors: { frontendOriginParameter: frontendOriginParameterName(envName), allowedOrigins: [] },
    stageName: config.stageName,
    removalPolicy: config.removalPolicy,
    searchProvider: settings.searchProvider,
    ...(search && { openSearch: search.target }),
    wafRateLimit: settings.wafRateLimit,
  });
  const monitoring = new MonitoringStack(app, `${config.stackPrefix}-Monitoring`, {
    api,
    ...(search && { search }),
    removalPolicy: config.removalPolicy,
  });
  app.synth(); // fails on a dependency cycle
  return { monitoring, template: Template.fromStack(monitoring) };
}

/** The dashboard body as one string (an `Fn::Join` of literals and tokens). */
function dashboardBody(template: Template): string {
  const [dashboard] = Object.values(template.findResources('AWS::CloudWatch::Dashboard'));
  return JSON.stringify(dashboard?.['Properties']?.['DashboardBody']);
}

const EXPECTED_SERIES = [
  ...Object.keys(LISTINGS_ROUTES).map((endpoint) => ({ interface: 'api', endpoint })),
  ...[...TOOL_NAMES, MCP_PROTOCOL_ENDPOINT].map((endpoint) => ({ interface: 'mcp', endpoint })),
];

describe('MonitoringStack', () => {
  it('alarms on every API route and MCP endpoint, not on api/unknown', () => {
    expect(LATENCY_ALARM_SERIES).toEqual(EXPECTED_SERIES);
    expect(EXPECTED_SERIES).toEqual(
      expect.arrayContaining([
        { interface: 'api', endpoint: 'search' },
        { interface: 'api', endpoint: 'detail' },
        { interface: 'mcp', endpoint: 'search_listings' },
        { interface: 'mcp', endpoint: 'get_listing' },
      ]),
    );
    expect(LATENCY_ALARM_SERIES).not.toContainEqual({ interface: 'api', endpoint: 'unknown' });
  });

  it.each(['dev', 'prod'])('%s: one p95 > 2000 ms alarm per series on RequestLatency', (env) => {
    const { template } = synthApp(env);
    template.resourceCountIs('AWS::CloudWatch::Alarm', EXPECTED_SERIES.length);
    for (const series of EXPECTED_SERIES) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: DEFAULT_METRICS_NAMESPACE,
        MetricName: REQUEST_LATENCY_METRIC,
        // Exactly these two dimensions, in any order.
        Dimensions: Match.arrayEquals([
          { Name: 'endpoint', Value: series.endpoint },
          { Name: 'interface', Value: series.interface },
        ]),
        ExtendedStatistic: 'p95',
        Threshold: 2000,
        ComparisonOperator: 'GreaterThanThreshold',
        Period: 300,
        EvaluationPeriods: LATENCY_ALARM.evaluationPeriods,
        DatapointsToAlarm: LATENCY_ALARM.datapointsToAlarm,
        TreatMissingData: 'notBreaching',
        AlarmActions: [{ Ref: Match.stringLikeRegexp('^AlarmTopic') }],
        OKActions: [{ Ref: Match.stringLikeRegexp('^AlarmTopic') }],
      });
    }
  });

  it('notifies an encrypted, TLS-only topic CloudWatch may publish to', () => {
    const { template } = synthApp('dev');
    template.hasResourceProperties('AWS::SNS::Topic', {
      KmsMasterKeyId: { 'Fn::GetAtt': [Match.stringLikeRegexp('^AlarmTopicKey'), 'Arn'] },
    });
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'cloudwatch.amazonaws.com' },
            Action: ['kms:Decrypt', 'kms:GenerateDataKey*'],
          }),
        ]),
      },
    });
    template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
          Match.objectLike({
            Effect: 'Allow',
            Action: 'sns:Publish',
            Principal: { Service: 'cloudwatch.amazonaws.com' },
          }),
        ]),
      },
    });
    template.hasOutput('AlarmTopicArn', {});
  });

  it('dashboard: latency percentiles, counts, Lambda and gateway health', () => {
    const { template } = synthApp('dev');
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    const body = dashboardBody(template);
    for (const stat of ['p50', 'p95', 'p99', 'SampleCount']) {
      expect(body).toContain(`\\"stat\\":\\"${stat}\\"`);
    }
    expect(body).toContain(`\\"${DEFAULT_METRICS_NAMESPACE}\\",\\"${REQUEST_LATENCY_METRIC}\\"`);
    for (const { endpoint } of [...EXPECTED_SERIES, { endpoint: 'unknown' }]) {
      expect(body).toContain(`\\"endpoint\\",\\"${endpoint}\\"`);
    }
    for (const metric of ['Errors', 'Throttles', '4XXError', '5XXError']) {
      expect(body).toContain(`\\"${metric}\\"`);
    }
    expect(body).not.toContain('IteratorAge');
  });

  it('with OpenSearch: indexer iterator age and DLQ depth, still no cycle', () => {
    const { template } = synthApp('dev', { searchProvider: 'opensearch' });
    const body = dashboardBody(template);
    expect(body).toContain('\\"IteratorAge\\"');
    expect(body).toContain('\\"ApproximateNumberOfMessagesVisible\\"');
    template.resourceCountIs('AWS::CloudWatch::Alarm', EXPECTED_SERIES.length);
  });
});
