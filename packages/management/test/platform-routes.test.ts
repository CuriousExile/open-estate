import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SFNClient } from '@aws-sdk/client-sfn';
import { SSMClient } from '@aws-sdk/client-ssm';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  ADMIN_ENV,
  createAdminHandler,
  InMemoryDeletionBlocklistStore,
  InMemoryDeletionListingStore,
  InMemoryDeletionRequestStore,
} from '@open-estate/admin';
import {
  ConfigError,
  createAdminOperations,
  InMemoryAdminAuditLog,
  InMemoryApiKeyStore,
  InMemoryAuditService,
  StaticAccessConfigSource,
  type ReloadOutcome,
} from '@open-estate/core';
import type { Principal } from '@open-estate/shared';
import { createRouter, toProxyResult, type RouteGroupContext } from '@open-estate/management';
import {
  createPlatformRoutes,
  parseFunctionNames,
  PLATFORM_ENV,
  platformDepsFromEnv,
  withSignal,
  type PlatformDeps,
} from '../src/routes/platform';

const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const ADMIN: Principal = {
  kind: 'user',
  userId: 'u-admin',
  displayName: 'Platform Admin',
  role: 'PLATFORM_ADMIN',
};
const AGENCY_ADMIN: Principal = {
  kind: 'user',
  userId: 'u-agency',
  displayName: 'Agency Admin',
  role: 'AGENCY_ADMIN',
  agencyId: 'a-1',
};
const MACHINE: Principal = {
  kind: 'machine',
  keyId: 'mk-1',
  label: 'CRM',
  agencyId: 'a-1',
  permissions: ['listing:read'],
};

/** Fresh state shared by one Admin_API handler and one set of `/platform/*` routes. */
function world() {
  const audit = new InMemoryAdminAuditLog();
  const accessConfig = new StaticAccessConfigSource({
    mode: 'open',
    rateLimit: { requests: 60, windowSeconds: 60 },
  });
  const apiKeys = new InMemoryApiKeyStore();
  const requests = new InMemoryDeletionRequestStore();
  const listings = new InMemoryDeletionListingStore({ requests });
  for (const id of ['L-1', 'L-2', 'L-3']) listings.put({ id, source: 'crawler' });
  listings.put({ id: 'L-9', source: 'other' });
  const blocklist = new InMemoryDeletionBlocklistStore();
  const started: string[] = [];
  let requestSeq = 0;
  let keySeq = 0;
  const deps = {
    apiKeys,
    accessConfig,
    audit,
    clock: () => NOW,
    generateKey: () => ({ keyId: `key-${++keySeq}`, apiKey: `secret-${keySeq}` }),
    deletions: {
      requests,
      listings,
      blocklist,
      starter: { start: async (id: string) => void started.push(id) },
      newRequestId: () => `req-${++requestSeq}`,
    },
  };
  const reloads: AbortSignal[] = [];
  const outcomes: ReloadOutcome[] = [
    { functionName: 'api', status: 'updated', previousConfigVersion: '1', configVersion: '2' },
    { functionName: 'mcp', status: 'failed', error: 'Error: boom' },
  ];
  const signals: AbortSignal[] = [];
  const platform: PlatformDeps = {
    operations: (signal) => {
      signals.push(signal);
      return createAdminOperations(deps);
    },
    deletionTargets: () => listings,
    reload: async (signal) => {
      reloads.push(signal);
      return outcomes;
    },
  };
  const router = createRouter(createPlatformRoutes(platform));

  async function call(
    method: string,
    path: string,
    body?: unknown,
    principal: Principal = ADMIN,
    query: Record<string, string> = {},
  ) {
    const found = router.match(method, path);
    if (found === undefined) throw new Error(`no route ${method} ${path}`);
    const signal = new AbortController().signal;
    const raw = body === undefined ? '' : JSON.stringify(body);
    const reply = await found.route.run(
      { params: found.params, query, body: raw, signal },
      principal,
    );
    const result = toProxyResult(reply);
    return {
      status: result.statusCode,
      body: result.body === '' ? undefined : JSON.parse(result.body),
    };
  }

  const admin = createAdminHandler(deps);
  async function callAdmin(method: string, path: string, body?: unknown) {
    const result = await admin({
      httpMethod: method,
      path,
      body: body === undefined ? null : JSON.stringify(body),
      requestContext: { identity: { userArn: 'arn:aws:iam::123456789012:user/ops' } },
    });
    return { status: result.statusCode, body: JSON.parse(result.body) as unknown };
  }

  return {
    call,
    callAdmin,
    audit,
    accessConfig,
    requests,
    blocklist,
    started,
    signals,
    reloads,
    outcomes,
  };
}

