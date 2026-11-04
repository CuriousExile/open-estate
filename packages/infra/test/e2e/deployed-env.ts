import {
  CloudFormationClient,
  DescribeStacksCommand,
  paginateListStackResources,
} from '@aws-sdk/client-cloudformation';
import { resolveEnvironment } from '../../src/config';

// Shared harness of the `*.e2e.test.ts` suites (task 19.5). They run against a deployed test
// environment and are skipped unless `OPEN_ESTATE_E2E_ENV` names one (`npm run test:e2e`, see
// docs/installation.md → "End-to-end tests"). AWS credentials and region come from the SDK chain.

/** Environment name (`-c env=<name>` of the deployment) whose stacks the suites test. */
export const E2E_ENV_VAR = 'OPEN_ESTATE_E2E_ENV';
/**
 * Opt-in for suites that temporarily change deployed resources (the downstream fault of Req 9.5,
 * 9.6). Only `true` enables them; use a dedicated test environment.
 */
export const E2E_FAULT_INJECTION_VAR = 'OPEN_ESTATE_E2E_FAULT_INJECTION';

const envName = process.env[E2E_ENV_VAR]?.trim() || undefined;

export const describeE2e = envName === undefined ? describe.skip : describe;
export const describeFaultInjection =
  envName !== undefined && process.env[E2E_FAULT_INJECTION_VAR] === 'true'
    ? describe
    : describe.skip;

/** Suffix of a stack name after `OpenEstate-<env>-` (`src/app.ts`). */
export type StackSuffix = 'Data' | 'Api' | 'Admin' | 'Frontend';

export function stackName(suffix: StackSuffix): string {
  if (envName === undefined) throw new Error(`${E2E_ENV_VAR} is not set`);
  return `${resolveEnvironment(envName).stackPrefix}-${suffix}`;
}

let cloudFormation: CloudFormationClient | undefined;
const client = () => (cloudFormation ??= new CloudFormationClient({}));

/** Output `key` of the environment's stack `suffix`; throws if it is missing. */
export async function stackOutput(suffix: StackSuffix, key: string): Promise<string> {
  const name = stackName(suffix);
  const { Stacks } = await client().send(new DescribeStacksCommand({ StackName: name }));
  const value = Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === key)?.OutputValue;
  if (!value) throw new Error(`Stack ${name} has no output ${key}`);
  return value;
}

/**
 * Physical id of the single resource of `type` whose logical id starts with the construct id
 * `constructId` (CDK appends a hash), e.g. the `SiteBucket` of the FrontendStack.
 */
export async function stackResource(
  suffix: StackSuffix,
  constructId: string,
  type: string,
): Promise<string> {
  const name = stackName(suffix);
  const ids: string[] = [];
  for await (const page of paginateListStackResources({ client: client() }, { StackName: name })) {
    for (const resource of page.StackResourceSummaries ?? []) {
      if (
        resource.ResourceType === type &&
        resource.LogicalResourceId?.startsWith(constructId) &&
        resource.PhysicalResourceId
      ) {
        ids.push(resource.PhysicalResourceId);
      }
    }
  }
  if (ids.length !== 1) {
    throw new Error(`Expected one ${type} "${constructId}*" in ${name}, found ${ids.length}`);
  }
  return ids[0] as string;
}

export interface TimedResponse {
  status: number;
  headers: Headers;
  body: string;
  /** Request start to fully read body. */
  ms: number;
}

/** `fetch` that also measures the time until the body is read (hard limit 30 s). */
export async function timedFetch(
  url: string | URL,
  init: RequestInit = {},
): Promise<TimedResponse> {
  const start = performance.now();
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const body = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body,
    ms: performance.now() - start,
  };
}

/** First error code of an `ErrorResponse` body (`{"errors":[{"code":…}]}`), if any. */
export function errorCode(body: string): string | undefined {
  try {
    return (JSON.parse(body) as { errors?: { code?: string }[] }).errors?.[0]?.code;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Calls `probe` until it returns a value other than `undefined`; throws after `timeoutMs`. */
export async function pollUntil<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number },
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() + intervalMs > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

/** Unique, URL-safe marker of one test run (ids, texts). */
export function runMarker(): string {
  return `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
