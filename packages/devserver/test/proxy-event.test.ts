import {
  fromProxyResult,
  matchResource,
  stripPathPrefix,
  toProxyEvent,
  type RawHttpRequest,
} from '../src/http/proxy-event';

const SEARCH = ['/listings', '/listings/{id}', '/openapi.json', '/meta'];

const raw = (overrides: Partial<RawHttpRequest> = {}): RawHttpRequest => ({
  method: 'get',
  url: '/',
  headers: {},
  body: Buffer.alloc(0),
  remoteAddress: '127.0.0.1',
  ...overrides,
});

describe('matchResource', () => {
  it('matches literal templates before parameterized ones', () => {
    expect(
      matchResource(['/listings/{id}', '/listings/by-custom-id'], '/listings/by-custom-id'),
    ).toEqual({ resource: '/listings/by-custom-id', pathParameters: null });
  });

  it('extracts parameters raw (still URL-encoded), like API Gateway', () => {
    expect(matchResource(SEARCH, '/listings/a%2Fb')).toEqual({
      resource: '/listings/{id}',
      pathParameters: { id: 'a%2Fb' },
    });
  });

  it('requires the same number of segments and non-empty parameters', () => {
    expect(matchResource(SEARCH, '/listings/x/y')).toBeUndefined();
    expect(matchResource(SEARCH, '/listings/')).toBeUndefined();
    expect(matchResource(SEARCH, '/unknown')).toBeUndefined();
  });
});

describe('stripPathPrefix', () => {
  it.each([
    ['/api/listings', '/api', '/listings'],
    ['/api', '/api', '/'],
    ['/apix/listings', '/api', '/apix/listings'],
    ['/listings', undefined, '/listings'],
  ])('%s without %s → %s', (path, prefix, expected) => {
    expect(stripPathPrefix(path, prefix)).toBe(expected);
  });
});

describe('toProxyEvent', () => {
  it('builds a REST proxy event with stage-less path, resource and query maps', () => {
    const event = toProxyEvent(
      raw({
        url: '/api/listings/abc?city=Berlin&type=loft&type=villa',
        headers: { authorization: 'Bearer x', 'x-multi': ['a', 'b'] },
        remoteAddress: '::1',
      }),
      { stripPrefix: '/api', resources: SEARCH },
    );
    expect(event).toEqual({
      httpMethod: 'GET',
      path: '/listings/abc',
      resource: '/listings/{id}',
      pathParameters: { id: 'abc' },
      headers: { authorization: 'Bearer x', 'x-multi': 'a, b' },
      multiValueHeaders: { authorization: ['Bearer x'], 'x-multi': ['a', 'b'] },
      queryStringParameters: { city: 'Berlin', type: 'villa' },
      multiValueQueryStringParameters: { city: ['Berlin'], type: ['loft', 'villa'] },
      body: null,
      isBase64Encoded: false,
      requestContext: { identity: { sourceIp: '::1' } },
    });
  });

  it('has no query maps without parameters and no resource without templates', () => {
    const event = toProxyEvent(raw({ url: '/management/me' }), { stripPrefix: '/management' });
    expect(event.path).toBe('/me');
    expect(event.resource).toBeUndefined();
    expect(event.queryStringParameters).toBeNull();
    expect(event.multiValueQueryStringParameters).toBeNull();
  });

  it('passes JSON and form bodies as text and binary bodies base64-encoded', () => {
    const json = toProxyEvent(
      raw({
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: Buffer.from('{"a":"ä"}'),
      }),
    );
    expect(json).toMatchObject({ body: '{"a":"ä"}', isBase64Encoded: false });

    const binary = toProxyEvent(
      raw({
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from([0, 255]),
      }),
    );
    expect(binary).toMatchObject({ body: 'AP8=', isBase64Encoded: true });
  });
});

describe('fromProxyResult', () => {
  it('merges single and multi-value headers and decodes base64 bodies', () => {
    const out = fromProxyResult({
      statusCode: 201,
      headers: { 'Content-Type': 'application/json', 'X-Count': 3 },
      multiValueHeaders: { 'Set-Cookie': ['a=1', 'b=2'] },
      body: Buffer.from('hello').toString('base64'),
      isBase64Encoded: true,
    });
    expect(out).toEqual({
      status: 201,
      headers: { 'Content-Type': 'application/json', 'X-Count': '3', 'Set-Cookie': ['a=1', 'b=2'] },
      body: Buffer.from('hello'),
    });
    expect(fromProxyResult({ statusCode: 204, body: '' }).body.length).toBe(0);
  });
});
