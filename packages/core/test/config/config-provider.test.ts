import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { ConfigError, loadConfig, type ConfigSources } from '@open-estate/core';
import { z } from 'zod';

const REGION = 'eu-central-1';
const BUCKET = 'test-config-bucket';

const awsError = (name: string) => Object.assign(new Error(name), { name });

/** Real clients with stubbed `send`; no AWS calls are made. */
function setup(
  env: Record<string, string | undefined>,
  data: {
    ssm?: Record<string, string>;
    files?: Record<string, string>;
    secrets?: Record<string, string>;
  } = {},
) {
  const ssm = new SSMClient({ region: REGION });
  const s3 = new S3Client({ region: REGION });
  const secretsManager = new SecretsManagerClient({ region: REGION });

  const ssmSend = jest.spyOn(ssm, 'send').mockImplementation(async (command: unknown) => {
    if (!(command instanceof GetParametersCommand)) throw new Error('unexpected command');
    const names = command.input.Names ?? [];
    return {
      Parameters: names
        .filter((n) => data.ssm?.[n] !== undefined)
        .map((n) => ({ Name: n, Value: data.ssm?.[n] })),
      InvalidParameters: names.filter((n) => data.ssm?.[n] === undefined),
    };
  });
  const s3Send = jest.spyOn(s3, 'send').mockImplementation(async (command: unknown) => {
    if (!(command instanceof GetObjectCommand)) throw new Error('unexpected command');
    const body = data.files?.[command.input.Key ?? ''];
    if (body === undefined) throw awsError('NoSuchKey');
    return { Body: { transformToString: async () => body } };
  });
  const secretsSend = jest
    .spyOn(secretsManager, 'send')
    .mockImplementation(async (command: unknown) => {
      if (!(command instanceof GetSecretValueCommand)) throw new Error('unexpected command');
      const secret = data.secrets?.[command.input.SecretId ?? ''];
      if (secret === undefined) throw awsError('ResourceNotFoundException');
      return { SecretString: secret };
    });

  const sources: ConfigSources = { env, ssm, s3, secretsManager };
  return { sources, ssmSend, s3Send, secretsSend };
}

async function configError(promise: Promise<unknown>): Promise<ConfigError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ConfigError);
  return error as ConfigError;
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

