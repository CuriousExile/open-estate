import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  agencyScope,
  AgencyService,
  ConfigError,
  InMemoryAgencyStore,
  InMemoryAuditService,
  InMemoryIdentityDirectory,
  InMemoryMachineAccessStore,
  InMemoryMembershipStore,
  InMemoryMetricCounterStore,
  InMemoryPlatformCounterStore,
  InMemoryTransactor,
  LISTING_COUNTER_CODES,
  MachineAccessService,
  MembershipService,
  type AgencyRecord,
  type MembershipRecord,
} from '@open-estate/core';
import { createRouter, replyStatus, type Reply } from '@open-estate/management';
import { ROLE_PERMISSIONS, type Principal } from '@open-estate/shared';
import { AgencyOverview } from '../src/routes/identity/agency-overview';
import { machineAccessAudit } from '../src/routes/identity/services';
import {
  createIdentityRouteList,
  createIdentityRoutes,
  IDENTITY_ENV,
  meResponse,
} from '../src/routes/identity';

const NOW = Date.parse('2026-03-01T10:00:00Z');
const CREATED = '2026-01-01T00:00:00.000Z';

const platformAdmin: Principal = {
  kind: 'user',
  userId: 'p1',
  displayName: 'Pia',
  role: 'PLATFORM_ADMIN',
};
const agencyAdmin: Principal = {
  kind: 'user',
  userId: 'u-admin',
  displayName: 'Ada',
  role: 'AGENCY_ADMIN',
  agencyId: 'a1',
};
const agencyMember: Principal = {
  kind: 'user',
  userId: 'u-member',
  displayName: 'Max',
  role: 'AGENCY_MEMBER',
  agencyId: 'a1',
};
const foreignAdmin: Principal = { ...agencyAdmin, userId: 'u-foreign', agencyId: 'a2' };
const machine: Principal = {
  kind: 'machine',
  keyId: 'k1',
  label: 'CRM',
  agencyId: 'a1',
  permissions: ['listing:read', 'listing:write'],
};

const agency = (agencyId: string, state: AgencyRecord['state'], agencyAdmins = 0) => ({
  agencyId,
  displayName: `Agency ${agencyId}`,
  state,
  createdAt: CREATED,
  agencyAdmins,
});

const membership = (
  userId: string,
  role: MembershipRecord['role'],
  agencyId?: string,
): MembershipRecord => ({
  userId,
  email: `${userId}@example.com`,
  displayName: userId,
  role,
  ...(agencyId !== undefined && { agencyId }),
  createdAt: CREATED,
});

