// Lambda entry for `/admin/*` (handler: `admin.handler`). Built once at init; missing
// configuration aborts the init with a ConfigError naming the variables (Req 9.4).
import { createAdminHandlerFromEnv } from './admin-lambda';

export const handler = createAdminHandlerFromEnv(process.env);
