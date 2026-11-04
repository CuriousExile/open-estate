import {
  createAdminHandler,
  generateApiKey,
  InMemoryAuditLog,
  type AdminRequest,
  type GeneratedApiKey,
} from '@open-estate/admin';
import {
  createAccessGuard,
  hashApiKey,
  InMemoryApiKeyStore,
  InMemoryRateLimitCounterStore,
  StaticAccessConfigSource,
  type AccessConfig,
} from '@open-estate/core';
import { createDeletionHarness } from './support/deletion-harness';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const ADMIN = 'arn:aws:iam::123456789012:user/admin';
const GENERATED: GeneratedApiKey = { keyId: 'k-1', apiKey: 'plain-secret-key' };

function setup(
  config: AccessConfig = { mode: 'api-keys', rateLimit: { requests: 60, windowSeconds: 60 } },
) {
  let now = T0;
  const clock = () => now;
  const apiKeys = new InMemoryApiKeyStore();
  const accessConfig = new StaticAccessConfigSource(config);
  const audit = new InMemoryAuditLog();
  const handler = createAdminHandler({
    apiKeys,
    accessConfig,
    audit,
    deletions: createDeletionHarness({ audit, clock }).deletions,
    clock,
    generateKey: () => GENERATED,
  });
  // Guard without cache, so every admission sees the current stores.
  const guard = createAccessGuard({
    config: accessConfig,
    apiKeys,
    counters: new InMemoryRateLimitCounterStore(),
    clock,
    cacheTtlMs: 0,
  });
  return { handler, guard, apiKeys, accessConfig, audit, advance: (ms: number) => (now += ms) };
}

function request(
  httpMethod: string,
  path: string,
  body?: unknown,
  userArn: string | null = ADMIN,
): AdminRequest {
  return {
    httpMethod,
    path,
    body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body),
    requestContext: { identity: { userArn } },
  };
}

const parse = (body: string) => JSON.parse(body) as Record<string, unknown>;

