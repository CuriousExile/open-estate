import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CloudWatchLogsEvent } from 'aws-lambda';
import { ConfigError } from '../config/config-error';
import { DynamoDbMetricCounterStore } from '../management/metric-counter-store';
import {
  createUsageAggregatorHandler,
  USAGE_AGGREGATOR_ENV,
  type UsageBatchResult,
} from './usage-aggregator';

// Lambda entry of the UsageAggregator (CloudWatch Logs subscription on the API and MCP log groups,
// wiring: task 12.2). Configuration is read at module load: a missing table name aborts the init
// with a ConfigError naming it. Not re-exported from the package index (side effects).

const tableName = process.env[USAGE_AGGREGATOR_ENV.metricCountersTable]?.trim();
if (!tableName) throw new ConfigError('CONFIG_MISSING', [USAGE_AGGREGATOR_ENV.metricCountersTable]);

const aggregate = createUsageAggregatorHandler({
  counters: new DynamoDbMetricCounterStore({
    client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    tableName,
  }),
  log: (entry) => console.log(JSON.stringify(entry)),
});

export function handler(event: CloudWatchLogsEvent): Promise<UsageBatchResult> {
  return aggregate(event);
}
