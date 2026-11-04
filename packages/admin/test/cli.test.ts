import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import { parseCommand, RELOAD_FUNCTIONS_ENV, UsageError } from '../src/cli/args';
import { API_KEY_NOTICE, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runCli } from '../src/cli/main';
import { nextConfigVersion, reloadFunctions } from '../src/cli/reload';
import {
  createSigner,
  NodeSha256,
  resolveRegion,
  resolveTarget,
  sendAdminCall,
  type RequestSigner,
} from '../src/cli/signed-client';

const URL_ENV = {
  OPEN_ESTATE_ADMIN_URL: 'https://abc123.execute-api.eu-central-1.amazonaws.com/prod',
};
const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  sessionToken: 'session-token-example',
};
const SIGNING_DATE = new Date('2026-11-05T12:00:00.000Z');

const call = (argv: string[], env: NodeJS.ProcessEnv = {}) => {
  const command = parseCommand(argv, env);
  if (command.kind !== 'http') throw new Error(`expected http command, got ${command.kind}`);
  return command.call;
};

describe('parseCommand', () => {
  it.each<[string[], object]>([
    [['create-key'], { method: 'POST', path: '/admin/api-keys', body: {} }],
    [
      [
        'create-key',
        '--expires-at',
        '2027-01-01T00:00:00Z',
        '--requests',
        '100',
        '--window-seconds',
        '60',
      ],
      {
        method: 'POST',
        path: '/admin/api-keys',
        body: {
          expiresAt: '2027-01-01T00:00:00Z',
          rateLimit: { requests: 100, windowSeconds: 60 },
        },
      },
    ],
    [['revoke-key', 'k-1'], { method: 'DELETE', path: '/admin/api-keys/k-1' }],
    [
      ['set-key-rate-limit', 'k-1', '--requests', '5', '--window-seconds', '1'],
      {
        method: 'PUT',
        path: '/admin/api-keys/k-1/rate-limit',
        body: { requests: 5, windowSeconds: 1 },
      },
    ],
    [
      ['set-rate-limit', '--requests=0', '--window-seconds=99999'],
      { method: 'PUT', path: '/admin/rate-limit', body: { requests: 0, windowSeconds: 99999 } },
    ],
    [
      ['set-access-mode', 'api-keys'],
      { method: 'PUT', path: '/admin/access-mode', body: { mode: 'api-keys' } },
    ],
    [
      ['request-deletion', '--listing-id', 'L-1'],
      { method: 'POST', path: '/admin/deletions', body: { listingId: 'L-1' } },
    ],
    [
      ['request-deletion', '--source', 'partner-a'],
      { method: 'POST', path: '/admin/deletions', body: { source: 'partner-a' } },
    ],
    [['get-deletion', 'r-1'], { method: 'GET', path: '/admin/deletions/r-1' }],
    [
      ['unblock-listing', 'partner a/42'],
      { method: 'DELETE', path: '/admin/deletion-blocklist/partner%20a%2F42' },
    ],
  ])('%j → request', (argv, expected) => {
    expect(call(argv)).toEqual(expected);
  });

  it('passes out-of-range rate limits through, so the Admin-API names the value (17.8)', () => {
    expect(call(['set-rate-limit', '--requests=-1', '--window-seconds', '0']).body).toEqual({
      requests: -1,
      windowSeconds: 0,
    });
  });

  it('reads global options', () => {
    expect(
      parseCommand(['get-deletion', 'r-1', '--url', 'https://x', '--region', 'us-east-1'], {}),
    ).toMatchObject({ global: { url: 'https://x', region: 'us-east-1' } });
  });

  it.each([
    [['nope'], /Unknown command "nope"/],
    [['toString'], /Unknown command/],
    [['revoke-key'], /expects <keyId>/],
    [['revoke-key', 'a', 'b'], /expects <keyId>/],
    [['revoke-key', ' '], /<keyId> must not be empty/],
    [['set-rate-limit', '--requests', '10'], /must be given together/],
    [['set-rate-limit'], /are required/],
    [
      ['set-rate-limit', '--requests', 'ten', '--window-seconds', '1'],
      /--requests must be an integer/,
    ],
    [['request-deletion'], /exactly one of --listing-id or --source/],
    [['request-deletion', '--listing-id', 'a', '--source', 'b'], /exactly one/],
    [['get-deletion', 'r-1', '--bogus'], /Unknown option '--bogus'/],
    [['reload'], /No functions given/],
  ])('%j → UsageError', (argv, message) => {
    expect(() => parseCommand(argv, {})).toThrow(UsageError);
    expect(() => parseCommand(argv, {})).toThrow(message);
  });

  it('returns help for no command, help and --help', () => {
    expect(parseCommand([], {}).kind).toBe('help');
    expect(parseCommand(['--help'], {}).kind).toBe('help');
    expect(parseCommand(['reload', '-h'], {})).toMatchObject({
      kind: 'help',
      text: expect.stringContaining('open-estate-admin reload'),
    });
  });

  it('reload takes --function (repeatable, deduplicated) before the environment', () => {
    const env = { [RELOAD_FUNCTIONS_ENV]: 'from-env' };
    expect(
      parseCommand(['reload', '--function', 'a', '--function', 'b', '--function', 'a'], env),
    ).toMatchObject({
      kind: 'reload',
      functions: ['a', 'b'],
    });
    expect(parseCommand(['reload'], { [RELOAD_FUNCTIONS_ENV]: ' api, mcp ,,' })).toMatchObject({
      functions: ['api', 'mcp'],
    });
  });
});

