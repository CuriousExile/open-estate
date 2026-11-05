import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode as JsonRpcErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  MCP_REQUEST_DEADLINE_MS,
  type ListingService,
  type SearchService,
} from '@open-estate/core';
import {
  parseDetailQuery,
  parseSearchQuery,
  requestSchemaOverride,
  resolvePreferences,
  type ApiError,
  type ErrorResponse,
  type Result,
  type Schemas,
  type Taxonomy,
} from '@open-estate/shared';
import { z } from 'zod';
import { logger } from './observability';

// MCP tools (design: "MCP_Server", Req 19). All three are read-only and call the same domain
// functions as the Search_API: validation via `parseSearchQuery`/`parseDetailQuery`, language via
// `resolvePreferences`, data via SearchService/ListingService (Req 19.7).

export const TOOL_NAMES = ['search_listings', 'get_listing', 'list_property_types'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const SERVER_INFO = { name: 'open-estate', version: '0.0.0' } as const;

/** Deadline per request (Req 19.10); defined centrally next to the downstream budget. */
export const MCP_DEADLINE_MS = MCP_REQUEST_DEADLINE_MS;

export interface ToolDeps {
  schemas: Schemas;
  taxonomy: Taxonomy;
  search: SearchService;
  listings: ListingService;
}

const SERVICE_UNAVAILABLE: ApiError = {
  code: 'SERVICE_UNAVAILABLE',
  message: 'The search service is temporarily unavailable. Please retry later.',
};

/**
 * JSON Schema of the request side (`io: 'input'`): coercing preprocessors are transparent, and the
 * same `requestSchemaOverride` as the OpenAPI document of `GET /openapi.json` is applied, so the
 * advertised types, bounds, defaults and enums are those of the API_Schema (Req 19.2).
 */
function inputSchema(schema: z.ZodType): Tool['inputSchema'] {
  const json = z.toJSONSchema(schema, { io: 'input', override: requestSchemaOverride });
  delete json.$schema;
  return json as Tool['inputSchema'];
}

/** Tool descriptions for `tools/list`; computed once from the init-time schemas. */
export function toolDefinitions(schemas: Schemas): Tool[] {
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  return [
    {
      name: 'search_listings',
      description:
        'Search real estate listings by offer type, price, rooms, area, location (city, postal ' +
        'code, country as ISO 3166-1 alpha-2), property ' +
        'group or types and virtual tour. Amounts are decimal strings in the currency unit, ' +
        'area in m². A price filter compares in `currency` (default: the default currency); ' +
        'with convertCurrency=true offers in other currencies match after conversion with the ' +
        'static exchange rates. Results are ordered and paged like GET /listings; pass ' +
        'nextPageToken as pageToken to fetch the next page. `lang` selects the language of ' +
        'title and description.',
      inputSchema: inputSchema(schemas.searchQuery),
      annotations: { title: 'Search listings', ...readOnly },
    },
    {
      name: 'get_listing',
      description:
        'Get the full record of one listing by its id, including all offers (sale and/or rent), ' +
        'media and tour, like GET /listings/{id}. `lang` selects the language version.',
      inputSchema: inputSchema(schemas.detailQuery),
      annotations: { title: 'Get listing', ...readOnly },
    },
    {
      name: 'list_property_types',
      description:
        'List the configured property taxonomy: every property group with its listing type ' +
        'codes. Use the codes as `group` or `types` in search_listings.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { title: 'List property types', ...readOnly },
    },
  ];
}

/** Same JSON as the Search_API body (`JSON.stringify` drops `undefined`, Req 19.3, 19.4). */
function jsonValue(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function success(value: unknown): CallToolResult {
  const structured = jsonValue(value);
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/** Tool error with the Search_API error body `{ errors: ApiError[] }` (Req 19.6, 19.8). */
export function toolError(errors: readonly ApiError[]): CallToolResult {
  const body: ErrorResponse = { errors: [...errors] };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: jsonValue(body),
  };
}

function fromResult<T>(result: Result<T, ApiError[]>): CallToolResult {
  return result.ok ? success(result.value) : toolError(result.error);
}

type Args = Record<string, unknown>;

async function searchListings(deps: ToolDeps, args: Args): Promise<CallToolResult> {
  const query = parseSearchQuery(args, deps.schemas);
  if (!query.ok) return toolError(query.error);
  const prefs = resolvePreferences({ lang: query.value.lang });
  if (!prefs.ok) return toolError([prefs.error]);
  return fromResult(await deps.search.search(query.value, prefs.value));
}

async function getListing(deps: ToolDeps, args: Args): Promise<CallToolResult> {
  const query = parseDetailQuery(args, deps.schemas);
  if (!query.ok) return toolError(query.error);
  const prefs = resolvePreferences({ lang: query.value.lang });
  if (!prefs.ok) return toolError([prefs.error]);
  return fromResult(await deps.listings.get(query.value.id, prefs.value));
}

function listPropertyTypes(deps: ToolDeps): CallToolResult {
  return success({
    groups: deps.taxonomy.groups.map((g) => ({ code: g.code, types: [...g.types] })),
  });
}

const TOOLS: Record<
  ToolName,
  (deps: ToolDeps, args: Args) => Promise<CallToolResult> | CallToolResult
> = {
  search_listings: searchListings,
  get_listing: getListing,
  list_property_types: listPropertyTypes,
};

function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/** Resolves with the work, or rejects once `signal` aborts; the late result is discarded. */
function withDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Runs a domain call under the request deadline; any failure → `SERVICE_UNAVAILABLE` (19.10). */
export async function runWithDeadline(
  name: string,
  work: () => Promise<CallToolResult> | CallToolResult,
  signal: AbortSignal,
): Promise<CallToolResult> {
  try {
    return await withDeadline(Promise.resolve().then(work), signal);
  } catch (cause) {
    logger.error('POST /mcp: tool call failed', {
      tool: name,
      errorName: cause instanceof Error ? cause.name : typeof cause,
    });
    return toolError([SERVICE_UNAVAILABLE]);
  }
}

/**
 * Low-level SDK server (instead of `McpServer`): `McpServer` validates arguments itself and
 * reports unknown tools in its own format; here validation and error codes must come from the
 * shared domain logic (Req 19.6, 19.7, 19.9). One instance per request (stateless).
 */
export function createMcpServer(deps: ToolDeps, tools: Tool[], signal: AbortSignal): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const { name } = params;
    if (!isToolName(name)) {
      throw new McpError(JsonRpcErrorCode.InvalidParams, `Unknown tool: ${name}`, {
        code: 'UNKNOWN_TOOL',
      });
    }
    const args = params.arguments ?? {};
    return runWithDeadline(name, () => TOOLS[name](deps, args), signal);
  });

  return server;
}
