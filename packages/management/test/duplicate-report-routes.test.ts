import { ListExecutionsCommand, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import {
  CROSS_AGENCY_OPEN_COUNTER,
  PLATFORM_SCOPE,
  type DuplicateReportService,
} from '@open-estate/core';
import {
  createDuplicateRoutes,
  createRouter,
  replyStatus,
  StepFunctionsDuplicateSweepStarter,
  type Reply,
} from '@open-estate/management';
import type { Principal } from '@open-estate/shared';
import {
  duplicatePlatform,
  machine,
  member,
  platformAdmin,
} from '../../core/test/duplicates/support/duplicate-harness';

// `/platform/duplicate-reports*`, `/platform/duplicate-sweeps` and `/platform/duplicate-detection`
// (duplicate-detection Req 10.2, 11.3–11.5; design: "Ein- und Ausschalten").

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

function setup(
  service?: (p: ReturnType<typeof duplicatePlatform>) => DuplicateReportService<unknown>,
) {
  const platform = duplicatePlatform();
  const router = createRouter(
    createDuplicateRoutes({
      service: () =>
        (service?.(platform) ?? platform.reportService) as DuplicateReportService<unknown>,
    }),
  );
  async function call(
    principal: Principal,
    method: string,
    path: string,
    query: Record<string, string> = {},
    requestBody?: unknown,
  ): Promise<{ status: number; body: unknown; reply: Reply }> {
    const found = router.match(method, path);
    if (found === undefined) throw new Error(`no route ${method} ${path}`);
    const reply = await found.route.run(
      {
        params: found.params,
        query,
        body: requestBody === undefined ? '' : JSON.stringify(requestBody),
        signal: new AbortController().signal,
      },
      principal,
    );
    const body = reply.kind === 'success' ? reply.body : { errors: reply.errors };
    return { status: replyStatus(reply), body, reply };
  }
  return { platform, call };
}

/** Two agencies offering the same property, one pair of a different property, one sweep. */
async function withReports(platform: ReturnType<typeof duplicatePlatform>) {
  const other = content({
    title: 'Reihenhaus am Stadtrand',
    listingType: 'terraced',
    rooms: 5,
    area: '140.00',
    address: { city: 'Hamburg', postalCode: '22111', country: 'DE', street: 'Lindenweg 3' },
  });
  for (const [agency, body] of [
    ['agy-a', content()],
    ['agy-b', content()],
    ['agy-a', other],
    ['agy-b', other],
  ] as const) {
    const created = await platform.commands.create(member(agency), { content: body });
    if (!created.ok) throw new Error('create failed');
  }
  await platform.sweep();
}

type Page = { items: { reportId: string; state: string; score: number }[]; nextPageToken?: string };

describe('GET /platform/duplicate-reports (Req 11.3)', () => {
  it('lists open Treffer by descending score, pages and filters by agency', async () => {
    const { platform, call } = setup();
    await withReports(platform);

    const all = await call(platformAdmin, 'GET', '/platform/duplicate-reports');
    expect(all.status).toBe(200);
    const page = all.body as Page;
    expect(page.items).toHaveLength(2);
    expect(page.items.every((r) => r.state === 'OPEN')).toBe(true);
    expect(page.items[0]?.score).toBeGreaterThanOrEqual(page.items[1]?.score ?? 0);
    expect(page.items[0]).not.toHaveProperty('lastSweepId');
    expect(page.items[0]).not.toHaveProperty('revision');

    const first = await call(platformAdmin, 'GET', '/platform/duplicate-reports', {
      pageSize: '1',
    });
    const token = (first.body as Page).nextPageToken;
    expect(token).toBeDefined();
    const second = await call(platformAdmin, 'GET', '/platform/duplicate-reports', {
      pageSize: '1',
      pageToken: token ?? '',
    });
    expect([...(first.body as Page).items, ...(second.body as Page).items]).toEqual(page.items);

    const none = await call(platformAdmin, 'GET', '/platform/duplicate-reports', {
      agencyId: 'agy-x',
    });
    expect((none.body as Page).items).toEqual([]);
    const dismissedNone = await call(platformAdmin, 'GET', '/platform/duplicate-reports', {
      state: 'DISMISSED',
    });
    expect((dismissedNone.body as Page).items).toEqual([]);
    const bad = await call(platformAdmin, 'GET', '/platform/duplicate-reports', {
      pageToken: 'nope',
    });
    expect(bad.status).toBe(400);
  });
});

describe('POST /platform/duplicate-reports/{reportId}/dismiss (Req 11.5)', () => {
  it('dismisses once, audits, keeps the counter and is idempotent', async () => {
    const { platform, call } = setup();
    await withReports(platform);
    const [report] = platform.reports.all();
    const id = report?.reportId ?? '';
    expect(await platform.counters.get(PLATFORM_SCOPE, CROSS_AGENCY_OPEN_COUNTER)).toBe(2);

    const dismissed = await call(
      platformAdmin,
      'POST',
      `/platform/duplicate-reports/${id}/dismiss`,
    );
    expect(dismissed.status).toBe(200);
    expect(dismissed.body).toMatchObject({ reportId: id, state: 'DISMISSED' });
    expect(await platform.counters.get(PLATFORM_SCOPE, CROSS_AGENCY_OPEN_COUNTER)).toBe(1);
    expect(platform.audit.entries.at(-1)).toMatchObject({
      action: 'duplicate-report.dismiss',
      target: `duplicate-report/${id}`,
      result: 'SUCCESS',
    });
    const entries = platform.audit.entries.length;
    const again = await call(platformAdmin, 'POST', `/platform/duplicate-reports/${id}/dismiss`);
    expect(again.status).toBe(200);
    expect(platform.audit.entries).toHaveLength(entries);
    expect(await platform.counters.get(PLATFORM_SCOPE, CROSS_AGENCY_OPEN_COUNTER)).toBe(1);

    const unknown = await call(
      platformAdmin,
      'POST',
      `/platform/duplicate-reports/${'0'.repeat(64)}/dismiss`,
    );
    expect(unknown.status).toBe(404);
    const malformed = await call(platformAdmin, 'POST', '/platform/duplicate-reports/x/dismiss');
    expect(malformed.status).toBe(404);
  });
});

describe('Isolation of the Treffer (Req 11.4)', () => {
  it.each([
    ['an agency member', member('agy-a')],
    ['an agency admin', { ...member('agy-a'), role: 'AGENCY_ADMIN' } as Principal],
    ['a machine access', machine('agy-a')],
  ])('rejects %s with 403 without data or change', async (_, principal) => {
    const { platform, call } = setup();
    await withReports(platform);
    const before = platform.reports.all();
    const id = before[0]?.reportId ?? '';
    for (const [method, path] of [
      ['GET', '/platform/duplicate-reports'],
      ['POST', `/platform/duplicate-reports/${id}/dismiss`],
      ['POST', '/platform/duplicate-reports/x/dismiss'],
    ] as const) {
      const result = await call(principal, method, path);
      expect(result.status).toBe(403);
      expect(JSON.stringify(result.body)).not.toContain(id);
    }
    expect(platform.reports.all()).toEqual(before);
  });
});

describe('POST /platform/duplicate-sweeps (Req 10.2)', () => {
  it('starts a run for platform:operate, 403 otherwise', async () => {
    const { call } = setup();
    const started = await call(platformAdmin, 'POST', '/platform/duplicate-sweeps');
    expect(started.status).toBe(202);
    expect(started.body).toEqual({ executionName: 'manual-1', alreadyRunning: false });
    expect((await call(member('agy-a'), 'POST', '/platform/duplicate-sweeps')).status).toBe(403);
  });

  it('returns the running execution instead of starting a second one', async () => {
    const client = new SFNClient({ region: 'eu-central-1' });
    const send = jest
      .spyOn(client, 'send')
      .mockImplementationOnce(async () => ({ executions: [{ name: 'scheduled-1' }] }))
      .mockImplementationOnce(async () => ({ executions: [] }))
      .mockImplementationOnce(async () => ({}));
    const starter = new StepFunctionsDuplicateSweepStarter({
      client,
      stateMachineArn: 'arn:aws:states:eu-central-1:1:stateMachine:DuplicateSweep',
      clock: () => Date.parse('2026-03-01T03:00:00.000Z'),
    });
    expect(await starter.start()).toEqual({
      executionName: 'scheduled-1',
      alreadyRunning: true,
    });
    expect(await starter.start()).toEqual({
      executionName: 'manual-20260301T030000-000Z',
      alreadyRunning: false,
    });
    const list = send.mock.calls[0]?.[0] as ListExecutionsCommand;
    expect(list.input).toEqual({
      stateMachineArn: 'arn:aws:states:eu-central-1:1:stateMachine:DuplicateSweep',
      statusFilter: 'RUNNING',
      maxResults: 1,
    });
    const start = send.mock.calls[2]?.[0] as StartExecutionCommand;
    expect(start.input).toMatchObject({ name: 'manual-20260301T030000-000Z', input: '{}' });
  });
});

describe('/platform/duplicate-detection (design: "Ein- und Ausschalten")', () => {
  const PATH = '/platform/duplicate-detection';

  it('reads and switches the detection for platform:operate', async () => {
    const { platform, call } = setup();
    expect(await call(platformAdmin, 'GET', PATH)).toMatchObject({
      status: 200,
      body: { enabled: true },
    });

    const off = await call(platformAdmin, 'PUT', PATH, {}, { enabled: false });
    expect(off).toMatchObject({ status: 200, body: { enabled: false } });
    expect(await platform.detection.load()).toBe(false);
    // Switched off, a manual run is refused.
    const sweep = await call(platformAdmin, 'POST', '/platform/duplicate-sweeps');
    expect(sweep.status).toBe(409);
    expect(sweep.body).toMatchObject({ errors: [{ code: 'DUPLICATE_DETECTION_DISABLED' }] });

    const on = await call(platformAdmin, 'PUT', PATH, {}, { enabled: true });
    expect(on).toMatchObject({
      status: 200,
      body: { enabled: true, sweep: { executionName: 'manual-1', alreadyRunning: false } },
    });
  });

  it('answers 403 to everyone else and 400 to an invalid body', async () => {
    const { platform, call } = setup();
    for (const principal of [member('agy-a'), machine('agy-a')]) {
      expect((await call(principal, 'GET', PATH)).status).toBe(403);
      expect((await call(principal, 'PUT', PATH, {}, { enabled: false })).status).toBe(403);
    }
    const invalid = await call(platformAdmin, 'PUT', PATH, {}, { enabled: 'no' });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      errors: [{ code: 'INVALID_PARAMETER', field: 'enabled' }],
    });
    expect((await call(platformAdmin, 'PUT', PATH)).status).toBe(400);
    expect(await platform.detection.load()).toBe(true);
  });
});
