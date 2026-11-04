import { LambdaClient } from '@aws-sdk/client-lambda';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { parseCommand, usage, UsageError, type CliCommand } from './args';
import { reloadFunctions, type LambdaConfigClient } from './reload';
import {
  createSigner,
  resolveRegion,
  resolveTarget,
  sendAdminCall,
  type Credentials,
  type RequestSigner,
} from './signed-client';

export const EXIT_OK = 0;
/** API error response, network/credential error or failed reload. */
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  io: CliIo;
  fetch?: typeof fetch;
  /** Default: the AWS default credential chain (env, profile, SSO, container, IMDS). */
  credentials?: (profile: string | undefined) => Credentials;
  signer?: (region: string, credentials: Credentials) => RequestSigner;
  lambda?: (region: string | undefined, credentials: Credentials) => LambdaConfigClient;
  now?: () => Date;
}

/** Shown on stderr whenever a response carries the plaintext API key. */
export const API_KEY_NOTICE =
  'NOTE: "apiKey" is the plaintext API key. It is shown only this once and cannot be retrieved again; store it securely now.';

const defaultCredentials = (profile: string | undefined): Credentials =>
  defaultProvider(profile === undefined ? {} : { profile });

const defaultLambda = (region: string | undefined, credentials: Credentials) =>
  new LambdaClient({ ...(region !== undefined && { region }), credentials });

const toJson = (value: unknown): string => JSON.stringify(value, null, 2);

const describeError = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

const hasApiKey = (body: unknown): boolean =>
  typeof body === 'object' && body !== null && 'apiKey' in body;

async function execute(
  command: Exclude<CliCommand, { kind: 'help' }>,
  deps: CliDeps,
): Promise<number> {
  const { io, env } = deps;
  const credentials = (deps.credentials ?? defaultCredentials)(command.global.profile);

  if (command.kind === 'reload') {
    const region = resolveRegion(command.global.region, env);
    const client = (deps.lambda ?? defaultLambda)(region, credentials);
    const outcomes = await reloadFunctions(client, command.functions);
    io.stdout(toJson({ functions: outcomes }));
    const failed = outcomes.filter((outcome) => outcome.status === 'failed');
    for (const outcome of failed) io.stderr(`reload failed: ${outcome.functionName}`);
    return failed.length === 0 ? EXIT_OK : EXIT_FAILURE;
  }

  const target = resolveTarget(command.global, env);
  const response = await sendAdminCall(command.call, target, {
    signer: (deps.signer ?? createSigner)(target.region, credentials),
    fetch: deps.fetch ?? fetch,
    ...(deps.now !== undefined && { now: deps.now }),
  });
  if (response.status >= 200 && response.status < 300) {
    if (command.name === 'create-key' && hasApiKey(response.body)) io.stderr(API_KEY_NOTICE);
    io.stdout(toJson(response.body ?? { status: response.status }));
    return EXIT_OK;
  }
  io.stderr(`HTTP ${response.status} ${command.call.method} ${command.call.path}`);
  io.stderr(toJson(response.body));
  return EXIT_FAILURE;
}

/**
 * Runs `open-estate-admin` and returns the exit code: results as JSON on stdout, diagnostics on
 * stderr. Credentials and signatures are never printed.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  let command: CliCommand;
  try {
    command = parseCommand(argv, deps.env);
  } catch (cause) {
    deps.io.stderr(`${describeError(cause)}\n\n${usage()}`);
    return EXIT_USAGE;
  }
  if (command.kind === 'help') {
    deps.io.stdout(command.text);
    return EXIT_OK;
  }
  try {
    return await execute(command, deps);
  } catch (cause) {
    deps.io.stderr(describeError(cause));
    return cause instanceof UsageError ? EXIT_USAGE : EXIT_FAILURE;
  }
}
