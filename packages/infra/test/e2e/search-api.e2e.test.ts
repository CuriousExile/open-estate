import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  UpdateFunctionConfigurationCommand,
  waitUntilFunctionUpdatedV2,
} from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { API_RESPONSE_BUDGET_MS, REQUEST_LATENCY_METRIC } from '@open-estate/core';
import { LISTINGS_TABLE_OUTPUT } from '../../scripts/seed-writer';
import { METRICS_NAMESPACE } from '../../src/api-stack';
import {
  describeE2e,
  describeFaultInjection,
  errorCode,
  pollUntil,
  runMarker,
  stackOutput,
  stackResource,
  timedFetch,
} from './deployed-env';

/**
 * Search_API of a deployed environment (task 19.5): response time (Req 9.1), queryable p95 of
 * `RequestLatency` (Req 11.4) and 503 without persistence while DynamoDB is unreachable or does
 * not answer (Req 9.5, 9.6; only with `OPEN_ESTATE_E2E_FAULT_INJECTION=true`).
 *
 * **Validates: Requirements 9.1, 9.5, 9.6, 11.4**
 */

/** Req 9.6: a downstream call is aborted after 10 s at the latest. */
const DOWNSTREAM_ABORT_MS = 10_000;

/**
 * Downstream faults via the SDK's service-specific endpoint variable, read by every DynamoDB
 * client of the Lambda (read model, AccessGuard stores) at its next cold start.
 * - `.invalid` (RFC 6761) never resolves: the service is unreachable (Req 9.5).
 * - 192.0.2.1 (TEST-NET-1, RFC 5737) is not routed: connections hang, nothing answers (Req 9.6).
 */
const DYNAMODB_ENDPOINT_VARIABLE = 'AWS_ENDPOINT_URL_DYNAMODB';
const UNRESOLVABLE_ENDPOINT = 'https://dynamodb.open-estate.invalid';
const UNANSWERED_ENDPOINT = 'https://192.0.2.1';

describeE2e('Search API (deployed)', () => {
  let apiUrl: string;
  const marker = runMarker();
  const url = (path: string) => new URL(path, apiUrl);

  beforeAll(async () => {
    apiUrl = await stackOutput('Api', 'ApiUrl');
  });

  test('answers search, detail and meta within 5 s (Req 9.1)', async () => {
    const search = await timedFetch(url('listings'));
    expect(search.status).toBe(200);
    expect(search.ms).toBeLessThanOrEqual(API_RESPONSE_BUDGET_MS);

    // An existing listing if the environment has any, else the 404 path of the detail route.
    const firstId = (JSON.parse(search.body) as { items: { id: string }[] }).items[0]?.id;
    const detail = await timedFetch(url(`listings/${encodeURIComponent(firstId ?? marker)}`));
    expect(detail.status).toBe(firstId === undefined ? 404 : 200);
    expect(detail.ms).toBeLessThanOrEqual(API_RESPONSE_BUDGET_MS);

    const meta = await timedFetch(url('meta'));
    expect(meta.status).toBe(200);
    expect(meta.ms).toBeLessThanOrEqual(API_RESPONSE_BUDGET_MS);
  }, 60_000);

  // EMF metrics reach CloudWatch after 1–3 min; relies on the requests of the test above.
  test(
    'p95 of RequestLatency is queryable per endpoint (Req 11.4)',
    async () => {
      const cloudWatch = new CloudWatchClient({});
      const endpoints = ['search', 'detail'];
      const values = await pollUntil(
        'RequestLatency datapoints',
        async () => {
          const end = new Date();
          const { MetricDataResults } = await cloudWatch.send(
            new GetMetricDataCommand({
              StartTime: new Date(end.getTime() - 30 * 60_000),
              EndTime: end,
              MetricDataQueries: endpoints.map((endpoint) => ({
                Id: endpoint,
                MetricStat: {
                  Metric: {
                    Namespace: METRICS_NAMESPACE,
                    MetricName: REQUEST_LATENCY_METRIC,
                    Dimensions: [
                      { Name: 'interface', Value: 'api' },
                      { Name: 'endpoint', Value: endpoint },
                    ],
                  },
                  Period: 60,
                  Stat: 'p95',
                },
              })),
            }),
          );
          const found = endpoints.map(
            (endpoint) => MetricDataResults?.find((r) => r.Id === endpoint)?.Values ?? [],
          );
          return found.every((v) => v.length > 0) ? found : undefined;
        },
        { timeoutMs: 6 * 60_000, intervalMs: 20_000 },
      );
      for (const series of values) {
        for (const p95 of series) expect(p95).toBeGreaterThan(0);
      }
    },
    7 * 60_000,
  );

  describeFaultInjection('while DynamoDB is unreachable (Req 9.5, 9.6)', () => {
    const lambda = new LambdaClient({});
    let functionName: string;
    let tableName: string;
    let original: Record<string, string> | undefined;

    /** Writes `variables` as the whole environment and waits until the update is active. */
    async function setEnvironment(variables: Record<string, string>): Promise<void> {
      const { RevisionId } = await lambda.send(
        new GetFunctionConfigurationCommand({ FunctionName: functionName }),
      );
      await lambda.send(
        new UpdateFunctionConfigurationCommand({
          FunctionName: functionName,
          Environment: { Variables: variables },
          RevisionId,
        }),
      );
      await waitUntilFunctionUpdatedV2(
        { client: lambda, maxWaitTime: 120 },
        { FunctionName: functionName },
      );
    }

    beforeAll(async () => {
      functionName = await stackResource('Api', 'ListingsFunction', 'AWS::Lambda::Function');
      tableName = await stackOutput('Data', LISTINGS_TABLE_OUTPUT);
      const { Environment } = await lambda.send(
        new GetFunctionConfigurationCommand({ FunctionName: functionName }),
      );
      // Without readable values, writing back would erase the environment.
      if (Environment?.Error !== undefined) {
        throw new Error(`Environment of ${functionName} is not readable`);
      }
      original = { ...Environment?.Variables };
    }, 60_000);

    // Restores the exact deployed environment (no drift) and waits until the API answers again.
    afterAll(async () => {
      if (original === undefined) return;
      await setEnvironment(original);
      await pollUntil(
        'the Search API to recover',
        async () => ((await timedFetch(url('listings'))).status === 200 ? true : undefined),
        { timeoutMs: 60_000, intervalMs: 3_000 },
      );
    }, 180_000);

    test.each([
      ['unreachable', UNRESOLVABLE_ENDPOINT],
      ['not answering', UNANSWERED_ENDPOINT],
    ])(
      'DynamoDB %s → 503 SERVICE_UNAVAILABLE within 10 s',
      async (_case, endpoint) => {
        await setEnvironment({ ...original, [DYNAMODB_ENDPOINT_VARIABLE]: endpoint });

        for (const path of ['listings', `listings/${marker}`]) {
          const response = await timedFetch(url(path));
          expect({ path, status: response.status, code: errorCode(response.body) }).toEqual({
            path,
            status: 503,
            code: 'SERVICE_UNAVAILABLE',
          });
          expect(response.ms).toBeLessThanOrEqual(DOWNSTREAM_ABORT_MS);
        }
      },
      180_000,
    );

    test('persists nothing for the failed requests', async () => {
      const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}));
      const { Item } = await documents.send(
        new GetCommand({ TableName: tableName, Key: { id: marker } }),
      );
      expect(Item).toBeUndefined();
    });
  });
});