function setup() {
  const agencies = new InMemoryAgencyStore([
    agency('a1', 'ACTIVE', 1),
    agency('a2', 'ACTIVE', 1),
    agency('a3', 'SUSPENDED'),
  ]);
  const memberships = new InMemoryMembershipStore([
    membership('p1', 'PLATFORM_ADMIN'),
    membership('u-admin', 'AGENCY_ADMIN', 'a1'),
    membership('u-member', 'AGENCY_MEMBER', 'a1'),
    membership('u-foreign', 'AGENCY_ADMIN', 'a2'),
  ]);
  const counters = new InMemoryMetricCounterStore();
  const machineAccesses = new InMemoryMachineAccessStore();
  const identity = new InMemoryIdentityDirectory();
  const audit = new InMemoryAuditService({ now: () => NOW });
  const clock = () => NOW;
  const routes = createIdentityRouteList({
    agencies: new AgencyService({ agencies, memberships, counters, audit, clock }),
    memberships: new MembershipService({
      memberships,
      agencies,
      platformCounters: new InMemoryPlatformCounterStore({ platformAdmins: 1 }),
      identity,
      transactor: new InMemoryTransactor(),
      audit,
      clock,
    }),
    machineAccess: new MachineAccessService({
      store: machineAccesses,
      agencies,
      audit: machineAccessAudit(audit),
      clock,
    }),
    overview: new AgencyOverview({ agencies, memberships, counters }),
    machineAccessStore: machineAccesses,
  });
  const router = createRouter(routes);

  async function call(
    principal: Principal,
    method: string,
    path: string,
    { query = {}, body }: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<{ status: number; body: unknown; reply: Reply }> {
    const [pathname = path, search] = path.split('?');
    const found = router.match(method, pathname);
    if (found === undefined) throw new Error(`no route ${method} ${path}`);
    const reply = await found.route.run(
      {
        params: found.params,
        query: { ...Object.fromEntries(new URLSearchParams(search ?? '')), ...query },
        body: body === undefined ? '' : JSON.stringify(body),
        signal: new AbortController().signal,
      },
      principal,
    );
    return {
      status: replyStatus(reply),
      body: reply.kind === 'success' ? reply.body : { errors: reply.errors },
      reply,
    };
  }

  return { call, agencies, memberships, counters, machineAccesses, identity, audit, routes };
}

const codes = (body: unknown) => (body as { errors: { code: string }[] }).errors.map((e) => e.code);

describe('GET /me', () => {
  it('returns role, agency and the role permissions of a user', async () => {
    const { call } = setup();
    const { status, body } = await call(agencyMember, 'GET', '/me');
    expect(status).toBe(200);
    expect(body).toEqual({
      kind: 'user',
      id: 'u-member',
      displayName: 'Max',
      role: 'AGENCY_MEMBER',
      agencyId: 'a1',
      permissions: [...ROLE_PERMISSIONS.AGENCY_MEMBER],
    });
  });

  it('returns no agency for a Plattform_Admin and the granted set for a machine access', () => {
    expect(meResponse(platformAdmin)).toEqual({
      kind: 'user',
      id: 'p1',
      displayName: 'Pia',
      role: 'PLATFORM_ADMIN',
      permissions: [...ROLE_PERMISSIONS.PLATFORM_ADMIN],
    });
    expect(meResponse(machine)).toEqual({
      kind: 'machine',
      id: 'k1',
      displayName: 'CRM',
      agencyId: 'a1',
      permissions: ['listing:read', 'listing:write'],
    });
  });
});

describe('agencies', () => {
  it('creates an ACTIVE agency for a Plattform_Admin only', async () => {
    const { call } = setup();
    const created = await call(platformAdmin, 'POST', '/agencies', {
      body: { displayName: 'Nordlicht Immobilien' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ displayName: 'Nordlicht Immobilien', state: 'ACTIVE' });

    const denied = await call(agencyAdmin, 'POST', '/agencies', { body: { displayName: 'X' } });
    expect(denied.status).toBe(403);
    expect(codes(denied.body)).toEqual(['FORBIDDEN']);
  });

  it('rejects an invalid body before the use case', async () => {
    const { call } = setup();
    const { status } = await call(platformAdmin, 'POST', '/agencies', {
      body: { displayName: '' },
    });
    expect(status).toBe(400);
  });

  it('lets members read their own agency and answers 404 for a foreign one', async () => {
    const { call } = setup();
    expect((await call(agencyMember, 'GET', '/agencies/a1')).status).toBe(200);
    const foreign = await call(agencyMember, 'GET', '/agencies/a2');
    expect(foreign.status).toBe(404);
    expect(codes(foreign.body)).toEqual(['NOT_FOUND']);
  });

  it('previews a suspension with listing and user counts, then suspends', async () => {
    const { call, counters, agencies } = setup();
    await counters.add({
      scope: agencyScope('a1'),
      code: LISTING_COUNTER_CODES.status('ACTIVE'),
      delta: 3,
    });
    await counters.add({
      scope: agencyScope('a1'),
      code: LISTING_COUNTER_CODES.status('INACTIVE'),
      delta: 2,
    });

    const preview = await call(platformAdmin, 'PATCH', '/agencies/a1?dryRun=true', {
      body: { state: 'SUSPENDED' },
    });
    expect(preview).toMatchObject({
      status: 200,
      body: { dryRun: true, affectedListings: 5, affectedUsers: 2 },
    });
    expect((await agencies.get('a1'))?.state).toBe('ACTIVE');

    const done = await call(platformAdmin, 'PATCH', '/agencies/a1', {
      body: { state: 'SUSPENDED' },
    });
    expect(done).toMatchObject({ status: 200, body: { agencyId: 'a1', state: 'SUSPENDED' } });
  });

  it('lists the agency overview across states with page tokens', async () => {
    const { call, counters } = setup();
    await counters.add({
      scope: agencyScope('a1'),
      code: LISTING_COUNTER_CODES.status('ACTIVE'),
      delta: 4,
    });

    const first = await call(platformAdmin, 'GET', '/agencies', { query: { pageSize: '2' } });
    expect(first.status).toBe(200);
    const page1 = first.body as {
      items: { agencyId: string; memberCount: number; listingCounts: unknown }[];
      nextPageToken?: string;
    };
    expect(page1.items.map((item) => item.agencyId)).toEqual(['a1', 'a2']);
    expect(page1.items[0]).toMatchObject({
      memberCount: 2,
      listingCounts: { ACTIVE: 4, INACTIVE: 0 },
    });
    expect(page1.nextPageToken).toBeDefined();

    const second = await call(platformAdmin, 'GET', '/agencies', {
      query: { pageSize: '2', pageToken: page1.nextPageToken ?? '' },
    });
    expect(second.body).toEqual({
      items: [expect.objectContaining({ agencyId: 'a3', state: 'SUSPENDED', memberCount: 0 })],
    });

    const filtered = await call(platformAdmin, 'GET', '/agencies', {
      query: { state: 'SUSPENDED' },
    });
    expect((filtered.body as { items: unknown[] }).items).toHaveLength(1);
  });

  it('rejects a foreign page token and non-admins on the overview', async () => {
    const { call } = setup();
    const invalid = await call(platformAdmin, 'GET', '/agencies', {
      query: { pageToken: 'bm90LWEtdG9rZW4' },
    });
    expect(invalid.status).toBe(400);
    expect(codes(invalid.body)).toEqual(['INVALID_PAGE_TOKEN']);
    expect((await call(agencyAdmin, 'GET', '/agencies')).status).toBe(403);
  });
});

describe('members', () => {
  it('invites an unknown address and grants the role', async () => {
    const { call, identity } = setup();
    const added = await call(agencyAdmin, 'POST', '/agencies/a1/members', {
      body: { email: 'new@example.com', role: 'AGENCY_MEMBER' },
    });
    expect(added).toMatchObject({
      status: 201,
      body: { email: 'new@example.com', role: 'AGENCY_MEMBER', agencyId: 'a1' },
    });
    expect(identity.invited).toEqual(['new@example.com']);

    const listed = await call(agencyAdmin, 'GET', '/agencies/a1/members');
    expect((listed.body as { items: unknown[] }).items).toHaveLength(3);
  });

  it('keeps the last AGENCY_ADMIN: role change and removal (also as dry run) → 409', async () => {
    const { call, memberships } = setup();
    const demote = await call(agencyAdmin, 'PATCH', '/agencies/a1/members/u-admin', {
      body: { role: 'AGENCY_MEMBER' },
    });
    expect(demote.status).toBe(409);
    expect(codes(demote.body)).toEqual(['LAST_AGENCY_ADMIN']);

    const preview = await call(agencyAdmin, 'DELETE', '/agencies/a1/members/u-admin?dryRun=true');
    expect(codes(preview.body)).toEqual(['LAST_AGENCY_ADMIN']);
    expect((await memberships.get('u-admin'))?.role).toBe('AGENCY_ADMIN');
  });

  it('previews and removes a member; members of other agencies are not found', async () => {
    const { call, memberships } = setup();
    const preview = await call(agencyAdmin, 'DELETE', '/agencies/a1/members/u-member', {
      query: { dryRun: 'true' },
    });
    expect(preview.body).toEqual({ dryRun: true, affectedUsers: 1 });
    expect(await memberships.get('u-member')).not.toBeNull();

    const removed = await call(agencyAdmin, 'DELETE', '/agencies/a1/members/u-member');
    expect(removed).toMatchObject({ status: 200, body: { userId: 'u-member' } });
    expect(await memberships.get('u-member')).toBeNull();

    expect((await call(foreignAdmin, 'GET', '/agencies/a1/members')).status).toBe(404);
    expect((await call(agencyMember, 'GET', '/agencies/a1/members')).status).toBe(403);
  });
});

describe('platform admins', () => {
  it('refuses to revoke the last Plattform_Admin, also as dry run', async () => {
    const { call } = setup();
    const preview = await call(platformAdmin, 'DELETE', '/platform-admins/p1?dryRun=true');
    expect(codes(preview.body)).toEqual(['LAST_PLATFORM_ADMIN']);
    const revoke = await call(platformAdmin, 'DELETE', '/platform-admins/p1');
    expect(revoke.status).toBe(409);
  });

  it('adds a second Plattform_Admin, previews and revokes the first', async () => {
    const { call } = setup();
    const added = await call(platformAdmin, 'POST', '/platform-admins', {
      body: { email: 'ops@example.com' },
    });
    expect(added).toMatchObject({ status: 201, body: { role: 'PLATFORM_ADMIN' } });
    expect((await call(platformAdmin, 'DELETE', '/platform-admins/p1?dryRun=true')).body).toEqual({
      dryRun: true,
      affectedUsers: 1,
    });
    const listed = await call(platformAdmin, 'GET', '/platform-admins');
    expect((listed.body as { items: unknown[] }).items).toHaveLength(2);
    expect((await call(platformAdmin, 'DELETE', '/platform-admins/p1')).status).toBe(200);
  });

  it('is not available to agency actors', async () => {
    const { call } = setup();
    expect((await call(agencyAdmin, 'GET', '/platform-admins')).status).toBe(403);
  });
});

describe('machine access', () => {
  it('rejects every ungrantable permission with 400', async () => {
    const { call } = setup();
    const { status, body } = await call(agencyAdmin, 'POST', '/agencies/a1/machine-access', {
      body: { label: 'CRM', permissions: ['listing:read', 'member:manage', 'agency:manage'] },
    });
    expect(status).toBe(400);
    expect(body).toEqual({
      errors: [
        expect.objectContaining({
          code: 'INVALID_PERMISSION',
          details: { permission: 'member:manage' },
        }),
        expect.objectContaining({
          code: 'INVALID_PERMISSION',
          details: { permission: 'agency:manage' },
        }),
      ],
    });
  });

  it('returns the secret once, lists without it, previews and revokes', async () => {
    const { call, machineAccesses } = setup();
    const created = await call(agencyAdmin, 'POST', '/agencies/a1/machine-access', {
      body: { label: 'CRM', permissions: ['listing:read'] },
    });
    expect(created.status).toBe(201);
    const { keyId, secret } = created.body as { keyId: string; secret: string };
    expect(secret).toMatch(/^oem_/);

    const listed = await call(agencyAdmin, 'GET', '/agencies/a1/machine-access');
    const items = (listed.body as { items: Record<string, unknown>[] }).items;
    expect(items).toEqual([expect.objectContaining({ keyId, label: 'CRM', createdBy: 'u-admin' })]);
    expect(items[0]).not.toHaveProperty('secret');
    expect(items[0]).not.toHaveProperty('keyHash');

    const path = `/agencies/a1/machine-access/${keyId}`;
    const preview = await call(agencyAdmin, 'DELETE', `${path}?dryRun=true`);
    expect(preview.body).toEqual({ dryRun: true, affectedListings: 0, affectedUsers: 0 });
    expect((await machineAccesses.get(keyId))?.revokedAt).toBeUndefined();

    expect((await call(foreignAdmin, 'DELETE', `${path}?dryRun=true`)).status).toBe(404);
    expect((await call(agencyMember, 'DELETE', `${path}?dryRun=true`)).status).toBe(403);
    expect(
      (await call(agencyAdmin, 'DELETE', '/agencies/a1/machine-access/unknown?dryRun=true')).status,
    ).toBe(404);

    const revoked = await call(agencyAdmin, 'DELETE', path);
    expect(revoked).toMatchObject({
      status: 200,
      body: { keyId, revokedAt: new Date(NOW).toISOString() },
    });
  });

  it('audits machine-access writes in the management category', async () => {
    const { call, audit } = setup();
    await call(agencyAdmin, 'POST', '/agencies/a1/machine-access', {
      body: { label: 'CRM', permissions: ['listing:read'] },
    });
    const entries = await audit.query({ action: 'machine-access.create' }, { limit: 10 });
    expect(entries.items).toEqual([
      expect.objectContaining({ category: 'management', agencyId: 'a1', result: 'SUCCESS' }),
    ]);
  });
});

describe('identityRoutes group', () => {
  const env = {
    USER_POOL_ID: 'eu-central-1_abc',
    MEMBERSHIPS_TABLE_NAME: 'Memberships',
    AGENCIES_TABLE_NAME: 'Agencies',
    MACHINE_ACCESS_TABLE_NAME: 'MachineAccess',
    PLATFORM_COUNTERS_TABLE_NAME: 'PlatformCounters',
    METRIC_COUNTERS_TABLE_NAME: 'MetricCounters',
  };
  const context = (values: Record<string, string | undefined>) => ({
    env: values,
    clients: {
      dynamo: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' })),
      ssm: new SSMClient({ region: 'eu-central-1' }),
    },
    shared: {
      frontendOrigin: 'https://portal.example.com',
      audit: new InMemoryAuditService(),
      clock: () => NOW,
    },
  });

  it('registers every identity route', () => {
    const routes = createIdentityRoutes({ identity: new InMemoryIdentityDirectory() }).create(
      context(env),
    );
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual(
      setup().routes.map((route) => `${route.method} ${route.path}`),
    );
    expect(routes).toHaveLength(15);
    expect(routes.every((route) => !route.public)).toBe(true);
  });

  it('names every missing table variable', () => {
    const create = () =>
      createIdentityRoutes().create(
        context({
          ...env,
          PLATFORM_COUNTERS_TABLE_NAME: undefined,
          METRIC_COUNTERS_TABLE_NAME: '',
        }),
      );
    expect(create).toThrow(ConfigError);
    expect(create).toThrow(
      expect.objectContaining({
        names: [IDENTITY_ENV.platformCountersTable, IDENTITY_ENV.metricCountersTable],
      }),
    );
  });
});