describe('Admin handler', () => {
  describe('identity and routing', () => {
    it.each([null, '', '  '])(
      'rejects a missing IAM identity (%p) with 403 FORBIDDEN',
      async (arn) => {
        const { handler, apiKeys, audit } = setup();
        const res = await handler(request('POST', '/admin/api-keys', {}, arn));
        expect(res.statusCode).toBe(403);
        expect(parse(res.body)).toEqual({
          errors: [{ code: 'FORBIDDEN', message: expect.any(String) }],
        });
        expect(apiKeys.records()).toEqual([]);
        expect(audit.entries).toEqual([]);
      },
    );

    it.each([
      ['GET', '/admin/api-keys'],
      ['POST', '/admin/unknown'],
      ['PUT', '/admin/api-keys'],
      ['POST', '/admin/rate-limit'],
      ['PUT', '/admin/api-keys/bad%20id/rate-limit'],
    ])('answers %s %s with 404 NOT_FOUND', async (method, path) => {
      const res = await setup().handler(request(method, path, {}));
      expect(res.statusCode).toBe(404);
      expect(parse(res.body)).toMatchObject({ errors: [{ code: 'NOT_FOUND' }] });
    });

    it('accepts a trailing slash and a base64-encoded body', async () => {
      const { handler, accessConfig } = setup();
      const res = await handler({
        ...request('PUT', '/admin/access-mode/'),
        body: Buffer.from('{"mode":"open"}').toString('base64'),
        isBase64Encoded: true,
      });
      expect(res.statusCode).toBe(200);
      await expect(accessConfig.load()).resolves.toMatchObject({ mode: 'open' });
    });

    it('rejects a body that is not a JSON object', async () => {
      const res = await setup().handler(request('PUT', '/admin/rate-limit', '[1,2]'));
      expect(res.statusCode).toBe(400);
      expect(parse(res.body)).toMatchObject({
        errors: [{ code: 'INVALID_PARAMETER', field: 'body' }],
      });
    });

    it('answers store failures with 503 without leaking details', async () => {
      const { accessConfig, audit } = setup();
      const fail = async (): Promise<never> => {
        throw new Error('secret internals');
      };
      const failing = { create: fail, revoke: fail, setRateLimit: fail };
      const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const handler = createAdminHandler({
        apiKeys: failing,
        accessConfig,
        audit,
        deletions: createDeletionHarness({ audit }).deletions,
      });
      const res = await handler(request('POST', '/admin/api-keys'));
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain('secret internals');
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret internals');
      log.mockRestore();
    });
  });

  describe('POST /admin/api-keys', () => {
    it('returns the plain key once, stores only its hash, and the guard accepts it', async () => {
      const { handler, guard, apiKeys } = setup();
      const res = await handler(request('POST', '/admin/api-keys'));

      expect(res.statusCode).toBe(201);
      expect(res.headers).toMatchObject({ 'Cache-Control': 'no-store' });
      expect(parse(res.body)).toEqual({ keyId: 'k-1', apiKey: GENERATED.apiKey, status: 'active' });
      expect(apiKeys.records()).toEqual([
        { keyId: 'k-1', keyHash: hashApiKey(GENERATED.apiKey), status: 'active' },
      ]);
      expect(JSON.stringify(apiKeys.records())).not.toContain(GENERATED.apiKey);

      await expect(
        guard.admit({ sourceIp: '203.0.113.1', authorization: `Bearer ${GENERATED.apiKey}` }),
      ).resolves.toMatchObject({ ok: true, value: { clientId: 'key:k-1' } });
    });

    it('stores expiresAt and a per-key rate limit that the guard applies', async () => {
      const { handler, guard, apiKeys } = setup();
      const res = await handler(
        request('POST', '/admin/api-keys', {
          expiresAt: '2026-06-01T00:00:00+02:00',
          rateLimit: { requests: 5, windowSeconds: 10 },
        }),
      );
      expect(res.statusCode).toBe(201);
      expect(apiKeys.records()[0]).toMatchObject({
        expiresAt: '2026-05-31T22:00:00.000Z',
        rateLimit: { requests: 5, windowSeconds: 10 },
      });
      await expect(
        guard.admit({ sourceIp: 'x', authorization: `Bearer ${GENERATED.apiKey}` }),
      ).resolves.toMatchObject({
        ok: true,
        value: { rateLimit: { requests: 5, windowSeconds: 10 } },
      });
    });

    it.each([
      [{ expiresAt: 'tomorrow' }, 'INVALID_PARAMETER', 'expiresAt'],
      [{ expiresAt: '2025-12-31T00:00:00Z' }, 'INVALID_PARAMETER', 'expiresAt'],
      [
        { rateLimit: { requests: 0, windowSeconds: 60 } },
        'INVALID_RATE_LIMIT',
        'rateLimit.requests',
      ],
      [{ rateLimit: 60 }, 'INVALID_RATE_LIMIT', 'rateLimit'],
    ])('rejects %p without storing anything', async (body, code, field) => {
      const { handler, apiKeys, audit } = setup();
      const res = await handler(request('POST', '/admin/api-keys', body));
      expect(res.statusCode).toBe(400);
      expect(parse(res.body)).toMatchObject({ errors: [{ code, field }] });
      expect(apiKeys.records()).toEqual([]);
      expect(audit.entries).toEqual([]);
    });

    it('generates distinct 256-bit base64url keys by default', () => {
      const a = generateApiKey();
      const b = generateApiKey();
      expect(a.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(a.apiKey, 'base64url')).toHaveLength(32);
      expect(a.apiKey).not.toBe(b.apiKey);
      expect(a.keyId).not.toBe(b.keyId);
    });
  });

  describe('DELETE /admin/api-keys/{keyId}', () => {
    it('revokes the key; the guard then rejects it as API_KEY_INVALID', async () => {
      const { handler, guard } = setup();
      await handler(request('POST', '/admin/api-keys'));

      const res = await handler(request('DELETE', '/admin/api-keys/k-1'));
      expect(res.statusCode).toBe(200);
      expect(parse(res.body)).toEqual({ keyId: 'k-1', status: 'revoked' });
      await expect(
        guard.admit({ sourceIp: 'x', authorization: `Bearer ${GENERATED.apiKey}` }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'API_KEY_INVALID' } });
    });

    it('answers an unknown key with 404 NOT_FOUND', async () => {
      const { handler, audit } = setup();
      const res = await handler(request('DELETE', '/admin/api-keys/missing'));
      expect(res.statusCode).toBe(404);
      expect(parse(res.body)).toMatchObject({ errors: [{ code: 'NOT_FOUND' }] });
      expect(audit.entries).toEqual([]);
    });
  });

  describe('PUT /admin/api-keys/{keyId}/rate-limit', () => {
    it('sets the key limit, which the guard then applies', async () => {
      const { handler, guard } = setup();
      await handler(request('POST', '/admin/api-keys'));
      const res = await handler(
        request('PUT', '/admin/api-keys/k-1/rate-limit', { requests: 1, windowSeconds: 3600 }),
      );
      expect(res.statusCode).toBe(200);
      expect(parse(res.body)).toEqual({
        keyId: 'k-1',
        status: 'active',
        rateLimit: { requests: 1, windowSeconds: 3600 },
      });
      const auth = { sourceIp: 'x', authorization: `Bearer ${GENERATED.apiKey}` };
      await expect(guard.admit(auth)).resolves.toMatchObject({ ok: true });
      await expect(guard.admit(auth)).resolves.toMatchObject({
        ok: false,
        error: { code: 'RATE_LIMITED' },
      });
    });

    it('rejects an invalid limit naming the value and keeps the previous limit', async () => {
      const { handler, apiKeys } = setup();
      await handler(
        request('POST', '/admin/api-keys', { rateLimit: { requests: 5, windowSeconds: 5 } }),
      );
      const res = await handler(
        request('PUT', '/admin/api-keys/k-1/rate-limit', { requests: 10_001, windowSeconds: 5 }),
      );
      expect(res.statusCode).toBe(400);
      expect(parse(res.body)).toEqual({
        errors: [
          {
            code: 'INVALID_RATE_LIMIT',
            field: 'requests',
            message: expect.stringContaining('10001'),
            details: { value: 10_001 },
          },
        ],
      });
      expect(apiKeys.records()[0]?.rateLimit).toEqual({ requests: 5, windowSeconds: 5 });
    });

    it('answers an unknown key with 404 NOT_FOUND', async () => {
      const res = await setup().handler(
        request('PUT', '/admin/api-keys/missing/rate-limit', { requests: 1, windowSeconds: 1 }),
      );
      expect(res.statusCode).toBe(404);
    });
  });

  describe('PUT /admin/rate-limit', () => {
    it('writes a valid global limit', async () => {
      const { handler, accessConfig } = setup();
      const res = await handler(
        request('PUT', '/admin/rate-limit', { requests: 100, windowSeconds: 30 }),
      );
      expect(res.statusCode).toBe(200);
      expect(parse(res.body)).toEqual({ rateLimit: { requests: 100, windowSeconds: 30 } });
      await expect(accessConfig.load()).resolves.toMatchObject({
        rateLimit: { requests: 100, windowSeconds: 30 },
      });
    });

    it.each([
      [{ requests: 0, windowSeconds: 60 }, ['requests']],
      [{ requests: 60, windowSeconds: 3601 }, ['windowSeconds']],
      [{ requests: 1.5, windowSeconds: 0 }, ['requests', 'windowSeconds']],
      [{ requests: '60', windowSeconds: 60 }, ['requests']],
      [{ windowSeconds: 60 }, ['requests']],
    ])('rejects %p with INVALID_RATE_LIMIT and keeps the old limit', async (body, fields) => {
      const { handler, accessConfig, audit } = setup();
      const res = await handler(request('PUT', '/admin/rate-limit', body));
      expect(res.statusCode).toBe(400);
      const { errors } = parse(res.body) as {
        errors: { code: string; field: string; message: string }[];
      };
      expect(errors.map((e) => [e.code, e.field])).toEqual(
        fields.map((f) => ['INVALID_RATE_LIMIT', f]),
      );
      for (const e of errors) {
        const value = (body as Record<string, unknown>)[e.field];
        expect(e.message).toContain(value === undefined ? 'missing' : JSON.stringify(value));
      }
      await expect(accessConfig.load()).resolves.toMatchObject({
        rateLimit: { requests: 60, windowSeconds: 60 },
      });
      expect(audit.entries).toEqual([]);
    });

    it('rejects unknown fields with INVALID_PARAMETER', async () => {
      const res = await setup().handler(
        request('PUT', '/admin/rate-limit', { requests: 1, windowSeconds: 1, burst: 5 }),
      );
      expect(parse(res.body)).toMatchObject({
        errors: [{ code: 'INVALID_PARAMETER', field: 'burst' }],
      });
    });
  });

  describe('PUT /admin/access-mode', () => {
    it('switches to open mode, after which the guard no longer requires a key', async () => {
      const { handler, guard } = setup();
      await expect(guard.admit({ sourceIp: '203.0.113.9' })).resolves.toMatchObject({
        ok: false,
        error: { code: 'API_KEY_MISSING' },
      });
      const res = await handler(request('PUT', '/admin/access-mode', { mode: 'open' }));
      expect(res.statusCode).toBe(200);
      expect(parse(res.body)).toEqual({ mode: 'open' });
      await expect(guard.admit({ sourceIp: '203.0.113.9' })).resolves.toMatchObject({ ok: true });
    });

    it('rejects an unknown mode and keeps the previous one', async () => {
      const { handler, accessConfig } = setup();
      const res = await handler(request('PUT', '/admin/access-mode', { mode: 'closed' }));
      expect(res.statusCode).toBe(400);
      expect(parse(res.body)).toMatchObject({
        errors: [{ code: 'INVALID_PARAMETER', field: 'mode' }],
      });
      await expect(accessConfig.load()).resolves.toMatchObject({ mode: 'api-keys' });
    });
  });

  describe('audit', () => {
    it('records every change as access-config with actor and time, without secrets', async () => {
      const { handler, audit, advance } = setup();
      await handler(
        request('POST', '/admin/api-keys', { rateLimit: { requests: 5, windowSeconds: 5 } }),
      );
      advance(1000);
      await handler(
        request('PUT', '/admin/api-keys/k-1/rate-limit', { requests: 7, windowSeconds: 7 }),
      );
      await handler(request('DELETE', '/admin/api-keys/k-1'));
      await handler(request('PUT', '/admin/rate-limit', { requests: 9, windowSeconds: 9 }));
      await handler(request('PUT', '/admin/access-mode', { mode: 'open' }));

      expect(audit.entries).toEqual([
        {
          type: 'access-config',
          action: 'api-key.created',
          actor: ADMIN,
          at: '2026-01-01T12:00:00.000Z',
          details: { keyId: 'k-1', status: 'active', rateLimit: { requests: 5, windowSeconds: 5 } },
        },
        {
          type: 'access-config',
          action: 'api-key.rate-limit-set',
          actor: ADMIN,
          at: '2026-01-01T12:00:01.000Z',
          details: { keyId: 'k-1', rateLimit: { requests: 7, windowSeconds: 7 } },
        },
        expect.objectContaining({ action: 'api-key.revoked', details: { keyId: 'k-1' } }),
        expect.objectContaining({
          action: 'rate-limit.set',
          details: { rateLimit: { requests: 9, windowSeconds: 9 } },
        }),
        expect.objectContaining({ action: 'access-mode.set', details: { mode: 'open' } }),
      ]);
      const serialized = JSON.stringify(audit.entries);
      expect(serialized).not.toContain(GENERATED.apiKey);
      expect(serialized).not.toContain(hashApiKey(GENERATED.apiKey));
    });
  });
});
