// Feature: real-estate-platform, Property 23: Start-Validierung der Konfiguration
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { ConfigError, loadConfig, type ConfigSources } from '@open-estate/core';
import fc from 'fast-check';
import { z } from 'zod';

/**
 * Property 23: a configuration with any missing or empty required value aborts the
 * init with `CONFIG_MISSING` naming exactly the affected names (values, file keys,
 * `CONFIG_BUCKET`); a complete configuration loads and returns exactly the values.
 * Files that exist but are malformed or violate the schema fail `loadJson` with
 * `CONFIG_INVALID` naming exactly that file.
 *
 * **Validates: Requirements 9.4, 11.2**
 */

const REGION = 'eu-central-1';
const BUCKET = 'test-config-bucket';

type Source = 'env' | 'ssm' | 'secret';
type ValueState = 'present' | 'blank' | 'missing';
type FileState = 'valid' | 'missing' | 'empty' | 'broken' | 'schemaInvalid';

interface ValueCase {
  name: string;
  source: Source;
  state: ValueState;
  /** Non-blank for `present`, whitespace-only for `blank`. */
  value: string;
}

interface FileCase {
  key: string;
  state: FileState;
  body: string;
  /** Parsed content for `valid` files. */
  expected?: Theme;
}

const themeSchema = z.object({
  colors: z.object({ primary: z.string().regex(/^#[0-9A-F]{6}$/i) }),
});
type Theme = z.infer<typeof themeSchema>;

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const UPPER_DIGITS = [...UPPER, ...'0123456789'.split('')];
const HEX = '0123456789ABCDEFabcdef'.split('');
const WHITESPACE = [' ', '\t', '\n', '\r'];

/** No `_`, so a logical name never collides with `<NAME>_SSM_PARAMETER`, `<NAME>_SECRET_ID` or `CONFIG_BUCKET`. */
const arbName = fc
  .tuple(
    fc.constantFrom(...UPPER),
    fc.string({ unit: fc.constantFrom(...UPPER_DIGITS), maxLength: 7 }),
  )
  .map(([head, tail]) => head + tail);
const arbFileKey = fc
  .string({
    unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
    minLength: 1,
    maxLength: 10,
  })
  .map((s) => `${s}.json`);

/** `v@l:` cannot occur in names, file keys or the error code, so leak checks are unambiguous. */
const arbPresentValue = fc.string({ minLength: 1, maxLength: 20 }).map((s) => `v@l:${s}`);
const arbBlankValue = fc.string({ unit: fc.constantFrom(...WHITESPACE), maxLength: 3 });

const arbValueCase = (name: string, complete: boolean): fc.Arbitrary<ValueCase> =>
  fc
    .record({
      source: fc.constantFrom<Source>('env', 'ssm', 'secret'),
      state: complete
        ? fc.constant<ValueState>('present')
        : fc.constantFrom<ValueState>('present', 'blank', 'missing'),
      present: arbPresentValue,
      blank: arbBlankValue,
    })
    .map(({ source, state, present, blank }) => ({
      name,
      source,
      state,
      value: state === 'blank' ? blank : present,
    }));

const arbTheme: fc.Arbitrary<Theme> = fc
  .string({ unit: fc.constantFrom(...HEX), minLength: 6, maxLength: 6 })
  .map((hex) => ({ colors: { primary: `#${hex}` } }));

const arbBrokenJson = fc
  .oneof(
    fc.constantFrom('{oops', '{"colors":', '[1,', 'nul', "{'a':1}", '{"a":1}}'),
    fc.string({ maxLength: 20 }).map((s) => `{${s}`),
  )
  .filter((s) => {
    if (s.trim() === '') return false;
    try {
      JSON.parse(s);
      return false;
    } catch {
      return true;
    }
  });

const arbSchemaInvalidJson = fc.oneof(
  fc.constantFrom('[]', '42', 'null', '"text"', '{}', '{"colors":{}}'),
  fc
    .string({ maxLength: 10 })
    .filter((s) => !/^#[0-9A-F]{6}$/i.test(s))
    .map((primary) => JSON.stringify({ colors: { primary } })),
);

/** In a complete configuration every file exists and is non-empty (content may still be invalid). */
const arbFileCase = (key: string, complete: boolean): fc.Arbitrary<FileCase> => {
  const loadable: fc.Arbitrary<FileCase>[] = [
    arbTheme.map((t) => ({ key, state: 'valid' as const, body: JSON.stringify(t), expected: t })),
    arbBrokenJson.map((body) => ({ key, state: 'broken' as const, body })),
    arbSchemaInvalidJson.map((body) => ({ key, state: 'schemaInvalid' as const, body })),
  ];
  if (complete) return fc.oneof(...loadable);
  return fc.oneof(
    ...loadable,
    fc.constant({ key, state: 'missing' as const, body: '' }),
    arbBlankValue.map((body) => ({ key, state: 'empty' as const, body })),
  );
};

/**
 * Half of the runs are complete configurations (all values present, files loadable,
 * bucket set); otherwise states are free, so failures and successes both get coverage.
 */
const arbScenario = fc.boolean().chain((complete) =>
  fc.record({
    values: fc
      .uniqueArray(arbName, { maxLength: 8 })
      .chain((names) => fc.tuple(...names.map((n) => arbValueCase(n, complete)))),
    files: fc
      .uniqueArray(arbFileKey, { maxLength: 4 })
      .chain((keys) => fc.tuple(...keys.map((k) => arbFileCase(k, complete)))),
    // Unset bucket must yield CONFIG_BUCKET; mostly set so file states are exercised.
    bucketSet: complete
      ? fc.constant(true)
      : fc.oneof(
          { arbitrary: fc.constant(true), weight: 3 },
          { arbitrary: fc.constant(false), weight: 1 },
        ),
  }),
);

const awsError = (name: string) => Object.assign(new Error(name), { name });

/** Builds env and stubbed AWS clients (real clients, `send` mocked; no AWS calls). */
function setup(values: readonly ValueCase[], files: readonly FileCase[], bucketSet: boolean) {
  const env: Record<string, string> = {};
  const ssmStore: Record<string, string> = {};
  const secretStore: Record<string, string> = {};
  const fileStore: Record<string, string> = {};

  for (const { name, source, state, value } of values) {
    if (source === 'env') {
      if (state !== 'missing') env[name] = value;
    } else if (source === 'ssm') {
      const parameter = `/oe/test/${name}`;
      env[`${name}_SSM_PARAMETER`] = parameter;
      if (state !== 'missing') ssmStore[parameter] = value;
    } else {
      const secretId = `oe/test/${name}`;
      env[`${name}_SECRET_ID`] = secretId;
      if (state !== 'missing') secretStore[secretId] = value;
    }
  }
  for (const { key, state, body } of files) {
    if (state !== 'missing') fileStore[key] = body;
  }
  if (bucketSet) env.CONFIG_BUCKET = BUCKET;

  const ssm = new SSMClient({ region: REGION });
  const s3 = new S3Client({ region: REGION });
  const secretsManager = new SecretsManagerClient({ region: REGION });

  jest.spyOn(ssm, 'send').mockImplementation(async (command: unknown) => {
    if (!(command instanceof GetParametersCommand)) throw new Error('unexpected command');
    const names = command.input.Names ?? [];
    return {
      Parameters: names
        .filter((n) => ssmStore[n] !== undefined)
        .map((n) => ({ Name: n, Value: ssmStore[n] })),
      InvalidParameters: names.filter((n) => ssmStore[n] === undefined),
    };
  });
  jest.spyOn(s3, 'send').mockImplementation(async (command: unknown) => {
    if (!(command instanceof GetObjectCommand)) throw new Error('unexpected command');
    expect(command.input.Bucket).toBe(BUCKET);
    const body = fileStore[command.input.Key ?? ''];
    if (body === undefined) throw awsError('NoSuchKey');
    return { Body: { transformToString: async () => body } };
  });
  jest.spyOn(secretsManager, 'send').mockImplementation(async (command: unknown) => {
    if (!(command instanceof GetSecretValueCommand)) throw new Error('unexpected command');
    const secret = secretStore[command.input.SecretId ?? ''];
    if (secret === undefined) throw awsError('ResourceNotFoundException');
    return { SecretString: secret };
  });

  const sources: ConfigSources = { env, ssm, s3, secretsManager };
  return sources;
}

/** Names the init must report as missing. */
function expectedMissing(
  values: readonly ValueCase[],
  files: readonly FileCase[],
  bucketSet: boolean,
): string[] {
  const missing = values.filter((v) => v.state !== 'present').map((v) => v.name);
  if (files.length > 0) {
    if (!bucketSet) missing.push('CONFIG_BUCKET');
    else
      missing.push(
        ...files.filter((f) => f.state === 'missing' || f.state === 'empty').map((f) => f.key),
      );
  }
  return missing.sort();
}

function syncConfigError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error('expected ConfigError');
}

describe('Property 23: Start-Validierung der Konfiguration', () => {
  afterEach(() => jest.restoreAllMocks());

  it('aborts with exactly the missing/empty names, otherwise starts with exactly the values', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async ({ values, files, bucketSet }) => {
        const sources = setup(values, files, bucketSet);
        const names = values.map((v) => v.name);
        const keys = files.map((f) => f.key);
        const missing = expectedMissing(values, files, bucketSet);

        const outcome = await loadConfig({ values: names, files: keys }, sources).then(
          (config) => ({ config }),
          (error: unknown) => ({ error }),
        );

        if (missing.length > 0) {
          expect('error' in outcome).toBe(true);
          if (!('error' in outcome)) return;
          const error = outcome.error;
          expect(error).toBeInstanceOf(ConfigError);
          if (!(error instanceof ConfigError)) return;
          expect(error.code).toBe('CONFIG_MISSING');
          expect([...error.names].sort()).toEqual(missing);
          // Values must never leak into the error description.
          const description = `${error.message} ${JSON.stringify(error.toJSON())}`;
          for (const v of values) {
            if (v.state === 'present') expect(description).not.toContain(v.value);
          }
          return;
        }

        expect('config' in outcome).toBe(true);
        if (!('config' in outcome)) return;
        const { config } = outcome;
        expect(config.requireAll(names)).toEqual(
          Object.fromEntries(values.map((v) => [v.name, v.value])),
        );
        for (const file of files) {
          if (file.state === 'valid') {
            expect(config.loadJson(file.key, themeSchema)).toEqual(file.expected);
          } else {
            const error = syncConfigError(() => config.loadJson(file.key, themeSchema));
            expect(error.code).toBe('CONFIG_INVALID');
            expect(error.names).toEqual([file.key]);
            expect(error.issues?.length).toBeGreaterThan(0);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
