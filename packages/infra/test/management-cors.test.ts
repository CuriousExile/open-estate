import type { ManagementRequest } from '@open-estate/management';
import { parseAllowedOrigins, withManagementCors } from '../src/lambda/management-cors';

const SPA = 'https://d111111abcdef8.cloudfront.net';

function request(overrides: Partial<ManagementRequest> = {}): ManagementRequest {
  return {
    httpMethod: 'GET',
    path: '/me',
    headers: { origin: SPA, Authorization: 'Bearer token' },
    body: null,
    requestContext: { identity: { sourceIp: '192.0.2.1' } },
    ...overrides,
  };
}

describe('withManagementCors', () => {
  const calls: ManagementRequest[] = [];
  const handler = withManagementCors(
    async (event) => {
      calls.push(event);
      return {
        statusCode: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '3' },
        body: '{}',
      };
    },
    [SPA, 'http://localhost:4200'],
  );
  beforeEach(() => calls.splice(0));

  it('answers the preflight of an allowed origin with Authorization, without the handler', async () => {
    const response = await handler(
      request({
        httpMethod: 'OPTIONS',
        headers: {
          Origin: SPA,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      }),
    );
    expect(calls).toHaveLength(0);
    expect(response.statusCode).toBe(204);
    expect(response.headers).toMatchObject({
      'Access-Control-Allow-Origin': SPA,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      Vary: 'Origin',
    });
    expect(String(response.headers?.['Access-Control-Allow-Methods'])).toContain('PATCH');
  });

  it('gives a foreign origin no CORS headers, on preflight and response', async () => {
    const headers = { Origin: 'https://evil.example' };
    const preflight = await handler(request({ httpMethod: 'OPTIONS', headers }));
    expect(preflight.headers).not.toHaveProperty('Access-Control-Allow-Origin');
    const response = await handler(request({ headers }));
    expect(response.headers).not.toHaveProperty('Access-Control-Allow-Origin');
    expect(calls).toHaveLength(1);
  });

  it('adds the allowed origin to handler responses and exposes Retry-After', async () => {
    const response = await handler(request());
    expect(calls).toHaveLength(1);
    expect(response.statusCode).toBe(429);
    expect(response.headers).toEqual({
      'Content-Type': 'application/json',
      'Retry-After': '3',
      'Access-Control-Allow-Origin': SPA,
      'Access-Control-Expose-Headers': 'Retry-After',
      Vary: 'Origin',
    });
  });

  it('passes requests without Origin (machine clients) through unchanged except Vary', async () => {
    const response = await handler(request({ headers: { Authorization: 'Bearer oem_x' } }));
    expect(response.headers).toEqual({
      'Content-Type': 'application/json',
      'Retry-After': '3',
      Vary: 'Origin',
    });
  });
});

describe('parseAllowedOrigins', () => {
  it('splits, trims and drops empty entries and trailing slashes', () => {
    expect(parseAllowedOrigins(` ${SPA}/ ,, http://localhost:4200`)).toEqual([
      SPA,
      'http://localhost:4200',
    ]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });
});
