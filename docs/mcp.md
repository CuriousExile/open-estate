# MCP server

Open Estate includes a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server, so AI
agents can search listings as tools. It offers the same functions as the [Search API](api.md), with
the same parameters, results, error codes, access mode and rate limit.

| Tool                  | Same as               | Arguments                           | Result (`structuredContent`)          |
| --------------------- | --------------------- | ----------------------------------- | ------------------------------------- |
| `search_listings`     | `GET /listings`       | all search parameters, all optional | `{ items, nextPageToken? }`           |
| `get_listing`         | `GET /listings/{id}`  | `id` (required), `lang`             | one listing                           |
| `list_property_types` | `taxonomy` in `/meta` | none                                | `{ groups: [{ code, types }] }`       |

All three tools are read-only (`readOnlyHint: true`, `destructiveHint: false`). They call the same
validation and search code as the API, so the same arguments give the same results and the same
error codes.

`search_listings` takes every parameter of [`GET /listings`](api.md#get-listings) as a typed JSON
value, including the optional `country` filter (ISO 3166-1 alpha-2 in upper case, for example
`{ "country": "TH", "city": "Pattaya" }`). Without `country`, listings of all countries match. The
countries and cities that currently have listings are in [`GET /locations`](api.md#get-locations);
there is no MCP tool for them.

The JSON-RPC examples on this page come from the real handler. The test
`packages/mcp/test/docs-examples.test.ts` sends each documented request to the handler and compares
the documented response.

## Endpoint

The server is at `<ApiUrl>mcp`, on the same API Gateway stage as the Search API. `ApiUrl` is the
output of the `OpenEstate-<env>-Api` stack (see [api.md](api.md#base-url-and-stage)), for example:

```text
https://abc123defg.execute-api.eu-central-1.amazonaws.com/dev/mcp
```

The transport is [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http)
in its stateless JSON mode:

- Only `POST` is supported. Every request is one JSON-RPC message and gets one JSON response
  (`Content-Type: application/json`). Send `Accept: application/json, text/event-stream`. Without
  both types the server answers `406`.
- Stateless. There is no session and no `Mcp-Session-Id` header. Every request stands alone, so you
  can call `tools/list` or `tools/call` without `initialize` (MCP clients still initialize, which
  doesn't hurt).
- `GET` (server-sent event stream) and `DELETE` (session end) are answered with `405 Method Not
  Allowed` and `Allow: POST`. MCP clients treat that as "no stream" and carry on.
- JSON-RPC batches (a JSON array of messages) are rejected with HTTP 400 and JSON-RPC error
  `-32600`. Malformed JSON gets the parse error `-32700`.
- Every request has a deadline of 10 seconds. If a tool call takes longer, the result is the tool
  error `SERVICE_UNAVAILABLE`.

### Access and rate limit

The access mode applies to the MCP server as well (see [api.md](api.md#access-modes-and-api-keys)).
In `api-keys` mode send the key in every request:

```text
Authorization: Bearer <API key>
```

MCP requests and Search API requests count against the same rate limit. Every `POST` counts, including
`initialize` and notifications. Connecting an MCP client therefore uses two requests. A
missing or invalid key (`401`), an exceeded rate limit (`429`, with `Retry-After`) and an
unavailable service (`503`) are answered as HTTP errors with the same body as in the API, not as
JSON-RPC messages:

```json
{
  "errors": [
    {
      "code": "RATE_LIMITED",
      "message": "Rate limit of 60 requests per 60 s exceeded",
      "details": { "retryAfterSeconds": 45 }
    }
  ],
  "retryAfterSeconds": 45
}
```

## Connecting an AI agent

Use the endpoint URL from above. The `Authorization` header is only needed in `api-keys` mode; leave
it out in `open` mode.

### Claude Code

Claude Code connects to remote servers over HTTP directly
([Claude Code MCP docs](https://code.claude.com/docs/en/mcp)):

```sh
claude mcp add --transport http open-estate \
  https://abc123defg.execute-api.eu-central-1.amazonaws.com/dev/mcp \
  --header "Authorization: Bearer $OPEN_ESTATE_API_KEY"
```

To share the server with your team, put it into `.mcp.json` at the project root instead. Claude
Code requires `"type": "http"` for URL entries. `${VAR}` references are expanded from the
environment, so the key stays out of the repository:

```json
{
  "mcpServers": {
    "open-estate": {
      "type": "http",
      "url": "https://abc123defg.execute-api.eu-central-1.amazonaws.com/dev/mcp",
      "headers": { "Authorization": "Bearer ${OPEN_ESTATE_API_KEY}" }
    }
  }
}
```

Check the connection with `claude mcp get open-estate`, or with `/mcp` inside a session.

### Other clients with Streamable HTTP

Most clients that support remote MCP servers take the same three values: transport type HTTP (also
called `streamable-http`), the URL and optional headers. The JSON block above works in many of them.
Some clients use another top-level key or field names, so check the client's documentation.

### Claude Desktop and stdio-only clients

Claude Desktop's `claude_desktop_config.json` only starts local (stdio) servers. Remote servers are
added in the app as custom connectors (Settings → Connectors → Add custom connector). Anthropic
connects to the server from its cloud, and connectors offer no field for a static
`Authorization` header ([Anthropic: custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)).
A custom connector therefore only works in `open` mode.

With API keys, or for any other client that only supports stdio, use the
[`mcp-remote`](https://github.com/geelen/mcp-remote) bridge. It runs locally, speaks stdio to the
client and Streamable HTTP to Open Estate. In `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "open-estate": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://abc123defg.execute-api.eu-central-1.amazonaws.com/dev/mcp",
        "--transport",
        "http-only",
        "--header",
        "Authorization:${OPEN_ESTATE_AUTH}"
      ],
      "env": { "OPEN_ESTATE_AUTH": "Bearer <API key>" }
    }
  }
}
```

The header is split into `Authorization:${OPEN_ESTATE_AUTH}` and the env value because some clients,
including Claude Desktop on Windows, don't escape spaces inside `args`, as described in the
`mcp-remote` README. Restart Claude Desktop after you edit the file.

### TypeScript with the MCP SDK

With [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) (this
example was tested with 1.32.2, the version Open Estate uses):

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'example-agent', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(`${process.env.API_URL}mcp`), {
  // Only in api-keys mode.
  requestInit: { headers: { Authorization: `Bearer ${process.env.API_KEY}` } },
});
await client.connect(transport);

const { tools } = await client.listTools();
console.log(tools.map((tool) => tool.name)); // search_listings, get_listing, list_property_types

const result = await client.callTool({
  name: 'search_listings',
  arguments: { city: 'Berlin', offerType: 'RENT', priceMax: '1300', lang: 'en' },
});
if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
console.log(result.structuredContent); // { items: [...], nextPageToken?: '...' }

await client.close();
```

## Tools

### Arguments

The input schemas in `tools/list` are generated from the same request schemas as the API parameters
in `/openapi.json`, with the same types, bounds, defaults and configured enumerations. The rules from
[`GET /listings`](api.md#get-listings) apply unchanged: filters are combined with AND, `group` and
`types` exclude each other, a price filter needs `offerType`, and `currency` defaults to the
deployment's default currency. `convertCurrency: true` also matches offers in other currencies,
converted with the static exchange rates of `/meta`.

- Pass amounts and areas as decimal strings (`"1300"`, `"92.40"`), as advertised in the schema. JSON
  numbers are accepted too and converted.
- `types` is a list of codes, `group` a single code (a one-element list is accepted).
- For more results, pass `nextPageToken` as `pageToken` with otherwise identical arguments.
- `lang` selects the language version. There is no `Accept-Language` in MCP. Without `lang` you get
  the original language of each listing.

### Results

A successful call returns the API response body twice. `structuredContent` holds it as JSON, and
`content[0].text` holds the same JSON serialized as text, for clients that only read text content.
Amounts and areas are decimal strings, and listings carry `deliveredLocale` and `originalLocale`.
See [api.md](api.md#get-listingsid) for the fields.

## Examples

All examples are sent as `POST <ApiUrl>mcp`. With curl:

```sh mcp-curl:initialize
curl -sS -X POST "${API_URL}mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"example-agent","version":"1.0.0"}}}'
```

### `initialize`

```json mcp-request:initialize
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "example-agent", "version": "1.0.0" }
  }
}
```

```http mcp-head:initialize
HTTP/1.1 200 OK
content-type: application/json
```

```json mcp-response:initialize
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": { "tools": {} },
    "serverInfo": { "name": "open-estate", "version": "0.0.0" }
  }
}
```

### `tools/list`

```json mcp-request:tools-list
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }
```

Excerpt: the input schema of `search_listings` is left out. It has one property per search
parameter, as in the [parameter table](api.md#get-listings).

```json mcp-response:tools-list excerpt
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "search_listings",
        "description": "Search real estate listings by offer type, price, rooms, area, location (city, postal code, country as ISO 3166-1 alpha-2), property group or types and virtual tour. Amounts are decimal strings in the currency unit, area in m². A price filter compares in `currency` (default: the default currency); with convertCurrency=true offers in other currencies match after conversion with the static exchange rates. Results are ordered and paged like GET /listings; pass nextPageToken as pageToken to fetch the next page. `lang` selects the language of title and description.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "offerType": { "type": "string", "enum": ["SALE", "RENT"] },
            "pageSize": { "type": "integer", "minimum": 1, "maximum": 50, "default": 20 }
          }
        },
        "annotations": {
          "title": "Search listings",
          "readOnlyHint": true,
          "destructiveHint": false,
          "openWorldHint": false
        }
      },
      {
        "name": "get_listing",
        "description": "Get the full record of one listing by its id, including all offers (sale and/or rent), media and tour, like GET /listings/{id}. `lang` selects the language version.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "id": { "type": "string", "minLength": 1, "maxLength": 128 },
            "lang": { "type": "string", "minLength": 1, "maxLength": 35 }
          },
          "required": ["id"]
        },
        "annotations": {
          "title": "Get listing",
          "readOnlyHint": true,
          "destructiveHint": false,
          "openWorldHint": false
        }
      },
      {
        "name": "list_property_types",
        "description": "List the configured property taxonomy: every property group with its listing type codes. Use the codes as `group` or `types` in search_listings.",
        "inputSchema": { "type": "object", "properties": {} },
        "annotations": {
          "title": "List property types",
          "readOnlyHint": true,
          "destructiveHint": false,
          "openWorldHint": false
        }
      }
    ]
  }
}
```

### `tools/call` `search_listings`

Listings in Berlin for rent at a cold rent of at most 1,300 EUR, with a 3D tour, in English. The
result is the listing with both a `SALE` and a `RENT` offer.

```json mcp-request:search
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "search_listings",
    "arguments": {
      "city": "Berlin",
      "offerType": "RENT",
      "priceMax": "1300",
      "hasTour": true,
      "lang": "en"
    }
  }
}
```

Excerpt: `content[0].text`, the same JSON as `structuredContent` serialized as a string, is left
out.

```json mcp-response:search excerpt
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [{ "type": "text" }],
    "structuredContent": {
      "items": [
        {
          "id": "berlin-mitte-0042",
          "title": "Bright 3.5-room period apartment with balcony in Mitte",
          "description": "Renovated period apartment on the 3rd floor with stucco, wooden floors and a south-facing balcony. Available to buy or to rent.",
          "deliveredLocale": "en",
          "originalLocale": "de",
          "offers": [
            { "offerType": "SALE", "price": "450000.00", "currency": "EUR" },
            {
              "offerType": "RENT",
              "coldRent": "1250.50",
              "currency": "EUR",
              "additionalCosts": "280.00",
              "warmRent": "1530.50"
            }
          ],
          "listingType": "apartment_unit",
          "group": "apartment",
          "rooms": 3.5,
          "area": "92.40",
          "address": {
            "city": "Berlin",
            "postalCode": "10115",
            "country": "DE",
            "street": "Invalidenstraße 12"
          },
          "geo": { "lat": 52.530644, "lon": 13.383068 },
          "sourceUrl": "https://partner.example/expose/berlin-mitte-0042",
          "media": [
            { "url": "https://media.partner.example/berlin-mitte-0042/living-room.jpg" },
            { "url": "https://media.partner.example/berlin-mitte-0042/balcony.jpg" }
          ],
          "tours": [
            {
              "url": "https://my.matterport.com/show/?m=Zh14WDtkjdC",
              "providerCode": "matterport"
            }
          ],
          "source": "example-partner",
          "lastImportedAt": "2026-11-05T03:00:12.000Z",
          "lastRunId": "run-20261105-0300"
        }
      ]
    }
  }
}
```

### `tools/call` `get_listing`

The same listing in its original language, German:

```json mcp-request:get
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": { "name": "get_listing", "arguments": { "id": "berlin-mitte-0042", "lang": "de" } }
}
```

Excerpt without `content[0].text`:

```json mcp-response:get excerpt
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "content": [{ "type": "text" }],
    "structuredContent": {
      "id": "berlin-mitte-0042",
      "title": "Helle 3,5-Zimmer-Altbauwohnung mit Balkon in Mitte",
      "description": "Sanierte Altbauwohnung im 3. OG mit Stuck, Dielenboden und Südbalkon. Kauf oder Miete möglich.",
      "deliveredLocale": "de",
      "originalLocale": "de",
      "offers": [
        { "offerType": "SALE", "price": "450000.00", "currency": "EUR" },
        {
          "offerType": "RENT",
          "coldRent": "1250.50",
          "currency": "EUR",
          "additionalCosts": "280.00",
          "warmRent": "1530.50"
        }
      ],
      "listingType": "apartment_unit",
      "group": "apartment",
      "rooms": 3.5,
      "area": "92.40",
      "address": {
        "city": "Berlin",
        "postalCode": "10115",
        "country": "DE",
        "street": "Invalidenstraße 12"
      },
      "geo": { "lat": 52.530644, "lon": 13.383068 },
      "sourceUrl": "https://partner.example/expose/berlin-mitte-0042",
      "media": [
        { "url": "https://media.partner.example/berlin-mitte-0042/living-room.jpg" },
        { "url": "https://media.partner.example/berlin-mitte-0042/balcony.jpg" }
      ],
      "tours": [
        { "url": "https://my.matterport.com/show/?m=Zh14WDtkjdC", "providerCode": "matterport" }
      ],
      "source": "example-partner",
      "lastImportedAt": "2026-11-05T03:00:12.000Z",
      "lastRunId": "run-20261105-0300"
    }
  }
}
```

### `tools/call` `list_property_types`

```json mcp-request:types
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": { "name": "list_property_types", "arguments": {} }
}
```

```json mcp-response:types excerpt
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "content": [{ "type": "text" }],
    "structuredContent": {
      "groups": [
        { "code": "apartment", "types": ["apartment_unit", "condominium", "penthouse", "loft"] },
        { "code": "house", "types": ["single_family", "villa", "terraced", "semi_detached"] },
        { "code": "land", "types": ["building_plot"] },
        { "code": "commercial", "types": ["office", "retail"] }
      ]
    }
  }
}
```

## Errors

There are three kinds of errors:

| Kind                   | When                                                                    | Shape                                                     |
| ---------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| Tool error             | Invalid arguments, listing not found, service unavailable or deadline   | Tool result with `isError: true` and `{ errors: ApiError[] }` |
| JSON-RPC error         | Unknown tool, batch request, malformed JSON-RPC                         | JSON-RPC `error`; unknown tool has `data.code: "UNKNOWN_TOOL"` |
| HTTP error             | Missing/invalid key, rate limit, service unavailable before the call    | HTTP 401/429/503 with the API error body                  |

Tool errors use the same `ApiError` entries and codes as the API (see the
[error table](api.md#errors)). Like the API, a tool reports all invalid arguments at once.

### Invalid arguments

```json mcp-request:tool-error
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": { "name": "search_listings", "arguments": { "priceMax": "1300", "pageSize": 0 } }
}
```

```json mcp-response:tool-error
{
  "jsonrpc": "2.0",
  "id": 6,
  "result": {
    "isError": true,
    "content": [
      {
        "type": "text",
        "text": "{\"errors\":[{\"code\":\"INVALID_PAGE_SIZE\",\"message\":\"Too small: expected number to be >=1\",\"field\":\"pageSize\"},{\"code\":\"OFFER_TYPE_REQUIRED\",\"message\":\"A price filter requires offerType (SALE or RENT)\",\"field\":\"offerType\"}]}"
      }
    ],
    "structuredContent": {
      "errors": [
        {
          "code": "INVALID_PAGE_SIZE",
          "message": "Too small: expected number to be >=1",
          "field": "pageSize"
        },
        {
          "code": "OFFER_TYPE_REQUIRED",
          "message": "A price filter requires offerType (SALE or RENT)",
          "field": "offerType"
        }
      ]
    }
  }
}
```

### Listing not found

```json mcp-request:not-found
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": { "name": "get_listing", "arguments": { "id": "does-not-exist" } }
}
```

```json mcp-response:not-found
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "isError": true,
    "content": [
      {
        "type": "text",
        "text": "{\"errors\":[{\"code\":\"NOT_FOUND\",\"message\":\"Listing does-not-exist not found\",\"details\":{\"id\":\"does-not-exist\"}}]}"
      }
    ],
    "structuredContent": {
      "errors": [
        {
          "code": "NOT_FOUND",
          "message": "Listing does-not-exist not found",
          "details": { "id": "does-not-exist" }
        }
      ]
    }
  }
}
```

### Unknown tool

```json mcp-request:unknown-tool
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "tools/call",
  "params": { "name": "book_viewing", "arguments": {} }
}
```

```json mcp-response:unknown-tool
{
  "jsonrpc": "2.0",
  "id": 8,
  "error": {
    "code": -32602,
    "message": "MCP error -32602: Unknown tool: book_viewing",
    "data": { "code": "UNKNOWN_TOOL" }
  }
}
```

### Batch request

```json mcp-request:batch
[{ "jsonrpc": "2.0", "id": 9, "method": "tools/list" }]
```

```http mcp-head:batch
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
```

```json mcp-response:batch
{
  "jsonrpc": "2.0",
  "id": null,
  "error": { "code": -32600, "message": "Batch requests are not supported" }
}
```
