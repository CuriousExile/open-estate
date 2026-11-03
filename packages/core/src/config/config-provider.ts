import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { ZodType } from 'zod';
import { ConfigError, type ConfigIssue } from './config-error';

/**
 * Access to external configuration (Req 9.3, 9.4, 11.1, 11.2).
 *
 * AWS reads are async, the design's interface is sync: `loadConfig` fetches and
 * caches everything during the Lambda init (fail fast), after which `requireAll`
 * and `loadJson` are pure, synchronous cache lookups.
 */
export interface ConfigProvider {
  /** Throws `ConfigError{code:"CONFIG_MISSING"}` naming every missing or empty value. */
  requireAll(names: readonly string[]): Record<string, string>;
  /** Throws `ConfigError{code:"CONFIG_MISSING"|"CONFIG_INVALID"}`; invalid includes `issues`. */
  loadJson<T>(key: string, schema: ZodType<T>): T;
}

/** What to fetch during init. */
export interface ConfigLoadRequest {
  /** Logical names of scalar values, resolved per {@link loadConfig}. */
  values?: readonly string[];
  /** Object keys of JSON files in the private config bucket. */
  files?: readonly string[];
}

/** Injectable sources; clients default to SDK defaults (region/credentials from the environment). */
export interface ConfigSources {
  env?: Readonly<Record<string, string | undefined>>;
  ssm?: SSMClient;
  s3?: S3Client;
  secretsManager?: SecretsManagerClient;
}

/** `<NAME>_SSM_PARAMETER` holds the SSM parameter name of value `<NAME>`. */
export const SSM_PARAMETER_SUFFIX = '_SSM_PARAMETER';
/** `<NAME>_SECRET_ID` holds the Secrets Manager secret id of value `<NAME>`. */
export const SECRET_ID_SUFFIX = '_SECRET_ID';
/** Environment variable holding the private config bucket name. */
export const CONFIG_BUCKET_ENV = 'CONFIG_BUCKET';

/** GetParameters accepts at most 10 names per call. */
const SSM_BATCH_SIZE = 10;

const isEmpty = (value: string | undefined): value is undefined | '' =>
  value === undefined || value.trim() === '';

const errorName = (error: unknown): string | undefined =>
  error instanceof Error ? error.name : undefined;

/**
 * Loads all requested values and files once and returns a cached provider.
 *
 * Resolution per value `<NAME>` (first match wins):
 * 1. environment variable `<NAME>` (if set; empty counts as missing),
 * 2. SSM parameter named by `<NAME>_SSM_PARAMETER` (decrypted, batched),
 * 3. Secrets Manager secret identified by `<NAME>_SECRET_ID` (`SecretString`).
 *
 * Files are read from the bucket named by `CONFIG_BUCKET`.
 * Throws one `ConfigError{code:"CONFIG_MISSING"}` listing every missing or empty
 * value/file; other AWS errors (e.g. access denied) propagate unchanged.
 */
