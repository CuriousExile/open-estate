import {
  InMemoryAuditService,
  InMemoryRateLimitCounterStore,
  type Authenticator,
} from '@open-estate/core';
import {
  createManagementAccessGuard,
  createManagementHandler,
  createRouter,
  definePublicRoute,
  defineRoute,
  failure,
  StaticRateLimitSource,
  success,
  type ManagementRequest,
  type Route,
} from '@open-estate/management';
import { err, ok, type Principal } from '@open-estate/shared';

const member: Principal = {
  kind: 'user',
  userId: 'u1',
  displayName: 'Ute',
  role: 'AGENCY_MEMBER',
  agencyId: 'a1',
};

const TOKENS: Record<string, Principal> = { 'Bearer good': member };

const suspendedMember: Principal = { ...member, userId: 'u2', displayName: 'Sven', agencyId: 'a9' };

const authenticator: Authenticator = {
  async authenticate(authorization) {
    if (authorization === undefined) return err({ code: 'AUTH_MISSING', message: 'missing' });
    if (authorization === 'Bearer suspended') {
      return {
        ok: false,
        error: { code: 'AGENCY_SUSPENDED', message: 'Agency suspended' },
        principal: suspendedMember,
      };
    }
    const principal = TOKENS[authorization];
    return principal === undefined
      ? err({ code: 'AUTH_INVALID', message: 'invalid' })
      : ok(principal);
  },
};

const routes: Route[] = [
  defineRoute({
    method: 'GET',
    path: '/listings/{id}',
    handle: async ({ params }) => success(200, { id: params['id'] }),
  }),
  defineRoute({
    method: 'POST',
    path: '/agencies',
    handle: async () => failure({ code: 'FORBIDDEN', message: 'Missing permission agency:manage' }),
  }),
  defineRoute({
    method: 'GET',
    path: '/slow',
    handle: ({ signal }) =>
      new Promise((resolve) => signal.addEventListener('abort', () => resolve(success(200)))),
  }),
  defineRoute({
    method: 'GET',
    path: '/boom',
    handle: async () => {
      throw new Error('DynamoDB down');
    },
  }),
  definePublicRoute({
    method: 'GET',
    path: '/openapi.json',
    handle: async () => success(200, { openapi: '3.1.0' }),
  }),
];

function setup(requests = 100) {
  const audit = new InMemoryAuditService({ now: () => Date.parse('2026-01-01T00:00:00Z') });
  const authenticate = jest.spyOn(authenticator, 'authenticate');
  const logger = { error: jest.fn() };
  const handler = createManagementHandler({
    router: createRouter(routes),
    guard: createManagementAccessGuard({
      authenticator,
      rateLimit: new StaticRateLimitSource({ requests, windowSeconds: 60 }),
      counters: new InMemoryRateLimitCounterStore(),
      clock: () => 0,
    }),
    audit,
    logger,
    deadlineMs: 50,
  });
  return { handler, audit, authenticate, logger };
}

const request = (
  method: string,
  path: string,
  authorization?: string,
  body: string | null = null,
): ManagementRequest => ({
  httpMethod: method,
  path,
  headers: authorization === undefined ? {} : { authorization },
  body,
  requestContext: { identity: { sourceIp: '192.0.2.1' } },
});

const errorCodes = (body: string) =>
  (JSON.parse(body) as { errors: { code: string }[] }).errors.map((e) => e.code);

afterEach(() => jest.restoreAllMocks());