describe('/platform/* parity with /admin/*', () => {
  // [method, platform path, body]; the admin path replaces the prefix.
  const cases: [string, string, unknown][] = [
    ['POST', '/platform/api-keys', {}],
    ['POST', '/platform/api-keys', { rateLimit: { requests: 0, windowSeconds: 60 } }],
    ['POST', '/platform/api-keys', { expiresAt: '2020-01-01T00:00:00Z' }],
    ['POST', '/platform/api-keys', { unknown: 1 }],
    ['POST', '/platform/api-keys', [1]],
    ['DELETE', '/platform/api-keys/missing', undefined],
    ['PUT', '/platform/api-keys/missing/rate-limit', { requests: 10, windowSeconds: 60 }],
    ['PUT', '/platform/rate-limit', { requests: 10, windowSeconds: 60 }],
    ['PUT', '/platform/rate-limit', { requests: 'x' }],
    ['PUT', '/platform/access-mode', { mode: 'api-keys' }],
    ['PUT', '/platform/access-mode', { mode: 'closed' }],
    ['POST', '/platform/deletions', { listingId: 'L-1' }],
    ['POST', '/platform/deletions', { source: 'crawler' }],
    ['POST', '/platform/deletions', { listingId: 'L-404' }],
    ['POST', '/platform/deletions', { listingId: 'L-1', source: 'crawler' }],
    ['GET', '/platform/deletions/req-404', undefined],
    ['DELETE', '/platform/deletion-blocklist/L-1', undefined],
  ];

  it.each(cases)('%s %s %j: same status, body and audit action', async (method, path, body) => {
    const platform = world();
    const admin = world();
    const adminPath = path.replace('/platform/', '/admin/');

    const viaPlatform = await platform.call(method, path, body);
    const viaAdmin = await admin.callAdmin(method, adminPath, body);

    // `requestedBy` is the actor: the Plattform_Admin's user id vs. the IAM userArn.
    const normalize = (value: unknown) =>
      JSON.parse(JSON.stringify(value).replace(/"requestedBy":"[^"]*"/g, '"requestedBy":"*"'));
    expect(viaPlatform.status).toBe(viaAdmin.status);
    expect(normalize(viaPlatform.body)).toEqual(normalize(viaAdmin.body));
    expect(platform.audit.entries.map((e) => [e.type, e.action, e.details])).toEqual(
      admin.audit.entries.map((e) => [e.type, e.action, e.details]),
    );
    expect(platform.audit.entries.every((e) => e.actor === ADMIN.userId)).toBe(true);
  });

  it('rejects ids the Admin_API does not route with the same 404 NOT_FOUND', async () => {
    const w = world();
    for (const path of ['/api-keys/bad%20id', '/api-keys/bad%20id/rate-limit']) {
      const method = path.endsWith('rate-limit') ? 'PUT' : 'DELETE';
      const body = method === 'PUT' ? { requests: 1, windowSeconds: 1 } : undefined;
      const viaPlatform = await w.call(method, `/platform${path}`, body);
      const viaAdmin = await w.callAdmin(method, `/admin${path}`, body);
      expect(viaPlatform).toMatchObject({ status: 404, body: { errors: [{ code: 'NOT_FOUND' }] } });
      expect(viaAdmin).toMatchObject({ status: 404, body: { errors: [{ code: 'NOT_FOUND' }] } });
    }
  });

  it('reads a created deletion request back and lifts a block', async () => {
    const w = world();
    const created = await w.call('POST', '/platform/deletions', { listingId: 'L-1' });
    expect(created).toMatchObject({
      status: 202,
      body: { requestId: 'req-1', status: 'OPEN', requestedBy: 'u-admin' },
    });
    expect(w.started).toEqual(['req-1']);
    expect(await w.call('GET', '/platform/deletions/req-1')).toMatchObject({
      status: 200,
      body: { requestId: 'req-1', criterion: { listingId: 'L-1' } },
    });

    await w.blocklist.block({
      listingId: 'L-1',
      source: 'crawler',
      deletedAt: new Date(NOW).toISOString(),
      requestId: 'req-1',
    });
    expect(await w.call('DELETE', '/platform/deletion-blocklist/L-1')).toEqual({
      status: 200,
      body: { listingId: 'L-1' },
    });
    expect(w.audit.entries.map((e) => [e.action, e.actor])).toEqual([
      ['deletion-blocklist.entry-removed', 'u-admin'],
    ]);
  });

  it('hands the request signal to the use cases', async () => {
    const w = world();
    await w.call('PUT', '/platform/access-mode', { mode: 'api-keys' });
    expect(w.signals).toHaveLength(1);
    expect(w.signals[0]).toBeInstanceOf(AbortSignal);
  });
});

describe('POST /platform/deletions?dryRun=true', () => {
  const dryRun = { dryRun: 'true' };

  it('counts the affected listings of a source without writing anything', async () => {
    const w = world();
    const result = await w.call(
      'POST',
      '/platform/deletions',
      { source: 'crawler' },
      ADMIN,
      dryRun,
    );
    expect(result).toEqual({ status: 200, body: { dryRun: true, affectedListings: 3 } });
    expect(w.started).toEqual([]);
    expect(await w.requests.get('req-1')).toBeNull();
    expect(w.audit.entries).toEqual([]);
  });

  it('counts one listing for an existing listingId', async () => {
    const w = world();
    expect(
      await w.call('POST', '/platform/deletions', { listingId: 'L-9' }, ADMIN, dryRun),
    ).toEqual({ status: 200, body: { dryRun: true, affectedListings: 1 } });
  });

  it('predicts the error of the real request', async () => {
    const w = world();
    for (const body of [
      { listingId: 'L-404' },
      { source: 'none' },
      {},
      { listingId: 'L-1', x: 1 },
    ]) {
      const preview = await w.call('POST', '/platform/deletions', body, ADMIN, dryRun);
      const real = await world().call('POST', '/platform/deletions', body);
      expect(preview).toEqual(real);
    }
    expect(w.started).toEqual([]);
  });

  it('rejects an invalid dryRun value', async () => {
    const w = world();
    const result = await w.call('POST', '/platform/deletions', { listingId: 'L-1' }, ADMIN, {
      dryRun: 'maybe',
    });
    expect(result.status).toBe(400);
    expect(w.started).toEqual([]);
  });
});

describe('POST /platform/reload', () => {
  it('returns one outcome per configured function, including failures', async () => {
    const w = world();
    expect(await w.call('POST', '/platform/reload')).toEqual({
      status: 200,
      body: { functions: w.outcomes },
    });
    expect(w.reloads).toHaveLength(1);
  });
});

describe('authorization', () => {
  const writes: [string, string, unknown][] = [
    ['POST', '/platform/deletions', { listingId: 'L-1' }],
    ['GET', '/platform/deletions/req-1', undefined],
    ['DELETE', '/platform/deletion-blocklist/L-1', undefined],
    ['POST', '/platform/api-keys', {}],
    ['DELETE', '/platform/api-keys/key-1', undefined],
    ['PUT', '/platform/api-keys/key-1/rate-limit', { requests: 1, windowSeconds: 1 }],
    ['PUT', '/platform/rate-limit', { requests: 1, windowSeconds: 1 }],
    ['PUT', '/platform/access-mode', { mode: 'api-keys' }],
    ['POST', '/platform/reload', undefined],
  ];

  it.each(writes)('%s %s: 403 for every principal except Plattform_Admin', async (m, p, b) => {
    const w = world();
    for (const principal of [AGENCY_ADMIN, MACHINE]) {
      expect(await w.call(m, p, b, principal)).toEqual({
        status: 403,
        body: { errors: [{ code: 'FORBIDDEN', message: 'Missing permission platform:operate' }] },
      });
    }
    expect(w.started).toEqual([]);
    expect(w.reloads).toEqual([]);
    expect(w.signals).toEqual([]);
    expect(w.audit.entries).toEqual([]);
    expect((await w.accessConfig.load()).mode).toBe('open');
  });
});

describe('platformDepsFromEnv', () => {
  const ENV: Record<string, string> = {
    API_KEYS_TABLE_NAME: 'ApiKeys',
    ACCESS_MODE_PARAMETER_NAME: '/oe/test/access-mode',
    RATE_LIMIT_PARAMETER_NAME: '/oe/test/rate-limit',
    LISTINGS_TABLE_NAME: 'Listings',
    DELETION_REQUESTS_TABLE_NAME: 'DeletionRequests',
    DELETION_BLOCKLIST_TABLE_NAME: 'DeletionBlocklist',
    AUDIT_LOG_TABLE_NAME: 'AuditLog',
    DELETION_STATE_MACHINE_ARN: 'arn:aws:states:eu-central-1:123456789012:stateMachine:del',
    RELOAD_FUNCTION_NAMES: 'api, mcp,,connector-x',
  };

  function context(env: Record<string, string | undefined>): RouteGroupContext {
    const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
    return {
      env,
      clients: { dynamo, ssm: new SSMClient({ region: 'eu-central-1' }) },
      shared: {
        frontendOrigin: 'https://portal.example.com',
        audit: new InMemoryAuditService(),
        clock: () => NOW,
      },
    };
  }

  const awsClients = () => ({
    sfn: new SFNClient({ region: 'eu-central-1' }),
    lambda: new LambdaClient({ region: 'eu-central-1' }),
  });

  afterEach(() => jest.restoreAllMocks());

  it('reads the Admin-Lambda variables plus the reload targets', () => {
    expect(PLATFORM_ENV).toEqual({ ...ADMIN_ENV, reloadFunctions: 'RELOAD_FUNCTION_NAMES' });
  });

  it('names every missing variable', () => {
    const env = { ...ENV, API_KEYS_TABLE_NAME: undefined, RELOAD_FUNCTION_NAMES: ' ' };
    expect(() => platformDepsFromEnv(context(env), awsClients())).toThrow(
      expect.objectContaining({
        code: 'CONFIG_MISSING',
        names: ['API_KEYS_TABLE_NAME', 'RELOAD_FUNCTION_NAMES'],
      }) as Error,
    );
  });

  it('parses the reload targets', () => {
    expect(parseFunctionNames('api, mcp,,connector-x, api')).toEqual(['api', 'mcp', 'connector-x']);
    expect(() => parseFunctionNames(' , ')).toThrow(ConfigError);
  });

  it('binds the DynamoDB calls of a request to its signal', async () => {
    const ctx = context(ENV);
    const send = jest.spyOn(ctx.clients.dynamo, 'send').mockImplementation(async () => ({}));
    const deps = platformDepsFromEnv(ctx, awsClients());
    const controller = new AbortController();

    const result = await deps.operations(controller.signal).getDeletionRequest('req-1');

    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(send).toHaveBeenCalledTimes(1);
    const [command, options] = send.mock.calls[0] as unknown as [unknown, { abortSignal: unknown }];
    expect(command).toBeInstanceOf(GetCommand);
    expect((command as GetCommand).input.TableName).toBe('DeletionRequests');
    expect(options.abortSignal).toBe(controller.signal);
  });

  it('reloads the configured functions with the request signal', async () => {
    const clients = awsClients();
    const send = jest
      .spyOn(clients.lambda, 'send')
      .mockImplementation(async () => Promise.reject(new Error('denied')));
    const deps = platformDepsFromEnv(context(ENV), clients);
    const controller = new AbortController();

    const outcomes = await deps.reload(controller.signal);

    expect(outcomes.map((o) => [o.functionName, o.status])).toEqual([
      ['api', 'failed'],
      ['mcp', 'failed'],
      ['connector-x', 'failed'],
    ]);
    const options = send.mock.calls[0]?.[1] as { abortSignal?: unknown } | undefined;
    expect(options?.abortSignal).toBe(controller.signal);
  });
});

describe('withSignal', () => {
  it('merges the signal into the send options and forwards other members', async () => {
    const calls: unknown[] = [];
    const client = {
      region: 'eu',
      async send(command: string, options?: object) {
        calls.push([command, options]);
        return this.region;
      },
    };
    const signal = new AbortController().signal;
    const bound = withSignal(client, signal);
    expect(await bound.send('cmd', { requestTimeout: 5 })).toBe('eu');
    expect(bound.region).toBe('eu');
    expect(calls).toEqual([['cmd', { requestTimeout: 5, abortSignal: signal }]]);
  });
});
