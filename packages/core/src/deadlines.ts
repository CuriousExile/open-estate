// Time budgets of the request paths (design: "Observability"). One place, so providers and
// handlers cannot drift apart.

/** Response budget of the Search_API (Req 9.1: answer within 5 s). */
export const API_RESPONSE_BUDGET_MS = 5_000;

/**
 * Budget of all downstream calls (DynamoDB, OpenSearch) of one request: below the 5-s response
 * budget, leaving 500 ms for guard, validation and serialization (Req 9.1); far below the 10-s
 * abort of Req 9.6.
 */
export const DOWNSTREAM_DEADLINE_MS = API_RESPONSE_BUDGET_MS - 500;

/**
 * Overall deadline of one MCP request (Req 19.10). Separate from the API budget, but every
 * downstream call inside it still uses `DOWNSTREAM_DEADLINE_MS`, so a tool call fails with
 * `SERVICE_UNAVAILABLE` long before this deadline unless several calls queue up.
 */
export const MCP_REQUEST_DEADLINE_MS = 10_000;
