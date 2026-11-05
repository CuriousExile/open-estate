import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  ConfigError,
  contentRules,
  InMemoryAgencyStore,
  InMemoryAuditService,
  InMemoryDeletionBlocklistCheck,
  InMemoryListingKeyStore,
  InMemoryListingVersionStore,
  InMemoryManagedListingStore,
  InMemoryMetricCounterStore,
  InMemorySnapshotStore,
  InMemoryTransactor,
  ListingCommandService,
  ListingQueryService,
  manualContentSchema,
  VersionedListingWriter,
  VersionService,
  type AgencyRecord,
} from '@open-estate/core';
import { createRouter, replyStatus, type Reply } from '@open-estate/management';
import type { Principal, Taxonomy } from '@open-estate/shared';
import {
  createListingRouteGroup,
  createListingRoutes,
  LISTING_ROUTES_ENV,
} from '../src/routes/listings';

const ORIGIN = 'https://estate.example';
const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const TAXONOMY: Taxonomy = { groups: [{ code: 'residential', types: ['apartment_unit'] }] };

const member: Principal = {
  kind: 'user',
  userId: 'u1',
  displayName: 'Ada',
  role: 'AGENCY_MEMBER',
  agencyId: 'a1',
};
const otherMember: Principal = { ...member, userId: 'u2', agencyId: 'a2' };
const admin: Principal = {
  kind: 'user',
  userId: 'pa',
  displayName: 'Root',
  role: 'PLATFORM_ADMIN',
};

const agency = (agencyId: string): AgencyRecord => ({
  agencyId,
  displayName: agencyId,
  state: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00.000Z',
  agencyAdmins: 1,
});

const content = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  originalLocale: 'de',
  title: 'Altbau',
  description: '',
  translations: [],
  offers: [{ offerType: 'SALE', price: '250000.00', currency: 'EUR' }],
  listingType: 'apartment_unit',
  rooms: 3,
  area: '75.5',
  address: { city: 'Berlin', postalCode: '10115', country: 'DE' },
  media: [],
  tours: [],
  ...overrides,
});

