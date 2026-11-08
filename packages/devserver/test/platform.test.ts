import {
  DemoClock,
  loadContentConfig,
  readDuplicateDetection,
  readNetworkConfig,
} from '../src/config';
import { toProxyEvent, type RawHttpRequest } from '../src/http/proxy-event';
import { s256Challenge } from '../src/oidc/pkce';
import { createDevPlatform, type DevPlatform } from '../src/platform';
import { demoFeedModule } from '../src/seed/demo-connector';
import { AGENCIES, SEED_USERS, USERS } from '../src/seed/demo-data';
import { CRM_BATCHES, seedDemo, type SeedSummary } from '../src/seed/seed';
import { SEARCH_RESOURCES } from '../src/server';

// One in-memory platform seeded like `npm run dev`: Search_API, MCP_Server and Management_API
// share state, and the Management_API accepts tokens of the local OIDC provider.

const ISSUER = 'http://127.0.0.1:4310/oidc';
const CLIENT = 'local-portal-client';
const FRONTEND = 'http://127.0.0.1:4200';
const VERIFIER = 'v'.repeat(43);

let platform: DevPlatform;
let seeded: SeedSummary;

beforeAll(async () => {
  platform = createDevPlatform({
    config: loadContentConfig(),
    clock: new DemoClock(),
    frontendOrigin: FRONTEND,
    issuer: ISSUER,
    clientId: CLIENT,
    directoryUsers: SEED_USERS,
    connectorModules: [demoFeedModule(CRM_BATCHES)],
    logger: { error: () => undefined },
  });
  seeded = await seedDemo(platform);
});

const request = (method: string, url: string, init: Partial<RawHttpRequest> = {}) =>
  toProxyEvent(
    { method, url, headers: {}, body: Buffer.alloc(0), ...init },
    url.startsWith('/api')
      ? { stripPrefix: '/api', resources: SEARCH_RESOURCES }
      : url.startsWith('/management')
        ? { stripPrefix: '/management' }
        : {},
  );

async function search(query = ''): Promise<{ items: { id: string; title: string }[] }> {
  const res = await platform.handlers.search(request('GET', `/api/listings?pageSize=50${query}`));
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as { items: { id: string; title: string }[] };
}

/** Code + PKCE login at the local provider; returns the access token. */
async function login(userId: string): Promise<string> {
  const form = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT,
    redirect_uri: `${FRONTEND}/portal`,
    scope: 'openid email profile',
    code_challenge: s256Challenge(VERIFIER),
    code_challenge_method: 'S256',
    user_id: userId,
  });
  const authorized = await platform.oidc.handle({
    method: 'POST',
    path: '/authorize',
    query: new URLSearchParams(),
    form,
  });
  const code = new URL(authorized.headers['Location'] ?? '').searchParams.get('code') ?? '';
  const token = await platform.oidc.handle({
    method: 'POST',
    path: '/token',
    query: new URLSearchParams(),
    form: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT,
      code,
      redirect_uri: `${FRONTEND}/portal`,
      code_verifier: VERIFIER,
    }),
  });
  return (JSON.parse(token.body) as { access_token: string }).access_token;
}

async function management(method: string, path: string, bearer: string, body?: unknown) {
  const res = await platform.handlers.management(
    request(method, `/management${path}`, {
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: Buffer.from(body === undefined ? '' : JSON.stringify(body)),
    }),
  );
  return {
    status: res.statusCode,
    body: res.body === '' ? undefined : (JSON.parse(res.body) as Record<string, unknown>),
  };
}