export async function loadConfig(
  request: ConfigLoadRequest,
  sources: ConfigSources = {},
): Promise<ConfigProvider> {
  const env = sources.env ?? process.env;
  const values = new Map<string, string>();
  const missing: string[] = [];

  const ssmRefs = new Map<string, string[]>(); // parameter name -> logical names
  const secretRefs = new Map<string, string>(); // logical name -> secret id
  for (const name of new Set(request.values ?? [])) {
    const direct = env[name];
    const parameter = env[name + SSM_PARAMETER_SUFFIX];
    const secretId = env[name + SECRET_ID_SUFFIX];
    if (direct !== undefined) {
      if (isEmpty(direct)) missing.push(name);
      else values.set(name, direct);
    } else if (!isEmpty(parameter)) {
      ssmRefs.set(parameter, [...(ssmRefs.get(parameter) ?? []), name]);
    } else if (!isEmpty(secretId)) {
      secretRefs.set(name, secretId);
    } else {
      missing.push(name);
    }
  }

  const files = new Map<string, string>();
  const fileKeys = [...new Set(request.files ?? [])];
  const bucket = env[CONFIG_BUCKET_ENV];

  // Clients are only created when needed, so unused sources need no region/credentials.
  const tasks: Promise<void>[] = [];
  if (ssmRefs.size > 0) {
    tasks.push(loadSsm(sources.ssm ?? new SSMClient({}), ssmRefs, values, missing));
  }
  if (secretRefs.size > 0) {
    const client = sources.secretsManager ?? new SecretsManagerClient({});
    for (const [name, secretId] of secretRefs) {
      tasks.push(loadSecret(client, name, secretId, values, missing));
    }
  }
  if (fileKeys.length > 0) {
    if (isEmpty(bucket)) {
      missing.push(CONFIG_BUCKET_ENV);
    } else {
      const client = sources.s3 ?? new S3Client({});
      for (const key of fileKeys) tasks.push(loadFile(client, bucket, key, files, missing));
    }
  }
  await Promise.all(tasks);

  if (missing.length > 0) throw new ConfigError('CONFIG_MISSING', missing.sort());
  return new CachedConfigProvider(values, files);
}

async function loadSsm(
  client: SSMClient,
  refs: ReadonlyMap<string, readonly string[]>,
  values: Map<string, string>,
  missing: string[],
): Promise<void> {
  const parameterNames = [...refs.keys()];
  const batches: string[][] = [];
  for (let i = 0; i < parameterNames.length; i += SSM_BATCH_SIZE) {
    batches.push(parameterNames.slice(i, i + SSM_BATCH_SIZE));
  }
  await Promise.all(
    batches.map(async (Names) => {
      const out = await client.send(new GetParametersCommand({ Names, WithDecryption: true }));
      const found = new Map<string, string>();
      for (const { Name, Value } of out.Parameters ?? []) {
        if (Name !== undefined && !isEmpty(Value)) found.set(Name, Value);
      }
      // Anything not returned with a value (incl. `InvalidParameters`) is missing.
      for (const parameterName of Names) {
        const value = found.get(parameterName);
        for (const name of refs.get(parameterName) ?? []) {
          if (value === undefined) missing.push(name);
          else values.set(name, value);
        }
      }
    }),
  );
}

async function loadSecret(
  client: SecretsManagerClient,
  name: string,
  secretId: string,
  values: Map<string, string>,
  missing: string[],
): Promise<void> {
  try {
    const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (isEmpty(out.SecretString)) missing.push(name);
    else values.set(name, out.SecretString);
  } catch (error) {
    if (errorName(error) !== 'ResourceNotFoundException') throw error;
    missing.push(name);
  }
}

async function loadFile(
  client: S3Client,
  bucket: string,
  key: string,
  files: Map<string, string>,
  missing: string[],
): Promise<void> {
  try {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await out.Body?.transformToString('utf-8');
    if (isEmpty(body)) missing.push(key);
    else files.set(key, body);
  } catch (error) {
    if (errorName(error) !== 'NoSuchKey') throw error;
    missing.push(key);
  }
}

class CachedConfigProvider implements ConfigProvider {
  constructor(
    private readonly values: ReadonlyMap<string, string>,
    private readonly files: ReadonlyMap<string, string>,
  ) {}

  requireAll(names: readonly string[]): Record<string, string> {
    const result: Record<string, string> = {};
    const missing: string[] = [];
    for (const name of names) {
      const value = this.values.get(name);
      if (value === undefined) missing.push(name);
      else result[name] = value;
    }
    if (missing.length > 0) throw new ConfigError('CONFIG_MISSING', missing);
    return result;
  }

  loadJson<T>(key: string, schema: ZodType<T>): T {
    const raw = this.files.get(key);
    if (raw === undefined) throw new ConfigError('CONFIG_MISSING', [key]);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ConfigError('CONFIG_INVALID', [key], [{ path: '', message }]);
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      const issues: ConfigIssue[] = result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      }));
      throw new ConfigError('CONFIG_INVALID', [key], issues);
    }
    return result.data;
  }
}