describe('resolveTarget / resolveRegion', () => {
  it('prefers --region, then AWS_REGION, AWS_DEFAULT_REGION and the execute-api host', () => {
    const host = 'abc.execute-api.ap-south-1.amazonaws.com';
    expect(resolveRegion('eu-west-1', { AWS_REGION: 'x' }, host)).toBe('eu-west-1');
    expect(
      resolveRegion(undefined, { AWS_REGION: 'us-east-2', AWS_DEFAULT_REGION: 'y' }, host),
    ).toBe('us-east-2');
    expect(resolveRegion(undefined, { AWS_DEFAULT_REGION: 'us-west-2' }, host)).toBe('us-west-2');
    expect(resolveRegion(undefined, {}, host)).toBe('ap-south-1');
    expect(resolveRegion(undefined, {}, 'admin.example.com')).toBeUndefined();
  });

  it('takes --url before OPEN_ESTATE_ADMIN_URL', () => {
    const target = resolveTarget(
      { url: 'https://admin.example.com/v1/', region: 'eu-west-1' },
      URL_ENV,
    );
    expect(target.baseUrl.href).toBe('https://admin.example.com/v1/');
    expect(resolveTarget({}, URL_ENV).region).toBe('eu-central-1');
  });

  it.each([
    [{}, {}, /No Admin-API URL/],
    [{ url: 'not a url' }, {}, /Invalid Admin-API URL/],
    [{ url: 'http://abc.execute-api.eu-central-1.amazonaws.com' }, {}, /must use https/],
    [{ url: 'https://admin.example.com/?x=1' }, {}, /query or fragment/],
    [{ url: 'https://admin.example.com' }, {}, /No AWS region/],
  ])('%j rejects', (options, env, message) => {
    expect(() => resolveTarget(options, env)).toThrow(message);
  });
});

