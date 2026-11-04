// Lambda entry for the Step Functions deletion workflow tasks (handler: `deletion-task.handler`).
// Built once at init; missing configuration aborts the init with a ConfigError (Req 9.4).
import { createDeletionTaskHandler, createDeletionWorkflowFromEnv } from './deletion';

export const handler = createDeletionTaskHandler(createDeletionWorkflowFromEnv(process.env));
