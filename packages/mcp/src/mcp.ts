// Lambda entry for `POST /mcp` (handler: `mcp.handler`). The config init starts at module load
// (Lambda init phase); an init failure answers every request with 503 SERVICE_UNAVAILABLE.
import { createMcpHandlerFromEnv } from './mcp-lambda';

export const handler = createMcpHandlerFromEnv(process.env);
