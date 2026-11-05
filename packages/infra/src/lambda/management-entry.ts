// Lambda entry of the Management_API as deployed by the ManagementStack: the handler of
// `@open-estate/management` (`management.handler`) with the CORS policy of `management-cors.ts`.
// Not re-exported (module-level init).
import { createManagementHandlerFromEnv } from '@open-estate/management';
import { MANAGEMENT_CORS_ENV, parseAllowedOrigins, withManagementCors } from './management-cors';

export const handler = withManagementCors(
  createManagementHandlerFromEnv(process.env),
  parseAllowedOrigins(process.env[MANAGEMENT_CORS_ENV]),
);
