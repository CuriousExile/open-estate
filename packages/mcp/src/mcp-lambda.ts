import {
  createStdoutUsageRecorder,
  describeInitFailure,
  initReadModel,
  isConfigFailure,
  withRequestLatency,
  type Metrics,
  type ReadModelSources,
} from '@open-estate/core';
import {
  createMcpHandler,
  serviceUnavailableResponse,
  type McpHandler,
  type McpRequest,
} from './mcp-handler';
import { logger, metrics as defaultMetrics } from './observability';
import { TOOL_NAMES, type ToolName } from './tools';

// Lambda init of `POST /mcp`, analogous to the Listings Lambda: same environment, config files and
// AccessGuard tables, so API and MCP share counters and configuration (Req 17.1, 19.7).

/** Every MCP request that is not a `tools/call` of a known tool (initialize, tools/list, …). */
export const MCP_PROTOCOL_ENDPOINT = 'protocol';

export type McpEndpoint = ToolName | typeof MCP_PROTOCOL_ENDPOINT;

/** Every value {@link mcpEndpoint} can return (alarms and dashboard, Task 19.2). */
export const MCP_ENDPOINTS: readonly McpEndpoint[] = [...TOOL_NAMES, MCP_PROTOCOL_ENDPOINT];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `endpoint` dimension of `RequestLatency` (design: "Observability"): the tool name of a single
 * `tools/call` request (`search_listings`, `get_listing`, `list_property_types`), otherwise
 * `protocol`. Unknown tool names, batches and unparsable bodies are `protocol` as well, so the
 * dimension stays bounded. Only `method` and `params.name` are read.
 */
export function mcpEndpoint(event: Pick<McpRequest, 'body' | 'isBase64Encoded'>): McpEndpoint {
  if (event.body === undefined || event.body === null) return MCP_PROTOCOL_ENDPOINT;
  let message: unknown;
  try {
    const text = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    message = JSON.parse(text);
  } catch {
    return MCP_PROTOCOL_ENDPOINT;
  }
  if (!isRecord(message) || message['method'] !== 'tools/call') return MCP_PROTOCOL_ENDPOINT;
  const name = isRecord(message['params']) ? message['params']['name'] : undefined;
  return (TOOL_NAMES as readonly unknown[]).includes(name)
    ? (name as ToolName)
    : MCP_PROTOCOL_ENDPOINT;
}

/**
 * Records `RequestLatency` and `RequestCount` (`interface=mcp`) for every response of `handler`
 * (Req 11.4, 14.1).
 */
export function instrumentMcpHandler(
  handler: McpHandler,
  metrics: Metrics = defaultMetrics,
): McpHandler {
  return withRequestLatency(handler, {
    metrics,
    interface: 'mcp',
    endpoint: mcpEndpoint,
    statusCode: (response) => response.statusCode,
    logger,
  });
}

export async function initMcpHandler(
  env: Readonly<Record<string, string | undefined>>,
  sources: ReadModelSources = {},
): Promise<McpHandler> {
  return createMcpHandler(await initReadModel(env, sources));
}

/**
 * Production handler, instrumented with `RequestLatency`. The init starts during the Lambda init
 * phase and is awaited by every request; while it failed, every request gets 503
 * `SERVICE_UNAVAILABLE` and no tool runs. Configuration errors are final for this instance; other
 * failures are retried by the next request.
 */
export function createMcpHandlerFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  sources: ReadModelSources = {},
  metrics: Metrics = defaultMetrics,
): McpHandler {
  const withUsage: ReadModelSources = {
    ...sources,
    usage: sources.usage ?? createStdoutUsageRecorder(),
  };
  const start = (): Promise<McpHandler> => {
    const init = initMcpHandler(env, withUsage);
    init.catch((error: unknown) =>
      logger.error('POST /mcp: init failed', describeInitFailure(error)),
    );
    return init;
  };
  let ready = start();

  // Instrumented outermost, so 503s while the init failed are measured as well.
  return instrumentMcpHandler(async (event) => {
    let handler: McpHandler;
    try {
      handler = await ready;
    } catch (error) {
      if (!isConfigFailure(error)) ready = start();
      return serviceUnavailableResponse();
    }
    return handler(event);
  }, metrics);
}