describe('NodeSha256', () => {
  it('computes SHA-256 and HMAC-SHA-256', async () => {
    const hash = new NodeSha256();
    hash.update('abc');
    expect(Buffer.from(await hash.digest()).toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const hmac = new NodeSha256('key');
    hmac.update(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'));
    expect(Buffer.from(await hmac.digest()).toString('hex')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    );
  });
});

describe('sendAdminCall', () => {
  const okFetch = () =>
    jest.fn<Promise<Response>, Parameters<typeof fetch>>(async () =>
      Promise.resolve(new Response('{"mode":"open"}', { status: 200 })),
    );

  it('signs for execute-api in the target region with the stage path and sends the body', async () => {
    const fetchMock = okFetch();
    const target = resolveTarget({}, URL_ENV);
    const response = await sendAdminCall(
      { method: 'PUT', path: '/admin/access-mode', body: { mode: 'open' } },
      target,
      {
        signer: createSigner(target.region, CREDENTIALS),
        fetch: fetchMock,
        now: () => SIGNING_DATE,
      },
    );

    expect(response).toEqual({ status: 200, body: { mode: 'open' } });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      'https://abc123.execute-api.eu-central-1.amazonaws.com/prod/admin/access-mode',
    );
    expect(init).toMatchObject({ method: 'PUT', body: '{"mode":"open"}' });
    const headers = init?.headers as Record<string, string>;
    expect(headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261105\/eu-central-1\/execute-api\/aws4_request, SignedHeaders=[a-z0-9;-]*\bhost\b[a-z0-9;-]*, Signature=[0-9a-f]{64}$/,
    );
    expect(headers['x-amz-date']).toBe('20261105T120000Z');
    expect(headers['x-amz-security-token']).toBe(CREDENTIALS.sessionToken);
    expect(headers['content-type']).toBe('application/json');
    expect(headers).not.toHaveProperty('host');
  });

  it('produces a deterministic signature for fixed credentials and clock', async () => {
    const send = async () => {
      const fetchMock = okFetch();
      const target = resolveTarget({}, URL_ENV);
      await sendAdminCall({ method: 'GET', path: '/admin/deletions/r-1' }, target, {
        signer: createSigner(target.region, CREDENTIALS),
        fetch: fetchMock,
        now: () => SIGNING_DATE,
      });
      return (fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)['authorization'];
    };
    expect(await send()).toBe(await send());
  });

  it('returns non-JSON bodies as text and empty bodies as null', async () => {
    const signer = {
      sign: async (request: unknown) => Promise.resolve(request),
    } as unknown as RequestSigner;
    const target = resolveTarget({}, URL_ENV);
    const fetchText = jest.fn(async () =>
      Promise.resolve(new Response('Bad Gateway', { status: 502 })),
    );
    await expect(
      sendAdminCall({ method: 'GET', path: '/admin/x' }, target, { signer, fetch: fetchText }),
    ).resolves.toEqual({ status: 502, body: 'Bad Gateway' });
    const fetchEmpty = jest.fn(async () => Promise.resolve(new Response(null, { status: 204 })));
    await expect(
      sendAdminCall({ method: 'GET', path: '/admin/x' }, target, { signer, fetch: fetchEmpty }),
    ).resolves.toEqual({ status: 204, body: null });
  });
});

describe('reload', () => {
  it('nextConfigVersion increments integers and restarts anything else at 1', () => {
    expect(nextConfigVersion(undefined)).toBe('1');
    expect(nextConfigVersion('0')).toBe('1');
    expect(nextConfigVersion('41')).toBe('42');
    expect(nextConfigVersion('9007199254740993')).toBe('9007199254740994');
    expect(nextConfigVersion('abc')).toBe('1');
    expect(nextConfigVersion('-3')).toBe('1');
  });

  const lambdaWith = (environment: object | undefined, revisionId = 'rev-1') => {
    const client = new LambdaClient({ region: 'eu-central-1' });
    const send = jest.spyOn(client, 'send').mockImplementation(async (command: unknown) => {
      if (command instanceof GetFunctionConfigurationCommand) {
        return Promise.resolve({ Environment: environment, RevisionId: revisionId });
      }
      return Promise.resolve({});
    });
    return { client, send };
  };

  it('increments CONFIG_VERSION and writes all other variables back with the revision id', async () => {
    const { client, send } = lambdaWith({ Variables: { TABLE: 'Listings', CONFIG_VERSION: '7' } });
    await expect(reloadFunctions(client, ['api'])).resolves.toEqual([
      { functionName: 'api', status: 'updated', previousConfigVersion: '7', configVersion: '8' },
    ]);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetFunctionConfigurationCommand);
    expect((send.mock.calls[0]?.[0] as GetFunctionConfigurationCommand).input).toEqual({
      FunctionName: 'api',
    });
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(UpdateFunctionConfigurationCommand);
    expect((send.mock.calls[1]?.[0] as UpdateFunctionConfigurationCommand).input).toEqual({
      FunctionName: 'api',
      Environment: { Variables: { TABLE: 'Listings', CONFIG_VERSION: '8' } },
      RevisionId: 'rev-1',
    });
  });

  it('starts at 1 for a function without environment', async () => {
    const { client, send } = lambdaWith(undefined);
    await expect(reloadFunctions(client, ['mcp'])).resolves.toEqual([
      { functionName: 'mcp', status: 'updated', previousConfigVersion: null, configVersion: '1' },
    ]);
    expect(
      (send.mock.calls[1]?.[0] as UpdateFunctionConfigurationCommand).input.Environment,
    ).toEqual({
      Variables: { CONFIG_VERSION: '1' },
    });
  });

  it('never overwrites an unreadable environment and continues with the next function', async () => {
    const client = new LambdaClient({ region: 'eu-central-1' });
    const send = jest
      .spyOn(client, 'send')
      .mockImplementationOnce(async () =>
        Promise.resolve({ Environment: { Error: { ErrorCode: 'AccessDeniedException' } } }),
      )
      .mockImplementationOnce(async () => Promise.resolve({ Environment: { Variables: {} } }))
      .mockImplementationOnce(async () => Promise.reject(new Error('conflict')));

    const outcomes = await reloadFunctions(client, ['api', 'mcp']);
    expect(outcomes).toEqual([
      {
        functionName: 'api',
        status: 'failed',
        error: 'Error: Environment of api is not readable (AccessDeniedException)',
      },
      { functionName: 'mcp', status: 'failed', error: 'Error: conflict' },
    ]);
    expect(
      send.mock.calls.filter(([command]) => command instanceof UpdateFunctionConfigurationCommand),
    ).toHaveLength(1);
  });
});

