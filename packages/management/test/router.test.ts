import {
  createRouter,
  defineRoute,
  definePublicRoute,
  success,
  type RawRouteInput,
  type Route,
} from '@open-estate/management';
import type { Principal } from '@open-estate/shared';
import { z } from 'zod';

const principal: Principal = {
  kind: 'user',
  userId: 'u1',
  displayName: 'U',
  role: 'PLATFORM_ADMIN',
};

const echo = (method: Route['method'], path: string): Route =>
  defineRoute({ method, path, handle: async ({ params }) => success(200, params) });

const input = (overrides: Partial<RawRouteInput> = {}): RawRouteInput => ({
  params: {},
  query: {},
  body: '',
  signal: new AbortController().signal,
  ...overrides,
});

describe('createRouter', () => {
  const router = createRouter([
    echo('GET', '/listings/{id}'),
    echo('GET', '/listings/by-custom-id/{customId}'),
    echo('PUT', '/listings/{id}/status'),
    echo('GET', '/agencies/{agencyId}/members/{userId}'),
  ]);

  it('matches templates and URL-decodes parameters', () => {
    const found = router.match('GET', '/agencies/a%201/members/u1');
    expect(found?.route.path).toBe('/agencies/{agencyId}/members/{userId}');
    expect(found?.params).toEqual({ agencyId: 'a 1', userId: 'u1' });
  });

  it('prefers literal segments over parameters', () => {
    expect(router.match('GET', '/listings/by-custom-id/crm-7')).toMatchObject({
      route: { path: '/listings/by-custom-id/{customId}' },
      params: { customId: 'crm-7' },
    });
    expect(router.match('GET', '/listings/l1')?.params).toEqual({ id: 'l1' });
  });

  it('ignores trailing slashes and method case', () => {
    expect(router.match('put', '/listings/l1/status/')?.route.path).toBe('/listings/{id}/status');
  });

  it('returns undefined for unknown paths, other methods and malformed escapes', () => {
    expect(router.match('GET', '/unknown')).toBeUndefined();
    expect(router.match('DELETE', '/listings/l1')).toBeUndefined();
    expect(router.match('GET', '/listings/%E0%A4%A')).toBeUndefined();
    expect(router.match('GET', '/listings/l1/extra/segments')).toBeUndefined();
  });

  it('rejects duplicate routes at init', () => {
    expect(() => createRouter([echo('GET', '/a/{x}'), echo('GET', '/a/{y}')])).toThrow(
      'Duplicate route GET /a/{}',
    );
  });
});

describe('route parsing', () => {
  const route = defineRoute({
    method: 'PUT',
    path: '/listings/{id}',
    params: z.object({ id: z.string().regex(/^l\d+$/) }),
    query: z.object({ dryRun: z.enum(['true', 'false']).optional() }),
    body: z.object({ baseVersion: z.int().min(1) }),
    handle: async ({ params, query, body, principal: p }) =>
      success(200, { params, query, body, userId: p.kind === 'user' ? p.userId : null }),
  });

  it('passes validated input to the handler', async () => {
    const reply = await route.run(
      input({ params: { id: 'l1' }, query: { dryRun: 'true' }, body: '{"baseVersion":3}' }),
      principal,
    );
    expect(reply).toEqual({
      kind: 'success',
      status: 200,
      body: {
        params: { id: 'l1' },
        query: { dryRun: 'true' },
        body: { baseVersion: 3 },
        userId: 'u1',
      },
    });
  });

  it('reports all violations as catalog errors', async () => {
    const reply = await route.run(
      input({ params: { id: 'x' }, query: { dryRun: 'maybe' }, body: '{"baseVersion":0}' }),
      principal,
    );
    expect(reply.kind).toBe('failure');
    expect(reply.kind === 'failure' && reply.errors.map((e) => [e.code, e.field])).toEqual([
      ['INVALID_ID', 'id'],
      ['INVALID_PARAMETER', 'dryRun'],
      ['INVALID_PARAMETER', 'baseVersion'],
    ]);
  });

  it('rejects a body that is not JSON', async () => {
    const reply = await route.run(input({ params: { id: 'l1' }, body: '{' }), principal);
    expect(reply).toEqual({
      kind: 'failure',
      errors: [{ code: 'INVALID_PARAMETER', message: 'Body must be valid JSON', field: 'body' }],
    });
  });

  it('parses a missing body as undefined', async () => {
    const optional = defineRoute({
      method: 'POST',
      path: '/x',
      body: z.object({ a: z.string() }).optional(),
      handle: async ({ body }) => success(200, { body: body ?? null }),
    });
    expect(await optional.run(input({ body: '  ' }), principal)).toMatchObject({
      body: { body: null },
    });
  });

  it('marks public routes and runs them without principal', async () => {
    const open = definePublicRoute({
      method: 'GET',
      path: '/openapi.json',
      handle: async () => success(200, { openapi: '3.1.0' }),
    });
    expect(open.public).toBe(true);
    expect(route.public).toBe(false);
    expect(await open.run(input(), undefined)).toMatchObject({ status: 200 });
  });
});
