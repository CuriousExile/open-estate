import { LogFormatter, LogItem, Logger } from '@aws-lambda-powertools/logger';
import type {
  LogAttributes,
  LogLevel,
  UnformattedAttributes,
} from '@aws-lambda-powertools/logger/types';
import { MetricUnit, Metrics } from '@aws-lambda-powertools/metrics';
import { redactLogAttributes } from './log-redaction';

// Structured logs and latency metrics of the API and MCP Lambdas (design: "Observability",
// Req 11.4, 18.2). Logs go to stdout/stderr as JSON, metrics as CloudWatch EMF to stdout.
//
// Environment (set by the CDK stack, Task 19.2):
// - `POWERTOOLS_SERVICE_NAME`       overrides the service name of logs (default per Lambda)
// - `POWERTOOLS_LOG_LEVEL`          log level (default INFO)
// - `POWERTOOLS_METRICS_NAMESPACE`  EMF namespace (default `DEFAULT_METRICS_NAMESPACE`)
// - `POWERTOOLS_METRICS_DISABLED`   `true` suppresses EMF output (tests, local runs)

export { Logger, Metrics };

/** EMF namespace when `POWERTOOLS_METRICS_NAMESPACE` is unset. */
export const DEFAULT_METRICS_NAMESPACE = 'OpenEstate';

/** Latency of one request in ms; p95 per endpoint is the operating signal (Req 11.4). */
export const REQUEST_LATENCY_METRIC = 'RequestLatency';

/**
 * Requests per `interface`, `endpoint` and `statusClass` (Req 14.1, design: "Plattform-Kennzahlen").
 * Read by the `api.requests` / `api.responses` resolvers (`MONITORED_REQUEST_COUNT_METRIC`).
 */
export const REQUEST_COUNT_METRIC = 'RequestCount';

/** `statusClass` dimension of `RequestCount`; `429` is emitted in addition to `4xx`. */
export type RequestStatusClass = '2xx' | '4xx' | '429' | '5xx';

/** `interface` dimension of `RequestLatency` and `RequestCount`. */
export type RequestInterface = 'api' | 'mcp' | 'management';

/** Dimensions of `RequestLatency`; `endpoint` must come from a fixed set (low cardinality). */
export interface RequestLatencyDimensions {
  interface: RequestInterface;
  endpoint: string;
}

/**
 * Powertools log layout with every additional attribute passed through `redactLogAttributes`, so
 * no call site can leak PII, credentials or error messages (Req 18.2). The message itself is
 * always a constant of the calling code.
 */