describe('runCli', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) },
    };
  };
  const passthroughSigner = () => ({ sign: jest.fn(async (request) => Promise.resolve(request)) });
  const credentials = () => CREDENTIALS;

  it('prints the JSON result on stdout and exits 0', async () => {
    const streams = io();
    const fetchMock = jest.fn(async () =>
      Promise.resolve(
        new Response('{"rateLimit":{"requests":10,"windowSeconds":60}}', { status: 200 }),
      ),
    );
    const code = await runCli(['set-rate-limit', '--requests', '10', '--window-seconds', '60'], {
      env: URL_ENV,
      io: streams.io,
      fetch: fetchMock,
      credentials,
    });
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(streams.out.join(''))).toEqual({
      rateLimit: { requests: 10, windowSeconds: 60 },
    });
    expect(streams.err).toEqual([]);
  });

  it('uses the signer for the resolved region', async () => {
    const signer = passthroughSigner();
    const signerFactory = jest.fn(() => signer);
    await runCli(['get-deletion', 'r-1', '--region', 'eu-west-3'], {
      env: URL_ENV,
      io: io().io,
      fetch: jest.fn(async () => Promise.resolve(new Response('{}', { status: 200 }))),
      credentials,
      signer: signerFactory,
    });
    expect(signerFactory).toHaveBeenCalledWith('eu-west-3', CREDENTIALS);
    expect(signer.sign).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', path: '/prod/admin/deletions/r-1' }),
      expect.anything(),
    );
  });

  it('labels the one-time plaintext key on create-key', async () => {
    const streams = io();
    const code = await runCli(['create-key'], {
      env: URL_ENV,
      io: streams.io,
      fetch: jest.fn(async () =>
        Promise.resolve(
          new Response('{"keyId":"k-1","status":"active","apiKey":"plain"}', { status: 201 }),
        ),
      ),
      credentials,
    });
    expect(code).toBe(EXIT_OK);
    expect(streams.err).toEqual([API_KEY_NOTICE]);
    expect(JSON.parse(streams.out.join(''))).toMatchObject({ keyId: 'k-1', apiKey: 'plain' });
  });

  it('prints API errors on stderr and exits 1, without credentials', async () => {
    const streams = io();
    const error = {
      errors: [
        { code: 'INVALID_RATE_LIMIT', message: 'requests must be …; got -1', field: 'requests' },
      ],
    };
    const code = await runCli(['set-rate-limit', '--requests=-1', '--window-seconds', '60'], {
      env: URL_ENV,
      io: streams.io,
      fetch: jest.fn(async () =>
        Promise.resolve(new Response(JSON.stringify(error), { status: 400 })),
      ),
      credentials,
      now: () => SIGNING_DATE,
    });
    expect(code).toBe(EXIT_FAILURE);
    expect(streams.out).toEqual([]);
    expect(streams.err[0]).toBe('HTTP 400 PUT /admin/rate-limit');
    expect(JSON.parse(streams.err[1] ?? '')).toEqual(error);
    const printed = streams.err.join('\n');
    expect(printed).not.toContain(CREDENTIALS.secretAccessKey);
    expect(printed).not.toContain(CREDENTIALS.sessionToken);
  });

  it('exits 1 on network errors', async () => {
    const streams = io();
    const code = await runCli(['get-deletion', 'r-1'], {
      env: URL_ENV,
      io: streams.io,
      fetch: jest.fn(async () => Promise.reject(new TypeError('fetch failed'))),
      credentials,
    });
    expect(code).toBe(EXIT_FAILURE);
    expect(streams.err).toEqual(['TypeError: fetch failed']);
  });

  it('exits 2 on usage errors, including a missing URL', async () => {
    const parseError = io();
    expect(await runCli(['bogus'], { env: {}, io: parseError.io, credentials })).toBe(EXIT_USAGE);
    expect(parseError.err[0]).toContain('Unknown command "bogus"');
    expect(parseError.out).toEqual([]);

    const noUrl = io();
    expect(await runCli(['get-deletion', 'r-1'], { env: {}, io: noUrl.io, credentials })).toBe(
      EXIT_USAGE,
    );
    expect(noUrl.err[0]).toContain('No Admin-API URL');
  });

  it('prints help on stdout and exits 0', async () => {
    const streams = io();
    expect(await runCli(['--help'], { env: {}, io: streams.io })).toBe(EXIT_OK);
    expect(streams.out[0]).toContain('Usage: open-estate-admin <command>');
  });

  it('reload: reports outcomes on stdout, exits 1 if any function failed', async () => {
    const client = new LambdaClient({ region: 'eu-central-1' });
    jest
      .spyOn(client, 'send')
      .mockImplementationOnce(async () =>
        Promise.resolve({ Environment: { Variables: { CONFIG_VERSION: '1' } } }),
      )
      .mockImplementationOnce(async () => Promise.resolve({}))
      .mockImplementationOnce(async () => Promise.reject(new Error('ResourceNotFound')));
    const lambda = jest.fn(() => client);
    const streams = io();

    const code = await runCli(['reload', '--function', 'api', '--function', 'gone'], {
      env: { AWS_REGION: 'eu-central-1' },
      io: streams.io,
      credentials,
      lambda,
    });
    expect(code).toBe(EXIT_FAILURE);
    expect(lambda).toHaveBeenCalledWith('eu-central-1', CREDENTIALS);
    expect(JSON.parse(streams.out.join(''))).toEqual({
      functions: [
        { functionName: 'api', status: 'updated', previousConfigVersion: '1', configVersion: '2' },
        { functionName: 'gone', status: 'failed', error: 'Error: ResourceNotFound' },
      ],
    });
    expect(streams.err).toEqual(['reload failed: gone']);
  });
});