function setup() {
  let ids = 0;
  const stores = {
    listings: new InMemoryManagedListingStore(),
    versions: new InMemoryListingVersionStore(),
    keys: new InMemoryListingKeyStore(),
    blocklist: new InMemoryDeletionBlocklistCheck(),
    counters: new InMemoryMetricCounterStore(),
    snapshots: new InMemorySnapshotStore(),
  };
  const writer = new VersionedListingWriter({
    ...stores,
    transactor: new InMemoryTransactor(),
    clock: () => T0,
  });
  const audit = new InMemoryAuditService();
  const commands = new ListingCommandService({
    listings: stores.listings,
    versions: stores.versions,
    snapshots: stores.snapshots,
    agencies: new InMemoryAgencyStore([agency('a1'), agency('a2')]),
    writer,
    audit,
    frontendOrigin: ORIGIN,
    contentSchema: manualContentSchema(TAXONOMY),
    rules: contentRules({ tourProviders: { providers: [] } }),
    newId: () => `l${++ids}`,
  });
  const router = createRouter(
    createListingRoutes({
      queries: new ListingQueryService({ ...stores, audit, frontendOrigin: ORIGIN }),
      versions: new VersionService({ ...stores, audit }),
      commands: async () => commands,
    }),
  );

  async function call(
    principal: Principal,
    method: string,
    path: string,
    opts: { query?: Record<string, string>; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<{ status: number; body: unknown; reply: Reply }> {
    const [pathname] = path.split('?');
    const found = router.match(method, pathname ?? path);
    if (found === undefined) throw new Error(`no route ${method} ${path}`);
    const reply = await found.route.run(
      {
        params: found.params,
        query: opts.query ?? {},
        body: opts.body === undefined ? '' : JSON.stringify(opts.body),
        signal: opts.signal ?? new AbortController().signal,
      },
      principal,
    );
    const body = reply.kind === 'success' ? reply.body : { errors: reply.errors };
    return { status: replyStatus(reply), body, reply };
  }

  return { call, audit, stores };
}

const create = async (s: ReturnType<typeof setup>, body: Record<string, unknown> = {}) => {
  const res = await s.call(member, 'POST', '/listings', { body: { content: content(), ...body } });
  expect(res.status).toBe(201);
  return res.body as { id: string; version: number };
};

describe('listing routes', () => {
  it('creates a listing (201) and reads it by id and by Custom_Id', async () => {
    const s = setup();
    const created = await create(s, { customId: 'crm-1' });
    expect(created).toMatchObject({ id: 'l1', version: 1, status: 'INACTIVE', origin: 'MANUAL' });

    const byId = await s.call(member, 'GET', '/listings/l1');
    expect(byId).toMatchObject({ status: 200, body: { id: 'l1', sourceUrlDerived: true } });
    const byCustomId = await s.call(member, 'GET', '/listings/by-custom-id/crm-1');
    expect(byCustomId).toMatchObject({ status: 200, body: { id: 'l1', customId: 'crm-1' } });
  });

  it('hides listings of other agencies as 404 (Req 2.6)', async () => {
    const s = setup();
    await create(s, { customId: 'crm-1' });
    expect((await s.call(otherMember, 'GET', '/listings/l1')).status).toBe(404);
    expect((await s.call(otherMember, 'GET', '/listings/by-custom-id/crm-1')).status).toBe(404);
    expect(
      (await s.call(otherMember, 'PUT', '/listings/l1/status', { body: { status: 'ACTIVE' } }))
        .status,
    ).toBe(404);
    expect((await s.call(member, 'GET', '/listings', { query: { agencyId: 'a2' } })).status).toBe(
      404,
    );
  });

  it('lists with filters and pageToken; Plattform_Admins pass agencyId (Req 4.14, 10.4)', async () => {
    const s = setup();
    await create(s);
    await create(s, { content: content({ title: 'Penthouse' }), status: 'ACTIVE' });
    await create(s);

    const active = await s.call(member, 'GET', '/listings', { query: { status: 'ACTIVE' } });
    expect(active).toMatchObject({
      status: 200,
      body: { items: [{ id: 'l2', title: 'Penthouse' }] },
    });
    const byTitle = await s.call(member, 'GET', '/listings', { query: { q: 'pent' } });
    expect((byTitle.body as { items: unknown[] }).items).toHaveLength(1);

    const first = await s.call(admin, 'GET', '/listings', {
      query: { agencyId: 'a1', pageSize: '2' },
    });
    const page1 = first.body as { items: { id: string }[]; nextPageToken?: string };
    expect(page1.items).toHaveLength(2);
    expect(page1.nextPageToken).toEqual(expect.any(String));
    const second = await s.call(admin, 'GET', '/listings', {
      query: { agencyId: 'a1', pageSize: '2', pageToken: page1.nextPageToken ?? '' },
    });
    const page2 = second.body as { items: { id: string }[]; nextPageToken?: string };
    expect(page2.nextPageToken).toBeUndefined();
    expect([...page1.items, ...page2.items].map((i) => i.id).sort()).toEqual(['l1', 'l2', 'l3']);

    expect(await s.call(admin, 'GET', '/listings', { query: { pageToken: '!!' } })).toMatchObject({
      status: 400,
      body: { errors: [{ code: 'INVALID_PAGE_TOKEN', field: 'pageToken' }] },
    });
    expect((await s.call(admin, 'GET', '/listings', { query: { pageSize: '51' } })).status).toBe(
      400,
    );
  });

  it('creates in the agency named by a Plattform_Admin, channel ADMIN', async () => {
    const s = setup();
    const res = await s.call(admin, 'POST', '/listings', {
      body: { content: content(), agencyId: 'a2' },
    });
    expect(res).toMatchObject({ status: 201, body: { agencyId: 'a2', source: 'agency:a2' } });
    expect(res.body).toMatchObject({ fieldSources: { title: { channel: 'ADMIN' } } });
  });

  it('replaces content with optimistic concurrency (Req 4.6, 4.8)', async () => {
    const s = setup();
    await create(s);
    const stale = await s.call(member, 'PUT', '/listings/l1', {
      body: { content: content({ title: 'Neu' }), baseVersion: 2 },
    });
    expect(stale).toMatchObject({
      status: 409,
      body: { errors: [{ code: 'VERSION_CONFLICT', details: { currentVersion: 1 } }] },
    });
    const ok = await s.call(member, 'PUT', '/listings/l1', {
      body: { content: content({ title: 'Neu' }), baseVersion: 1 },
    });
    expect(ok).toMatchObject({ status: 200, body: { version: 2, content: { title: 'Neu' } } });

    const invalid = await s.call(member, 'PUT', '/listings/l1', {
      body: { content: content({ rooms: -1 }), baseVersion: 2 },
    });
    expect(invalid.status).toBe(400);
  });

  it('changes status and agency; agency assignment needs listing:assign (Req 6.2, 10.6)', async () => {
    const s = setup();
    await create(s);
    const status = await s.call(member, 'PUT', '/listings/l1/status', {
      body: { status: 'ACTIVE' },
    });
    expect(status).toMatchObject({ status: 200, body: { status: 'ACTIVE', version: 2 } });

    const forbidden = await s.call(member, 'PUT', '/listings/l1/agency', {
      body: { agencyId: 'a2', baseVersion: 2 },
    });
    expect(forbidden).toMatchObject({ status: 403, body: { errors: [{ code: 'FORBIDDEN' }] } });
    const moved = await s.call(admin, 'PUT', '/listings/l1/agency', {
      body: { agencyId: 'a2', baseVersion: 2 },
    });
    expect(moved).toMatchObject({ status: 200, body: { agencyId: 'a2', version: 3 } });
  });

  it('serves history, version detail, diff and restore (Req 7.5, 7.6, 8.1)', async () => {
    const s = setup();
    await create(s);
    await s.call(member, 'PUT', '/listings/l1', {
      body: { content: content({ title: 'Neu' }), baseVersion: 1 },
    });

    const history = await s.call(member, 'GET', '/listings/l1/versions', {
      query: { pageSize: '1' },
    });
    const page = history.body as { items: { version: number }[]; nextPageToken?: string };
    expect(page.items.map((v) => v.version)).toEqual([2]);
    expect(page.nextPageToken).toEqual(expect.any(String));

    const v1 = await s.call(member, 'GET', '/listings/l1/versions/1');
    expect(v1).toMatchObject({ status: 200, body: { version: 1, content: { title: 'Altbau' } } });
    expect((await s.call(member, 'GET', '/listings/l1/versions/9')).status).toBe(404);
    expect(await s.call(member, 'GET', '/listings/l1/versions/x')).toMatchObject({
      status: 400,
      body: { errors: [{ field: 'n' }] },
    });

    const diff = await s.call(member, 'GET', '/listings/l1/diff', {
      query: { from: '1', to: '2' },
    });
    expect(diff).toMatchObject({
      status: 200,
      body: {
        from: 1,
        to: 2,
        entries: [{ op: 'change', path: ['content', 'title'], oldValue: 'Altbau', value: 'Neu' }],
      },
    });
    expect(
      (await s.call(member, 'GET', '/listings/l1/diff', { query: { from: '1' } })).status,
    ).toBe(400);

    const stale = await s.call(member, 'POST', '/listings/l1/restore', {
      body: { version: 1, baseVersion: 1 },
    });
    expect(stale).toMatchObject({ status: 409, body: { errors: [{ code: 'VERSION_CONFLICT' }] } });
    const restored = await s.call(member, 'POST', '/listings/l1/restore', {
      body: { version: 1, baseVersion: 2 },
    });
    expect(restored).toMatchObject({
      status: 200,
      body: { version: 3, content: { title: 'Altbau' } },
    });
  });

  it('starts no write after the request deadline', async () => {
    const s = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      s.call(member, 'POST', '/listings', {
        body: { content: content() },
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted');
    expect(await s.stores.listings.get('l1')).toBeNull();
  });
});

describe('listing route group wiring', () => {
  const ENV: Record<string, string> = {
    [LISTING_ROUTES_ENV.listingsTable]: 'Listings',
    [LISTING_ROUTES_ENV.listingVersionsTable]: 'ListingVersions',
    [LISTING_ROUTES_ENV.listingKeysTable]: 'ListingKeys',
    [LISTING_ROUTES_ENV.metricCountersTable]: 'MetricCounters',
    [LISTING_ROUTES_ENV.deletionBlocklistTable]: 'DeletionBlocklist',
    [LISTING_ROUTES_ENV.agenciesTable]: 'Agencies',
    [LISTING_ROUTES_ENV.snapshotBucket]: 'version-snapshots',
    [LISTING_ROUTES_ENV.configBucket]: 'config-bucket',
  };
  const REGION = 'eu-central-1';

  function context(env: Record<string, string | undefined>) {
    return {
      env,
      clients: {
        dynamo: DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION })),
        ssm: new SSMClient({ region: REGION }),
      },
      shared: { frontendOrigin: ORIGIN, audit: new InMemoryAuditService(), clock: () => T0 },
    };
  }

  afterEach(() => jest.restoreAllMocks());

  it('names every missing variable at init', () => {
    const group = createListingRouteGroup({ s3: new S3Client({ region: REGION }) });
    let error: unknown;
    try {
      group.create(context({ ...ENV, SNAPSHOT_BUCKET_NAME: ' ', CONFIG_BUCKET: undefined }));
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({ names: ['SNAPSHOT_BUCKET_NAME', 'CONFIG_BUCKET'] });
  });

  it('loads the content rules at init and retries a failed load on the next write', async () => {
    const s3 = new S3Client({ region: REGION });
    const files: Record<string, string> = {};
    const reads = jest.spyOn(s3, 'send').mockImplementation(async (command: unknown) => {
      if (!(command instanceof GetObjectCommand)) throw new Error('unexpected command');
      const body = files[command.input.Key ?? ''];
      if (body === undefined) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return { Body: { transformToString: async () => body } };
    });
    const routes = createListingRouteGroup({ s3 }).create(context(ENV));
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /listings',
      'POST /listings',
      'GET /listings/by-custom-id/{customId}',
      'GET /listings/{id}',
      'PUT /listings/{id}',
      'PUT /listings/{id}/status',
      'PUT /listings/{id}/agency',
      'GET /listings/{id}/versions',
      'GET /listings/{id}/versions/{n}',
      'GET /listings/{id}/diff',
      'POST /listings/{id}/restore',
    ]);
    const restore = routes.find((r) => r.path === '/listings/{id}/restore');
    const input = {
      params: { id: 'l1' },
      query: {},
      body: '{}',
      signal: new AbortController().signal,
    };

    // taxonomy.json missing: the write fails (→ 503 in the handler), nothing is cached.
    await expect(restore?.run(input, member)).rejects.toBeInstanceOf(ConfigError);
    const loadsAfterFailure = reads.mock.calls.length;
    expect(loadsAfterFailure).toBeGreaterThanOrEqual(3);
    await expect(restore?.run(input, member)).rejects.toBeInstanceOf(ConfigError);
    expect(reads.mock.calls.length).toBeGreaterThan(loadsAfterFailure);
    const keys = reads.mock.calls.map(([c]) => (c as GetObjectCommand).input.Key);
    expect(new Set(keys)).toEqual(
      new Set(['taxonomy.json', 'tour-providers.json', 'pii-allowlist.json']),
    );
  });
});