describe('createManagementHandler', () => {
  it('routes authenticated requests to the handler', async () => {
    const { handler } = setup();
    const response = await handler(request('GET', '/listings/l1', 'Bearer good'));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ id: 'l1' });
  });

  it('answers unknown routes with 404 NOT_FOUND without authenticating', async () => {
    const { handler, authenticate } = setup();
    const response = await handler(request('DELETE', '/listings/l1', 'Bearer good'));
    expect(response.statusCode).toBe(404);
    expect(errorCodes(response.body)).toEqual(['NOT_FOUND']);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('serves public routes without authentication', async () => {
    const { handler, authenticate } = setup();
    const response = await handler(request('GET', '/openapi.json'));
    expect(response.statusCode).toBe(200);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('rejects missing authentication with 401 and audits it without actor', async () => {
    const { handler, audit } = setup();
    const response = await handler(request('GET', '/listings/l1'));
    expect(response.statusCode).toBe(401);
    expect(errorCodes(response.body)).toEqual(['AUTH_MISSING']);
    expect(audit.entries).toEqual([
      expect.objectContaining({
        category: 'access-denied',
        action: 'GET /listings/{id}',
        target: '/listings/l1',
        result: 'AUTH_MISSING',
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    ]);
    expect(audit.entries[0]).not.toHaveProperty('actor');
  });

  it('audits 403 of a use case with actor, channel and agency', async () => {
    const { handler, audit } = setup();
    const response = await handler(request('POST', '/agencies', 'Bearer good', '{}'));
    expect(response.statusCode).toBe(403);
    expect(audit.entries).toEqual([
      expect.objectContaining({
        category: 'access-denied',
        actor: { kind: 'user', userId: 'u1', displayName: 'Ute' },
        channel: 'PORTAL',
        agencyId: 'a1',
        action: 'POST /agencies',
        target: '/agencies',
        result: 'FORBIDDEN',
      }),
    ]);
  });

  it('audits AGENCY_SUSPENDED with the identified actor and agency, not in the reply (Req 2.8)', async () => {
    const { handler, audit } = setup();
    const response = await handler(request('GET', '/listings/l1', 'Bearer suspended'));
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      errors: [{ code: 'AGENCY_SUSPENDED', message: 'Agency suspended' }],
    });
    expect(audit.entries).toEqual([
      expect.objectContaining({
        category: 'access-denied',
        actor: { kind: 'user', userId: 'u2', displayName: 'Sven' },
        channel: 'PORTAL',
        agencyId: 'a9',
        action: 'GET /listings/{id}',
        result: 'AGENCY_SUSPENDED',
      }),
    ]);
  });

  it('does not audit successful or non-denied responses', async () => {
    const { handler, audit } = setup();
    await handler(request('GET', '/listings/l1', 'Bearer good'));
    await handler(request('GET', '/nope', 'Bearer good'));
    expect(audit.entries).toEqual([]);
  });

  it('keeps the denial if the audit write fails', async () => {
    const { handler, audit, logger } = setup();
    jest.spyOn(audit, 'append').mockRejectedValue(new Error('throttled'));
    const response = await handler(request('GET', '/listings/l1', 'Bearer bad'));
    expect(response.statusCode).toBe(401);
    expect(logger.error).toHaveBeenCalledWith('Management API: access-denied audit failed', {
      errorName: 'Error',
    });
  });

  it('answers 503 SERVICE_UNAVAILABLE after the deadline and aborts the signal', async () => {
    const { handler } = setup();
    const response = await handler(request('GET', '/slow', 'Bearer good'));
    expect(response.statusCode).toBe(503);
    expect(errorCodes(response.body)).toEqual(['SERVICE_UNAVAILABLE']);
  });

  it('answers 503 for unexpected failures and logs only the error class', async () => {
    const { handler, logger } = setup();
    const response = await handler(request('GET', '/boom', 'Bearer good'));
    expect(response.statusCode).toBe(503);
    expect(logger.error).toHaveBeenCalledWith('Management API: request failed', {
      errorName: 'Error',
      method: 'GET',
    });
  });

  it('answers 429 with Retry-After when the limit is exceeded', async () => {
    const { handler } = setup(1);
    await handler(request('GET', '/listings/l1', 'Bearer good'));
    const response = await handler(request('GET', '/listings/l1', 'Bearer good'));
    expect(response.statusCode).toBe(429);
    expect(response.headers).toMatchObject({ 'Retry-After': '60' });
    expect(JSON.parse(response.body)).toMatchObject({ retryAfterSeconds: 60 });
  });
});
