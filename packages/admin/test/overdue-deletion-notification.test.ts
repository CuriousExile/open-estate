// Req 18.10 end to end with a simulated clock: request via the Admin-API, workflow start fails,
// hourly overdue check notifies once after 24 h, nothing more once the request is EXECUTED.
import {
  createAdminHandler,
  createOverdueDeletionCheck,
  InMemoryAuditLog,
  InMemoryOverdueDeletionNotifier,
  runDeletionWorkflow,
  type AdminRequest,
  type DeletionWorkflowStarter,
  type StoredListingKey,
} from '@open-estate/admin';
import { InMemoryApiKeyStore, StaticAccessConfigSource } from '@open-estate/core';
import { createDeletionHarness } from './support/deletion-harness';

/** **Validates: Requirements 18.10** */

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const ADMIN = 'arn:aws:iam::123456789012:user/alice';

/** Step Functions unavailable: `start` always fails. */
class FailingStarter implements DeletionWorkflowStarter {
  readonly attempts: string[] = [];
  async start(requestId: string): Promise<void> {
    this.attempts.push(requestId);
    throw Object.assign(new Error('StartExecution failed'), { name: 'ServiceUnavailable' });
  }
}

function setup() {
  let now = T0;
  const clock = () => now;
  const audit = new InMemoryAuditLog();
  const listings = new Map<string, StoredListingKey>(
    ['A-1', 'A-2', 'A-3'].map((id) => [id, { id, source: 'partner-a' }]),
  );
  listings.set('B-1', { id: 'B-1', source: 'partner-b' });
  const harness = createDeletionHarness({ clock, audit, listings });
  const starter = new FailingStarter();
  const handler = createAdminHandler({
    apiKeys: new InMemoryApiKeyStore(),
    accessConfig: new StaticAccessConfigSource({
      mode: 'open',
      rateLimit: { requests: 60, windowSeconds: 60 },
    }),
    audit,
    clock,
    deletions: { ...harness.deletions, starter, newRequestId: () => 'req-1' },
  });
  const notifier = new InMemoryOverdueDeletionNotifier();
  const check = createOverdueDeletionCheck({
    requests: harness.requests,
    listings: harness.listings,
    notifier,
    clock,
  });
  return {
    ...harness,
    handler,
    starter,
    check,
    sent: notifier.sent,
    backing: listings,
    at: (offsetMs: number) => (now = T0 + offsetMs),
  };
}

const request = (httpMethod: string, path: string, body?: unknown): AdminRequest => ({
  httpMethod,
  path,
  body: body === undefined ? null : JSON.stringify(body),
  requestContext: { identity: { userArn: ADMIN } },
});

describe('Overdue deletion notification (Req 18.10, simulated clock)', () => {
  // The failed workflow start is logged by the admin handler.
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('notifies once after strictly more than 24 h OPEN and stops once EXECUTED', async () => {
    const { handler, starter, check, sent, requests, workflow, backing, at } = setup();

    // Workflow start fails: 503, the request is stored and stays OPEN.
    const created = await handler(request('POST', '/admin/deletions', { source: 'partner-a' }));
    expect(created.statusCode).toBe(503);
    expect(JSON.parse(created.body)).toEqual({
      errors: [{ code: 'SERVICE_UNAVAILABLE', message: expect.any(String) }],
    });
    expect(starter.attempts).toEqual(['req-1']);
    await expect(requests.get('req-1')).resolves.toMatchObject({
      status: 'OPEN',
      requestedBy: ADMIN,
      requestedAt: new Date(T0).toISOString(),
      removedCount: 0,
    });

    // Hourly runs during the first 24 h, the last ones close to and exactly at the limit.
    const notYetOverdue = [
      ...Array.from({ length: 23 }, (_, i) => (i + 1) * HOUR),
      24 * HOUR - MINUTE,
      24 * HOUR - 1,
      24 * HOUR,
    ];
    for (const offset of notYetOverdue) {
      at(offset);
      await expect(check()).resolves.toEqual({ checked: 0, notified: 0, skipped: 0, failed: 0 });
    }
    expect(sent).toEqual([]);

    // First run after the limit: one notice with remaining count and routing ARN.
    at(24 * HOUR + 1);
    await expect(check()).resolves.toEqual({ checked: 1, notified: 1, skipped: 0, failed: 0 });
    expect(sent).toEqual([
      {
        requestId: 'req-1',
        criterion: { source: 'partner-a' },
        requestedAt: new Date(T0).toISOString(),
        remainingCount: 3,
        adminArn: ADMIN,
      },
    ]);
    await expect(requests.get('req-1')).resolves.toMatchObject({
      status: 'OPEN',
      notifiedAt: new Date(T0 + 24 * HOUR + 1).toISOString(),
    });

    // Later hourly runs: still OPEN and overdue, but no repeated notice.
    for (const offset of [25 * HOUR, 26 * HOUR]) {
      at(offset);
      await expect(check()).resolves.toEqual({ checked: 1, notified: 0, skipped: 1, failed: 0 });
    }
    expect(sent).toHaveLength(1);

    // Workflow finally runs (e.g. restarted by an operator): EXECUTED, no further notices.
    at(26 * HOUR + 30 * MINUTE);
    await expect(runDeletionWorkflow(workflow, 'req-1')).resolves.toMatchObject({
      status: 'EXECUTED',
      removedCount: 3,
    });
    expect([...backing.keys()]).toEqual(['B-1']);
    const status = await handler(request('GET', '/admin/deletions/req-1'));
    expect(JSON.parse(status.body)).toMatchObject({ status: 'EXECUTED', removedCount: 3 });

    for (const offset of [27 * HOUR, 28 * HOUR, 48 * HOUR]) {
      at(offset);
      await expect(check()).resolves.toEqual({ checked: 0, notified: 0, skipped: 0, failed: 0 });
    }
    expect(sent).toHaveLength(1);
  });

  it('does not notify a request whose workflow completes within 24 h', async () => {
    const { handler, check, sent, workflow, at } = setup();
    await handler(request('POST', '/admin/deletions', { listingId: 'B-1' }));
    at(23 * HOUR);
    await runDeletionWorkflow(workflow, 'req-1');

    for (const offset of [24 * HOUR, 24 * HOUR + 1, 25 * HOUR]) {
      at(offset);
      await expect(check()).resolves.toMatchObject({ checked: 0, notified: 0 });
    }
    expect(sent).toEqual([]);
  });
});
