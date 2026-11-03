import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { ConfigError } from '@open-estate/core';
import {
  createCorsPolicy,
  loadCorsPolicy,
  normalizeOrigin,
  parseOriginList,
  withCors,
  type ListingsRequest,
} from '@open-estate/api';

const SPA = 'https://d111111abcdef8.cloudfront.net';
const policy = createCorsPolicy([SPA, 'http://localhost:4200']);

const request = (headers: Record<string, string> = {}, httpMethod = 'GET'): ListingsRequest => ({
  httpMethod,
  resource: '/listings',
  headers,
  requestContext: { identity: { sourceIp: '192.0.2.1' } },
});

describe('normalizeOrigin', () => {
  it.each([
    ['https://Example.COM', 'https://example.com'],
    ['HTTPS://example.com:443', 'https://example.com'],
    ['http://localhost:4200', 'http://localhost:4200'],
    [' https://example.com ', 'https://example.com'],
  ])('normalizes %j to %j', (raw, expected) => {
    expect(normalizeOrigin(raw)).toBe(expected);
  });

  it.each([
    'https://example.com/',
    'https://example.com/app',
    'https://example.com?x=1',
    'https://user@example.com',
    'ftp://example.com',
    'null',
    '*',
    '',
    "https://ex'ample.com",
  ])('rejects %j', (raw) => {
    expect(normalizeOrigin(raw)).toBeUndefined();
  });

  it('parses comma-separated lists, skipping empty entries and duplicates', () => {
    expect(parseOriginList(' https://a.example, ,https://A.example,https://b.example/')).toEqual({
      origins: ['https://a.example'],
      invalid: ['https://b.example/'],
    });
  });
});

describe('withCors', () => {
  const ok = jest.fn(async () => ({
    statusCode: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: '{}',
  }));
  const handler = withCors(async () => policy, ok);

  afterEach(() => ok.mockClear());

  it('echoes an allowed origin (case-insensitive scheme/host) with Vary and exposed Retry-After', async () => {
    const res = await handler(request({ origin: 'HTTPS://D111111ABCDEF8.cloudfront.net' }));
    expect(res.headers).toEqual({
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': SPA,
      'Access-Control-Expose-Headers': 'Retry-After',
      Vary: 'Origin',
    });
    expect(res.headers).not.toHaveProperty('Access-Control-Allow-Credentials');
  });

  it.each([
    ['an unknown origin', { Origin: 'https://evil.example' }],
    ['a trailing slash', { Origin: `${SPA}/` }],
    ['an opaque origin', { Origin: 'null' }],
    ['no Origin header', {}],
  ])('sets only Vary for %s', async (_, headers) => {
    const res = await handler(request(headers));
    expect(res.headers).toEqual({
      'Content-Type': 'application/json; charset=utf-8',
      Vary: 'Origin',
    });
  });

  it('answers a preflight of an allowed origin without calling the route', async () => {
    const res = await handler(
      request(
        {
          Origin: SPA,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization',
        },
        'OPTIONS',
      ),
    );
    expect(res).toEqual({
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': SPA,
        'Access-Control-Allow-Methods': 'GET',
        'Access-Control-Allow-Headers': 'Authorization, Accept-Language',
        'Access-Control-Max-Age': '3600',
        Vary: 'Origin',
      },
      body: '',
    });
    expect(ok).not.toHaveBeenCalled();
  });

  it('answers a preflight of an unknown origin without allow headers', async () => {
    const res = await handler(request({ Origin: 'https://evil.example' }, 'OPTIONS'));
    expect(res).toEqual({ statusCode: 204, headers: { Vary: 'Origin' }, body: '' });
    expect(ok).not.toHaveBeenCalled();
  });
});

describe('loadCorsPolicy', () => {
  function ssmWith(values: Record<string, string>) {
    const ssm = new SSMClient({ region: 'eu-central-1' });
    const send = jest.spyOn(ssm, 'send').mockImplementation(async (command: unknown) => {
      if (!(command instanceof GetParametersCommand)) throw new Error('unexpected command');
      const names = command.input.Names ?? [];
      return {
        Parameters: names
          .filter((n) => values[n] !== undefined)
          .map((n) => ({ Name: n, Value: values[n] })),
      };
    });
    return { ssm, send };
  }
  const PARAM = '/oe/test/frontend-origin';

  afterEach(() => jest.restoreAllMocks());

  it('merges the frontend origin from SSM with the context origins', async () => {
    const { ssm } = ssmWith({ [PARAM]: SPA });
    const loaded = await loadCorsPolicy(
      { FRONTEND_ORIGIN_SSM_PARAMETER: PARAM, CORS_ALLOWED_ORIGINS: 'http://localhost:4200' },
      { ssm },
    );
    expect([...loaded.allowedOrigins]).toEqual([SPA, 'http://localhost:4200']);
  });

  it('treats a missing frontend origin parameter as "no frontend origin"', async () => {
    const { ssm } = ssmWith({});
    const loaded = await loadCorsPolicy({ FRONTEND_ORIGIN_SSM_PARAMETER: PARAM }, { ssm });
    expect(loaded.allowedOrigins.size).toBe(0);
    // Without the variable, SSM is not called at all.
    const local = ssmWith({});
    expect((await loadCorsPolicy({}, { ssm: local.ssm })).allowedOrigins.size).toBe(0);
    expect(local.send).not.toHaveBeenCalled();
  });

  it.each([
    [{ CORS_ALLOWED_ORIGINS: '*' }, {}, 'CORS_ALLOWED_ORIGINS'],
    [{ FRONTEND_ORIGIN_SSM_PARAMETER: PARAM }, { [PARAM]: `${SPA}/` }, 'FRONTEND_ORIGIN'],
  ])(
    'rejects an invalid origin with CONFIG_INVALID naming the variable',
    async (env, values, name) => {
      const { ssm } = ssmWith(values);
      const error = await loadCorsPolicy(env, { ssm }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConfigError);
      expect(error).toMatchObject({ code: 'CONFIG_INVALID', names: [name] });
      // The init log carries the variable name, never the value.
      expect(JSON.stringify((error as ConfigError).toJSON())).not.toMatch(/cloudfront|"\*"/);
    },
  );
});