describe('local demo platform', () => {
  it('seeds listings, runs and history and publishes only visible listings', async () => {
    const all = platform.stores.listings.all();
    expect(all.length).toBeGreaterThanOrEqual(10);
    expect(seeded.runs.map((run) => run.status)).toEqual([
      'SUCCESS',
      'SUCCESS',
      'FAILURE',
      'SUCCESS',
    ]);
    expect(seeded.runs.reduce((sum, run) => sum + run.rejected, 0)).toBeGreaterThan(0);

    const visible = all.filter(
      (item) => item.status === 'ACTIVE' && item.agencyId !== AGENCIES.alpenblick.agencyId,
    );
    const { items } = await search();
    expect(items.map((item) => item.id).sort()).toEqual(visible.map((item) => item.id).sort());

    const imported = all.find((item) => item.customId === 'CRM-4711');
    expect(imported?.origin).toBe('IMPORT');
    const sources = Object.values(imported?.fieldSources ?? {}).map((source) => source.channel);
    expect(new Set(sources)).toEqual(new Set(['IMPORT', 'PORTAL']));
  });

  it('serves /locations of the public listings, incl. the Thai demo listings', async () => {
    const res = await platform.handlers.search(request('GET', '/api/locations'));
    expect(res.statusCode).toBe(200);
    const doc = JSON.parse(res.body) as {
      countries: { code: string; count: number }[];
      cities: { name: string; country: string; count: number }[];
    };
    const { items } = await search();
    expect(doc.countries.reduce((sum, c) => sum + c.count, 0)).toBe(items.length);
    expect(doc.countries.map((c) => c.code)).toEqual(expect.arrayContaining(['DE', 'TH']));
    expect(doc.cities).toEqual(
      expect.arrayContaining([
        { name: 'Bangkok', country: 'TH', count: 1 },
        { name: 'Pattaya', country: 'TH', count: 1 },
      ]),
    );
    const thai = await search('&country=TH');
    expect(thai.items).toHaveLength(2);
    expect(thai.items.every((item) => item.title.startsWith('[DEMO]'))).toBe(true);
  });

  it('prices the Thai demo listings in THB and converts price filters with the demo rates', async () => {
    const thai = (await search('&country=TH')) as unknown as {
      items: { offers: { currency: string }[] }[];
    };
    const currencies = thai.items.flatMap((item) => item.offers.map((offer) => offer.currency));
    expect(new Set(currencies)).toEqual(new Set(['THB']));

    const meta = await platform.handlers.search(request('GET', '/api/meta'));
    const rates = (JSON.parse(meta.body) as { exchangeRates?: { base: string; rates: object } })
      .exchangeRates;
    expect(rates?.base).toBe('EUR');
    expect(Object.keys(rates?.rates ?? {})).toEqual(
      expect.arrayContaining(['THB', 'USD', 'GBP', 'CHF']),
    );

    // Pattaya: 4,200,000 THB ≈ 110,800 EUR. Without conversion an EUR filter never matches it.
    const strict = await search('&country=TH&offerType=SALE&priceMax=200000');
    expect(strict.items).toHaveLength(0);
    const converted = await search(
      '&country=TH&offerType=SALE&priceMax=200000&currency=EUR&convertCurrency=true',
    );
    expect(converted.items).toHaveLength(1);
  });

  it('serves the OpenAPI document of the Management_API publicly', async () => {
    const res = await platform.handlers.management(request('GET', '/management/openapi.json'));
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { openapi: string }).openapi).toMatch(/^3\./);
  });

  it('accepts tokens of the local provider; a suspended agency gets 403', async () => {
    const me = await management('GET', '/me', await login(USERS.agencyAdmin.userId));
    expect(me).toMatchObject({
      status: 200,
      body: { role: 'AGENCY_ADMIN', agencyId: AGENCIES.nordlicht.agencyId },
    });
    const suspended = await management('GET', '/me', await login(USERS.suspendedAdmin.userId));
    expect(suspended.status).toBe(403);
    expect(JSON.stringify(suspended.body)).toContain('AGENCY_SUSPENDED');
    expect((await management('GET', '/me', 'not-a-token')).status).toBe(401);
  });

  it('accepts the seeded machine access credential', async () => {
    const me = await management('GET', '/me', seeded.machineCredential);
    expect(me).toMatchObject({ status: 200, body: { kind: 'machine' } });
  });

  it('makes a listing created and activated in the portal searchable (also via MCP)', async () => {
    const bearer = await login(USERS.agencyMember.userId);
    const created = await management('POST', '/listings', bearer, {
      content: {
        originalLocale: 'de',
        title: 'Testwohnung am Stadtpark',
        description: 'Angelegt im Test.',
        translations: [],
        offers: [{ offerType: 'RENT', coldRent: '999.00', currency: 'EUR' }],
        listingType: 'apartment_unit',
        rooms: 2,
        area: '50',
        address: { city: 'Hamburg', postalCode: '22303', country: 'DE' },
        media: [],
        tours: [],
      },
    });
    expect(created.status).toBe(201);
    const id = String(created.body?.['id']);
    expect((await search('&city=Hamburg')).items.map((item) => item.id)).not.toContain(id);

    const activated = await management('PUT', `/listings/${id}/status`, bearer, {
      status: 'ACTIVE',
    });
    expect(activated.status).toBe(200);
    expect((await search('&city=Hamburg')).items.map((item) => item.id)).toContain(id);

    const mcp = await platform.handlers.mcp(
      request('POST', '/mcp', {
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: Buffer.from(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'get_listing', arguments: { id } },
          }),
        ),
      }),
    );
    expect(mcp.statusCode).toBe(200);
    expect(mcp.body).toContain('Testwohnung am Stadtpark');
  });

  it('runs a platform deletion in-process and removes the listing everywhere', async () => {
    const bearer = await login(USERS.platformAdmin.userId);
    const target = (await search('&city=Kiel')).items[0];
    expect(target).toBeDefined();
    const preview = await management('POST', '/platform/deletions?dryRun=true', bearer, {
      listingId: target?.id,
    });
    expect(preview.status).toBe(200);
    const requested = await management('POST', '/platform/deletions', bearer, {
      listingId: target?.id,
    });
    expect(requested.status).toBe(202);
    expect((await search('&city=Kiel')).items).toEqual([]);
    expect(await platform.stores.listings.get(target?.id ?? '')).toBeNull();
  });

  it('seeds the duplicate demo and runs the Duplikat_Abgleich in-process (duplicate-detection)', async () => {
    const admin = await login(USERS.platformAdmin.userId);
    const member = await login(USERS.agencyMember.userId);
    // The repost of Berlin-Mitte is stored inactive with a Markierung; the neighbour flat is not.
    const repost = await management(
      'GET',
      `/listings/${seeded.listingIds['berlin-mitte-repost']}`,
      member,
    );
    expect(repost.body).toMatchObject({
      status: 'INACTIVE',
      flags: [{ code: 'DUPLICATE', originalId: seeded.listingIds['berlin-mitte'] }],
    });
    const neighbour = await management(
      'GET',
      `/listings/${seeded.listingIds['berlin-mitte-neighbour']}`,
      member,
    );
    expect(neighbour.body).toMatchObject({ status: 'ACTIVE', flags: [] });
    // The seeding's Abgleich found the same flat at Alpenblick.
    const reports = await management('GET', '/platform/duplicate-reports', admin);
    expect(reports.status).toBe(200);
    const pairs = (reports.body?.['items'] as { listingA: string; listingB: string }[]).map((r) =>
      [r.listingA, r.listingB].sort().join('|'),
    );
    expect(pairs).toContain(
      [seeded.listingIds['berlin-mitte'], seeded.listingIds['berlin-mitte-alpenblick']]
        .sort()
        .join('|'),
    );
    expect((await management('GET', '/platform/duplicate-reports', member)).status).toBe(403);

    // A manual start (Req 10.2), only for platform:operate.
    expect((await management('POST', '/platform/duplicate-sweeps', member)).status).toBe(403);
    const starts = () =>
      platform.stores.audit.entries.filter((e) => e.action === 'duplicate-sweep.start').length;
    const before = starts();
    const started = await management('POST', '/platform/duplicate-sweeps', admin);
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ alreadyRunning: false });
    expect(String(started.body?.['executionName'])).toMatch(/^manual-/);
    await platform.services.sweepIdle();
    expect(starts()).toBe(before + 1);
  });

  it('switches the duplicate detection off and on from the admin mode', async () => {
    const admin = await login(USERS.platformAdmin.userId);
    const member = await login(USERS.agencyMember.userId);
    const path = '/platform/duplicate-detection';
    expect(await management('GET', path, admin)).toMatchObject({
      status: 200,
      body: { enabled: true },
    });
    expect((await management('PUT', path, member, { enabled: false })).status).toBe(403);
    expect(await management('PUT', path, admin, { enabled: false })).toMatchObject({
      status: 200,
      body: { enabled: false },
    });

    // Switched off: the same flat again is stored as requested, without a Markierung.
    const original = await management(
      'GET',
      `/listings/${seeded.listingIds['berlin-mitte']}`,
      member,
    );
    // Same content without the original's derived source URL (each listing gets its own).
    const content = { ...(original.body?.['content'] as Record<string, unknown>) };
    delete content['sourceUrl'];
    const created = await management('POST', '/listings', member, {
      content,
      status: 'ACTIVE',
    });
    expect(created).toMatchObject({ status: 201, body: { status: 'ACTIVE', flags: [] } });
    expect((await management('POST', '/platform/duplicate-sweeps', admin)).status).toBe(409);

    // Switched on again: the in-process Abgleich flags it (without taking it offline).
    const on = await management('PUT', path, admin, { enabled: true });
    expect(on).toMatchObject({
      status: 200,
      body: { enabled: true, sweep: { alreadyRunning: false } },
    });
    await platform.services.sweepIdle();
    const flagged = await management('GET', `/listings/${String(created.body?.['id'])}`, member);
    expect(flagged.body).toMatchObject({ status: 'ACTIVE', flags: [{ code: 'DUPLICATE' }] });
  });

  it('reads the start value of the duplicate detection from DEV_DUPLICATE_DETECTION', () => {
    expect(readDuplicateDetection({})).toBe(true);
    expect(readDuplicateDetection({ DEV_DUPLICATE_DETECTION: 'disabled' })).toBe(false);
    expect(() => readDuplicateDetection({ DEV_DUPLICATE_DETECTION: 'off' })).toThrow(/enabled/);
  });

  it('only binds to loopback addresses', () => {
    expect(() => readNetworkConfig({ DEV_HOST: '0.0.0.0' })).toThrow(/loopback/);
    expect(readNetworkConfig({})).toMatchObject({ host: '127.0.0.1', port: 4310 });
  });
});
