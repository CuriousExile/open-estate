import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SFNClient } from '@aws-sdk/client-sfn';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoDbApiKeyStore, SsmAccessConfigWriter } from '@open-estate/core';
import { createAdminHandler, type AdminHandler } from './admin-handler';
import { DynamoDbAuditLog } from './audit-log';
import {
  DELETION_ENV,
  DynamoDbDeletionBlocklistStore,
  DynamoDbDeletionListingStore,
  DynamoDbDeletionRequestStore,
  readEnv,
  StepFunctionsDeletionWorkflowStarter,
} from './deletion';

/** Environment variables of the admin Lambda (set by the CDK stack, 14.10). */
export const ADMIN_ENV = {
  apiKeysTable: 'API_KEYS_TABLE_NAME',
  /** Same SSM parameter names the AccessGuard of API and MCP reads. */
  accessModeParameter: 'ACCESS_MODE_PARAMETER_NAME',
  rateLimitParameter: 'RATE_LIMIT_PARAMETER_NAME',
  /** Tables of the deletion process, including `AUDIT_LOG_TABLE_NAME`. */
  ...DELETION_ENV,
  /** Step Functions state machine of the deletion workflow. */
  deletionStateMachineArn: 'DELETION_STATE_MACHINE_ARN',
} as const;

export type AdminEnv = Record<keyof typeof ADMIN_ENV, string>;

/** Throws `ConfigError{code:"CONFIG_MISSING"}` naming every missing or empty variable (Req 9.4). */
export function readAdminEnv(env: NodeJS.ProcessEnv): AdminEnv {
  return readEnv(env, ADMIN_ENV);
}

export interface AdminClients {
  dynamo?: DynamoDBDocumentClient;
  ssm?: SSMClient;
  sfn?: SFNClient;
}

/** Builds the production handler (DynamoDB, SSM, Step Functions) from the environment. */
export function createAdminHandlerFromEnv(
  env: NodeJS.ProcessEnv,
  clients: AdminClients = {},
): AdminHandler {
  const config = readAdminEnv(env);
  const dynamo = clients.dynamo ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const ssm = clients.ssm ?? new SSMClient({});
  const sfn = clients.sfn ?? new SFNClient({});
  return createAdminHandler({
    apiKeys: new DynamoDbApiKeyStore({ client: dynamo, tableName: config.apiKeysTable }),
    accessConfig: new SsmAccessConfigWriter({
      client: ssm,
      accessModeParameter: config.accessModeParameter,
      rateLimitParameter: config.rateLimitParameter,
    }),
    audit: new DynamoDbAuditLog({ client: dynamo, tableName: config.auditLogTable }),
    deletions: {
      requests: new DynamoDbDeletionRequestStore({
        client: dynamo,
        tableName: config.deletionRequestsTable,
      }),
      listings: new DynamoDbDeletionListingStore({
        client: dynamo,
        listingsTable: config.listingsTable,
        deletionRequestsTable: config.deletionRequestsTable,
      }),
      blocklist: new DynamoDbDeletionBlocklistStore({
        client: dynamo,
        tableName: config.deletionBlocklistTable,
      }),
      starter: new StepFunctionsDeletionWorkflowStarter({
        client: sfn,
        stateMachineArn: config.deletionStateMachineArn,
      }),
    },
  });
}
