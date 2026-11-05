// Lambda entry of the Management_API (handler: `management.handler`). Not re-exported by the
// package index, so importing the package never triggers the init.
import { createManagementHandlerFromEnv } from './management-lambda';

export const handler = createManagementHandlerFromEnv(process.env);
