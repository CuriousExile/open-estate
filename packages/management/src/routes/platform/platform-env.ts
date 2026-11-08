import { LambdaClient } from '@aws-sdk/client-lambda';
import { SFNClient } from '@aws-sdk/client-sfn';
import {
  ADMIN_ENV,
  DynamoDbDeletionBlocklistStore,
  DynamoDbDeletionListingStore,
  DynamoDbDeletionRequestStore,
  StepFunctionsDeletionWorkflowStarter,
} from '@open-estate/admin';
import {
  ConfigError,
  createAdminOperations,
  DynamoDbAdminAuditLog,
  DynamoDbApiKeyStore,
  reloadFunctions,
  SsmAccessConfigWriter,
} from '@open-estate/core';
import { readEnv } from '../../env';
import type { RouteGroupContext } from '../route-group';
import type { PlatformDeps } from './platform-deps';

// Production wiring of `/platform/*`: the same tables, SSM parameters and state machine as the
// Admin-Lambda (`ADMIN_ENV`), so both APIs operate on identical state (Req 10.7).

/** Environment variables of the platform routes: `ADMIN_ENV` plus the reload targets. */
export const PLATFORM_ENV = {
  ...ADMIN_ENV,
  /**
   * Comma-separated Lambda function names `POST /platform/reload` restarts (API, MCP,
   * connectors); the role may update only these and the management function itself, which the
   * reload adds from `AWS_LAMBDA_FUNCTION_NAME` (design: "Management_API").
   */
  reloadFunctions: 'RELOAD_FUNCTION_NAMES',
} as const;

/** AWS clients only the platform routes need; created lazily at init. */
export interface PlatformClients {
  sfn?: SFNClient;
  lambda?: LambdaClient;
}

/** Comma-separated names → list; empty entries dropped, at least one required. */
export function parseFunctionNames(value: string): string[] {
  const names = [
    ...new Set(
      value
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== ''),
    ),
  ];
  if (names.length === 0) throw new ConfigError('CONFIG_INVALID', [PLATFORM_ENV.reloadFunctions]);
  return names;
}

/**
 * Variable the Lambda runtime sets to the function's own name. The Management_API reads taxonomy,
 * allowlists and `duplicate-detection.json` at cold start like the other targets, but cannot name
 * itself in its own environment (a CloudFormation cycle), so it adds itself from here.
 */
export const OWN_FUNCTION_NAME_ENV = 'AWS_LAMBDA_FUNCTION_NAME';

/**
 * Reload targets plus the running function itself, last: its own new configuration only reaches
 * later execution environments, so the answer still reports every other target.
 */
export function withSelf(
  names: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const self = env[OWN_FUNCTION_NAME_ENV]?.trim();
  if (self === undefined || self === '') return [...names];
  return [...names.filter((name) => name !== self), self];
}

interface Sendable {
  send(...args: never[]): Promise<unknown>;
}

/**
 * The client with every `send` bound to `signal`, so a request past its deadline cancels its
 * pending AWS calls. Other members are forwarded to the client unchanged.
 */
export function withSignal<C extends Sendable>(client: C, signal: AbortSignal): C {
  return new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property === 'send') {
        const send = value as (command: unknown, options?: object) => Promise<unknown>;
        return (command: unknown, options?: object) =>
          send.call(target, command, { ...options, abortSignal: signal });
      }
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

/** Reads `PLATFORM_ENV` and builds signal-bound use cases per request. Throws `ConfigError`. */
export function platformDepsFromEnv(
  { env, clients, shared }: RouteGroupContext,
  platformClients: PlatformClients = {},
): PlatformDeps {
  const config = readEnv(env, PLATFORM_ENV);
  const functionNames = withSelf(parseFunctionNames(config.reloadFunctions), env);
  const sfnClient = platformClients.sfn ?? new SFNClient({});
  const lambdaClient = platformClients.lambda ?? new LambdaClient({});

  const listingStore = (signal: AbortSignal) =>
    new DynamoDbDeletionListingStore({
      client: withSignal(clients.dynamo, signal),
      listingsTable: config.listingsTable,
      deletionRequestsTable: config.deletionRequestsTable,
    });

  return {
    operations(signal) {
      const dynamo = withSignal(clients.dynamo, signal);
      return createAdminOperations({
        apiKeys: new DynamoDbApiKeyStore({ client: dynamo, tableName: config.apiKeysTable }),
        accessConfig: new SsmAccessConfigWriter({
          client: withSignal(clients.ssm, signal),
          accessModeParameter: config.accessModeParameter,
          rateLimitParameter: config.rateLimitParameter,
        }),
        audit: new DynamoDbAdminAuditLog({ client: dynamo, tableName: config.auditLogTable }),
        clock: shared.clock,
        deletions: {
          requests: new DynamoDbDeletionRequestStore({
            client: dynamo,
            tableName: config.deletionRequestsTable,
          }),
          listings: listingStore(signal),
          blocklist: new DynamoDbDeletionBlocklistStore({
            client: dynamo,
            tableName: config.deletionBlocklistTable,
          }),
          starter: new StepFunctionsDeletionWorkflowStarter({
            client: withSignal(sfnClient, signal),
            stateMachineArn: config.deletionStateMachineArn,
          }),
        },
      });
    },
    deletionTargets: listingStore,
    reload: (signal) => reloadFunctions(withSignal(lambdaClient, signal), functionNames),
  };
}
