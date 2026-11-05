import { failure, fromResult, success, toProxyResult } from '@open-estate/management';
import { err, ok } from '@open-estate/shared';

describe('ErrorResponse mapping', () => {
  it('uses the catalog status of the first error and the ErrorResponse format', () => {
    const response = toProxyResult(
      failure([
        { code: 'VERSION_CONFLICT', message: 'stale', details: { currentVersion: 4 } },
        { code: 'INVALID_PARAMETER', message: 'x' },
      ]),
    );
    expect(response.statusCode).toBe(409);
    expect(response.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    expect(JSON.parse(response.body)).toEqual({
      errors: [
        { code: 'VERSION_CONFLICT', message: 'stale', details: { currentVersion: 4 } },
        { code: 'INVALID_PARAMETER', message: 'x' },
      ],
    });
  });

  it.each([
    ['AUTH_MISSING', 401],
    ['AUTH_INVALID', 401],
    ['MACHINE_ACCESS_EXPIRED', 401],
    ['FORBIDDEN', 403],
    ['AGENCY_SUSPENDED', 403],
    ['NOT_FOUND', 404],
    ['SERVICE_UNAVAILABLE', 503],
  ] as const)('%s → %i', (code, status) => {
    expect(toProxyResult(failure({ code, message: 'm' })).statusCode).toBe(status);
  });

  it('adds retryAfterSeconds and Retry-After for RATE_LIMITED', () => {
    const response = toProxyResult(
      failure({ code: 'RATE_LIMITED', message: 'slow down', details: { retryAfterSeconds: 7 } }),
    );
    expect(response.statusCode).toBe(429);
    expect(response.headers).toMatchObject({ 'Retry-After': '7' });
    expect(JSON.parse(response.body)).toMatchObject({ retryAfterSeconds: 7 });
  });

  it('maps use-case results with single or multiple errors', () => {
    expect(fromResult(201, ok({ id: 'a1' }))).toEqual(success(201, { id: 'a1' }));
    expect(fromResult(200, err({ code: 'NOT_FOUND', message: 'm' }))).toEqual(
      failure([{ code: 'NOT_FOUND', message: 'm' }]),
    );
    expect(fromResult(200, err([{ code: 'FORBIDDEN', message: 'm' }]))).toEqual(
      failure([{ code: 'FORBIDDEN', message: 'm' }]),
    );
  });

  it('serializes success with and without body', () => {
    expect(toProxyResult(success(200, { a: 1 }))).toMatchObject({
      statusCode: 200,
      body: '{"a":1}',
    });
    expect(toProxyResult(success(204))).toMatchObject({ statusCode: 204, body: '' });
  });
});
