// Lambda entry for `GET /listings` and `GET /listings/{id}` (handler: `listings.handler`). The config init starts at module
// load (Lambda init phase) and is awaited per request; an init failure answers every request with
// 503 SERVICE_UNAVAILABLE and logs the ConfigError names (Req 9.4, 15.4).
import { createListingsHandlerFromEnv } from './listings-lambda';

export const handler = createListingsHandlerFromEnv(process.env);