const themeSchema = z.object({
  colors: z.object({ primary: z.string().regex(/^#[0-9A-F]{6}$/i) }),
});

describe('loadConfig / ConfigProvider', () => {
  it('resolves values from env, SSM and Secrets Manager and validates JSON files', async () => {
    const { sources, ssmSend, s3Send, secretsSend } = setup(
      {
        TABLE_NAME: 'listings',
        RATE_LIMIT_SSM_PARAMETER: '/oe/test/rate-limit',
        CONNECTOR_TOKEN_SECRET_ID: 'oe/test/connector',
        CONFIG_BUCKET: BUCKET,
      },
      {
        ssm: { '/oe/test/rate-limit': '100' },
        secrets: { 'oe/test/connector': 's3cr3t' },
        files: { 'theme-config.json': '{"colors":{"primary":"#0B5FFF"}}' },
      },
    );

    const config = await loadConfig(
      { values: ['TABLE_NAME', 'RATE_LIMIT', 'CONNECTOR_TOKEN'], files: ['theme-config.json'] },
      sources,
    );

    expect(config.requireAll(['TABLE_NAME', 'RATE_LIMIT', 'CONNECTOR_TOKEN'])).toEqual({
      TABLE_NAME: 'listings',
      RATE_LIMIT: '100',
      CONNECTOR_TOKEN: 's3cr3t',
    });
    expect(config.loadJson('theme-config.json', themeSchema)).toEqual({
      colors: { primary: '#0B5FFF' },
    });
    expect((ssmSend.mock.calls[0]?.[0] as GetParametersCommand).input).toEqual({
      Names: ['/oe/test/rate-limit'],
      WithDecryption: true,
    });
    expect((s3Send.mock.calls[0]?.[0] as GetObjectCommand).input).toEqual({
      Bucket: BUCKET,
      Key: 'theme-config.json',
    });
    expect((secretsSend.mock.calls[0]?.[0] as GetSecretValueCommand).input).toEqual({
      SecretId: 'oe/test/connector',
    });
  });

  it('aborts with CONFIG_MISSING naming every missing and empty value', async () => {
    const { sources } = setup({ PRESENT: 'x', EMPTY: '   ' });
    const error = await configError(
      loadConfig({ values: ['PRESENT', 'MISSING', 'EMPTY'] }, sources),
    );

    expect(error.toJSON()).toEqual({ code: 'CONFIG_MISSING', names: ['EMPTY', 'MISSING'] });
    expect(error.message).toBe('CONFIG_MISSING: EMPTY, MISSING');
  });

  it('maps SSM InvalidParameters back to the logical value name', async () => {
    const { sources } = setup(
      { OK_SSM_PARAMETER: '/oe/ok', GONE_SSM_PARAMETER: '/oe/gone' },
      { ssm: { '/oe/ok': 'v' } },
    );
    const error = await configError(loadConfig({ values: ['OK', 'GONE'] }, sources));

    expect(error.toJSON()).toEqual({ code: 'CONFIG_MISSING', names: ['GONE'] });
  });

  it('batches SSM GetParameters in groups of at most 10 names', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `V${i}`);
    const env = Object.fromEntries(names.map((n) => [`${n}_SSM_PARAMETER`, `/oe/${n}`]));
    const ssm = Object.fromEntries(names.map((n) => [`/oe/${n}`, n.toLowerCase()]));
    const { sources, ssmSend } = setup(env, { ssm });

    const config = await loadConfig({ values: names }, sources);

    expect(
      ssmSend.mock.calls.map(([c]) => (c as GetParametersCommand).input.Names?.length),
    ).toEqual([10, 2]);
    expect(config.requireAll(['V11'])).toEqual({ V11: 'v11' });
  });

  it('reports missing secrets, missing/empty files and a missing bucket name as CONFIG_MISSING', async () => {
    const withBucket = setup(
      { TOKEN_SECRET_ID: 'oe/unknown', CONFIG_BUCKET: BUCKET },
      { files: { 'empty.json': '' } },
    );
    const error = await configError(
      loadConfig({ values: ['TOKEN'], files: ['empty.json', 'absent.json'] }, withBucket.sources),
    );
    expect(error.names).toEqual(['TOKEN', 'absent.json', 'empty.json']);

    const noBucket = setup({});
    const bucketError = await configError(
      loadConfig({ files: ['taxonomy.json'] }, noBucket.sources),
    );
    expect(bucketError.toJSON()).toEqual({ code: 'CONFIG_MISSING', names: ['CONFIG_BUCKET'] });
    expect(noBucket.s3Send).not.toHaveBeenCalled();
  });

  it('propagates non-config AWS errors unchanged', async () => {
    const { sources, s3Send } = setup({ CONFIG_BUCKET: BUCKET });
    s3Send.mockRejectedValueOnce(awsError('AccessDenied') as never);

    await expect(loadConfig({ files: ['taxonomy.json'] }, sources)).rejects.toMatchObject({
      name: 'AccessDenied',
    });
  });

  it('throws CONFIG_INVALID for malformed JSON', async () => {
    const { sources } = setup(
      { CONFIG_BUCKET: BUCKET },
      { files: { 'theme-config.json': '{oops' } },
    );
    const config = await loadConfig({ files: ['theme-config.json'] }, sources);

    const error = syncConfigError(() => config.loadJson('theme-config.json', themeSchema));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.names).toEqual(['theme-config.json']);
    expect(error.issues).toEqual([{ path: '', message: expect.any(String) }]);
  });

  it('throws CONFIG_INVALID with Zod issues when the schema rejects the file', async () => {
    const { sources } = setup(
      { CONFIG_BUCKET: BUCKET },
      { files: { 'theme-config.json': '{"colors":{"primary":"blue"}}' } },
    );
    const config = await loadConfig({ files: ['theme-config.json'] }, sources);

    const error = syncConfigError(() => config.loadJson('theme-config.json', themeSchema));
    expect(error.toJSON()).toEqual({
      code: 'CONFIG_INVALID',
      names: ['theme-config.json'],
      issues: [{ path: 'colors.primary', message: expect.any(String) }],
    });
  });

  it('throws CONFIG_MISSING for values or files that were not loaded at init', async () => {
    const { sources } = setup({ A: 'a' });
    const config = await loadConfig({ values: ['A'] }, sources);

    expect(syncConfigError(() => config.requireAll(['A', 'B'])).toJSON()).toEqual({
      code: 'CONFIG_MISSING',
      names: ['B'],
    });
    expect(syncConfigError(() => config.loadJson('taxonomy.json', themeSchema)).code).toBe(
      'CONFIG_MISSING',
    );
  });

  it('creates no AWS client when no remote source is referenced', async () => {
    const config = await loadConfig({ values: ['A'] }, { env: { A: 'a' } });
    expect(config.requireAll(['A'])).toEqual({ A: 'a' });
  });
});
