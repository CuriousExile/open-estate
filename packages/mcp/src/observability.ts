import { createLogger, createMetrics } from '@open-estate/core';

// Module-scope Powertools instances of the MCP Lambda (one per instance, as recommended by
// Powertools). Tests spy on `logger` or inject their own `Metrics` into the handler factory.

export const MCP_SERVICE_NAME = 'open-estate-mcp';

export const logger = createLogger(MCP_SERVICE_NAME);
export const metrics = createMetrics(MCP_SERVICE_NAME);