export class RedactingLogFormatter extends LogFormatter {
  override formatAttributes(
    attributes: UnformattedAttributes,
    additionalLogAttributes: LogAttributes,
  ): LogItem {
    return new LogItem({
      attributes: {
        level: attributes.logLevel,
        message: attributes.message,
        timestamp: this.formatTimestamp(attributes.timestamp),
        service: attributes.serviceName,
        cold_start: attributes.lambdaContext?.coldStart,
        function_name: attributes.lambdaContext?.functionName,
        function_request_id: attributes.lambdaContext?.awsRequestId,
        xray_trace_id: attributes.xRayTraceId,
      },
    }).addAttributes(redactLogAttributes(additionalLogAttributes));
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Logger with redaction; `POWERTOOLS_SERVICE_NAME` overrides `serviceName`,
 * `POWERTOOLS_LOG_LEVEL` sets the level (Powertools default: INFO).
 */
export function createLogger(serviceName: string, env: Env = process.env): Logger {
  const logLevel = env['POWERTOOLS_LOG_LEVEL'];
  return new Logger({
    serviceName: env['POWERTOOLS_SERVICE_NAME'] || serviceName,
    logFormatter: new RedactingLogFormatter(),
    ...(logLevel && { logLevel: logLevel as LogLevel }),
  });
}

/**
 * Metrics with the namespace from `POWERTOOLS_METRICS_NAMESPACE` (default
 * `DEFAULT_METRICS_NAMESPACE`). The default `service` dimension is removed: `RequestLatency` has
 * exactly the dimensions `interface` and `endpoint`, which the alarms of Task 19.2 match.
 */
export function createMetrics(serviceName: string, env: Env = process.env): Metrics {
  const metrics = new Metrics({
    namespace: env['POWERTOOLS_METRICS_NAMESPACE'] || DEFAULT_METRICS_NAMESPACE,
    serviceName: env['POWERTOOLS_SERVICE_NAME'] || serviceName,
  });
  metrics.clearDefaultDimensions();
  return metrics;
}

/**
 * Emits one `RequestLatency` data point and flushes it immediately (one EMF line per request).
 * Synchronous, so concurrent requests of one instance cannot mix their dimensions.
 */
export function recordRequestLatency(
  metrics: Metrics,
  dimensions: RequestLatencyDimensions,
  latencyMs: number,
): void {
  metrics.addDimensions({ interface: dimensions.interface, endpoint: dimensions.endpoint });
  metrics.addMetric(REQUEST_LATENCY_METRIC, MetricUnit.Milliseconds, latencyMs);
  metrics.publishStoredMetrics();
}

/**
 * Status classes of an HTTP status (`undefined` = thrown error): `5xx` for ≥ 500 and thrown
 * errors, `4xx` for 400–499 plus `429` for 429, `2xx` for everything below 400.
 */
export function requestStatusClasses(statusCode: number | undefined): RequestStatusClass[] {
  if (statusCode === undefined || statusCode >= 500) return ['5xx'];
  if (statusCode === 429) return ['4xx', '429'];
  if (statusCode >= 400) return ['4xx'];
  return ['2xx'];
}

/**
 * Emits `RequestCount = 1` per status class of `statusCode` (two data points for 429), each
 * flushed immediately with the dimensions `interface`, `endpoint`, `statusClass`.
 */
export function recordRequestCount(
  metrics: Metrics,
  dimensions: RequestLatencyDimensions,
  statusCode: number | undefined,
): void {
  for (const statusClass of requestStatusClasses(statusCode)) {
    metrics.addDimensions({
      interface: dimensions.interface,
      endpoint: dimensions.endpoint,
      statusClass,
    });
    metrics.addMetric(REQUEST_COUNT_METRIC, MetricUnit.Count, 1);
    metrics.publishStoredMetrics();
  }
}

/**
 * Wraps a request handler: measures from call to settle and records `RequestLatency` for every
 * outcome — success, 4xx, 429, 503 and thrown errors (the error is rethrown). With `statusCode`,
 * `RequestCount` is recorded as well (thrown errors count as `5xx`). A failing metrics sink never
 * fails the request.
 */
export function withRequestLatency<E, R>(
  handler: (event: E) => Promise<R>,
  options: {
    metrics: Metrics;
    interface: RequestInterface;
    /** Maps the event to its endpoint dimension; must return a value from a fixed set. */
    endpoint: (event: E) => string;
    /** HTTP status of a response; enables `RequestCount`. */
    statusCode?: (result: R) => number;
    logger?: Logger;
    now?: () => number;
  },
): (event: E) => Promise<R> {
  const now = options.now ?? (() => performance.now());
  return async (event) => {
    const start = now();
    let status: number | undefined;
    try {
      const result = await handler(event);
      status = options.statusCode?.(result);
      return result;
    } finally {
      try {
        const dimensions = { interface: options.interface, endpoint: options.endpoint(event) };
        recordRequestLatency(options.metrics, dimensions, Math.max(0, now() - start));
        if (options.statusCode !== undefined) {
          recordRequestCount(options.metrics, dimensions, status);
        }
      } catch (cause) {
        options.logger?.warn('RequestLatency: publish failed', { error: cause });
      }
    }
  };
}
