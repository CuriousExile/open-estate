// Lambda entry of a connector run (handler: `connector-handler.handler`), bundled by the
// IngestionStack. Not re-exported from the package index: the init starts at module load.
import { createConnectorHandlerFromEnv } from './connector-lambda';

export const handler = createConnectorHandlerFromEnv(process.env);
