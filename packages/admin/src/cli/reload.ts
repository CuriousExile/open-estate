import {
  GetFunctionConfigurationCommand,
  UpdateFunctionConfigurationCommand,
  type LambdaClient,
} from '@aws-sdk/client-lambda';

/**
 * Environment variable whose change forces cold starts (design: „Neustart“, Req 15.3, 16.8).
 * Lambda configuration (taxonomy, tour and crawler allowlists) is loaded at init only.
 */
export const CONFIG_VERSION_VARIABLE = 'CONFIG_VERSION';

/** Non-negative integer → +1; missing or anything else → `"1"`. */
export function nextConfigVersion(current: string | undefined): string {
  return current !== undefined && /^\d+$/.test(current) ? (BigInt(current) + 1n).toString() : '1';
}

export type ReloadOutcome =
  | {
      functionName: string;
      status: 'updated';
      previousConfigVersion: string | null;
      configVersion: string;
    }
  | { functionName: string; status: 'failed'; error: string };

export type LambdaConfigClient = Pick<LambdaClient, 'send'>;

/**
 * Sets `CONFIG_VERSION` to the next value. `UpdateFunctionConfiguration` replaces the whole
 * environment, so all other variables are written back unchanged; `RevisionId` makes a
 * concurrent change (e.g. a running `cdk deploy`) fail instead of being overwritten. Variable
 * values are never returned or logged.
 */
export async function reloadFunction(
  client: LambdaConfigClient,
  functionName: string,
): Promise<ReloadOutcome> {
  const config = await client.send(
    new GetFunctionConfigurationCommand({ FunctionName: functionName }),
  );
  const environment = config.Environment;
  if (environment?.Error !== undefined) {
    // Without readable values (e.g. no kms:Decrypt) writing back would erase the environment.
    throw new Error(
      `Environment of ${functionName} is not readable (${environment.Error.ErrorCode ?? 'unknown error'})`,
    );
  }
  const variables = { ...environment?.Variables };
  const previous = variables[CONFIG_VERSION_VARIABLE];
  const configVersion = nextConfigVersion(previous);
  variables[CONFIG_VERSION_VARIABLE] = configVersion;

  await client.send(
    new UpdateFunctionConfigurationCommand({
      FunctionName: functionName,
      Environment: { Variables: variables },
      RevisionId: config.RevisionId,
    }),
  );
  return {
    functionName,
    status: 'updated',
    previousConfigVersion: previous ?? null,
    configVersion,
  };
}

/** Reloads each function in turn; a failure is reported and does not stop the others. */
export async function reloadFunctions(
  client: LambdaConfigClient,
  functionNames: readonly string[],
): Promise<ReloadOutcome[]> {
  const outcomes: ReloadOutcome[] = [];
  for (const functionName of functionNames) {
    try {
      outcomes.push(await reloadFunction(client, functionName));
    } catch (cause) {
      const error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      outcomes.push({ functionName, status: 'failed', error });
    }
  }
  return outcomes;
}
