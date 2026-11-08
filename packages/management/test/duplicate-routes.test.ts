import { ListingQueryService, VersionService } from '@open-estate/core';
import {
  createListingRoutes,
  createRouter,
  replyStatus,
  toProxyResult,
  type Reply,
} from '@open-estate/management';
import type { Principal } from '@open-estate/shared';
import {
  duplicatePlatform,
  member,
  ORIGIN,
} from '../../core/test/duplicates/support/duplicate-harness';

// Routes of the Duplikat-Erkennung (duplicate-detection Req 7.5, 8.2, 9.2–9.5, 14.1).

const content = (overrides: Record<string, unknown> = {}) => ({
  originalLocale: 'de',
  title: 'Helle Altbauwohnung mit Balkon',
  description: 'Drei Zimmer, Blick in den Hof.',
  translations: [],
  offers: [{ offerType: 'SALE', price: '350000.00', currency: 'EUR' }],
  listingType: 'apartment_unit',
  rooms: 3,
  area: '85.50',
  address: { city: 'Berlin', postalCode: '10115', country: 'DE', street: 'Hauptstraße 12' },
  media: [],
  tours: [],
  ...overrides,
});

function setup() {
  const platform = duplicatePlatform();
  const router = createRouter(
    createListingRoutes({
      queries: new ListingQueryService({
        listings: platform.listings,
        keys: platform.keys,
        audit: platform.audit,
        frontendOrigin: ORIGIN,
      }),
      versions: new VersionService({
        listings: platform.listings,
        versions: platform.versions,
        snapshots: platform.snapshots,
        audit: platform.audit,
      }),
      commands: async () => platform.commands,
    }),
  );

  async function call(
    principal: Principal,
    method: string,
    path: string,
    opts: { query?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: unknown; reply: Reply }> {
    const found = router.match(method, path);
    if (found === undefined) throw new Error(`no route ${method} ${path}`);
    const reply = await found.route.run(
      {
        params: found.params,
        query: opts.query ?? {},
        body: opts.body === undefined ? '' : JSON.stringify(opts.body),
        signal: new AbortController().signal,
        ...(opts.headers !== undefined && { headers: opts.headers }),
      },
      principal,
    );
    const body = reply.kind === 'success' ? reply.body : { errors: reply.errors };
    return { status: replyStatus(reply), body, reply };
  }
  return { platform, call };
}

const agent = member('agy-a');

describe('POST /listings with Idempotency-Key (Req 9.2-9.5)', () => {
  it('answers a repetition with the same listing and marks it replayed', async () => {
    const s = setup();
    const request = { body: { content: content() }, headers: { 'idempotency-key': 'crm-1' } };
    const first = await s.call(agent, 'POST', '/listings', request);
    const again = await s.call(agent, 'POST', '/listings', request);

    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect((again.body as { id: string }).id).toBe((first.body as { id: string }).id);
    expect(toProxyResult(first.reply).headers).not.toHaveProperty('Idempotent-Replayed');
    expect(toProxyResult(again.reply).headers).toMatchObject({
      'Idempotent-Replayed': 'true',
      'Cache-Control': 'no-store',
    });
  });

  it('refuses another body with the same key (409) and a malformed key (400)', async () => {
    const s = setup();
    await s.call(agent, 'POST', '/listings', {
      body: { content: content() },
      headers: { 'Idempotency-Key': 'crm-1' },
    });
    const reused = await s.call(agent, 'POST', '/listings', {
      body: { content: content({ rooms: 4 }) },
      headers: { 'Idempotency-Key': 'crm-1' },
    });
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ errors: [{ code: 'IDEMPOTENCY_KEY_REUSED' }] });

    const malformed = await s.call(agent, 'POST', '/listings', {
      body: { content: content() },
      headers: { 'Idempotency-Key': 'two words' },
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({
      errors: [{ code: 'INVALID_PARAMETER', field: 'Idempotency-Key' }],
    });
  });
});

describe('Markierungen over the API (Req 5.3, 7.5, 8.2)', () => {
  it('creates a duplicate INACTIVE, filters by flag and dismisses the flag', async () => {
    const s = setup();
    const first = await s.call(agent, 'POST', '/listings', {
      body: { content: content(), status: 'ACTIVE' },
    });
    const second = await s.call(agent, 'POST', '/listings', {
      body: { content: content(), status: 'ACTIVE' },
    });
    const firstId = (first.body as { id: string }).id;
    const secondId = (second.body as { id: string }).id;
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({
      status: 'INACTIVE',
      flags: [{ code: 'DUPLICATE', originalId: firstId }],
    });

    const flagged = await s.call(agent, 'GET', '/listings', { query: { flag: 'DUPLICATE' } });
    expect((flagged.body as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([
      secondId,
    ]);

    const dismissed = await s.call(agent, 'DELETE', `/listings/${secondId}/flags/DUPLICATE`);
    expect(dismissed.status).toBe(200);
    expect(dismissed.body).toMatchObject({ id: secondId, status: 'INACTIVE', flags: [] });
  });

  it('rejects an unknown Markierungscode in the path', async () => {
    const s = setup();
    const res = await s.call(agent, 'DELETE', '/listings/l1/flags/SPAM');
    expect(res.status).toBe(400);
  });
});
