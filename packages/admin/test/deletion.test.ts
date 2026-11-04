import {
  BLOCKLIST_ENTRY_REMOVED_ACTION,
  createAdminHandler,
  createDeletionTaskHandler,
  DELETION_EXECUTED_ACTION,
  DeletionRequestNotFoundError,
  InMemoryAuditLog,
  runDeletionWorkflow,
  type AdminRequest,
  type DeletionRequestRecord,
  type DeletionWorkflowStarter,
  type StoredListingKey,
} from '@open-estate/admin';
import { InMemoryApiKeyStore, StaticAccessConfigSource } from '@open-estate/core';
import {
  DeletionBlockedError,
  InMemoryDeletionBlocklist,
  InMemoryListingWriter,
} from '@open-estate/ingestion';
import type { Listing } from '@open-estate/shared';
import { createDeletionHarness, type DeletionHarnessOptions } from './support/deletion-harness';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const T0_ISO = new Date(T0).toISOString();
const ADMIN = 'arn:aws:iam::123456789012:user/admin';

// PII values that must never reach audit entries or logs (Req 18.8).
const PII = { name: 'Erika Mustermann', email: 'erika@example.org', phone: '+49 30 1234567' };

/** Key data plus PII content, as a stored listing would carry it. */
function stored(id: string, source: string): StoredListingKey {
  const listing = { id, source, contact: { ...PII }, title: `Wohnung ${id}` };
  return listing;
}

function setup(
  listings: StoredListingKey[] = [],
  options: Omit<DeletionHarnessOptions, 'listings' | 'audit' | 'clock'> & {
    starter?: DeletionWorkflowStarter;
  } = {},
) {
  let now = T0;
  const clock = () => now;
  const audit = new InMemoryAuditLog();
  const backing = new Map(listings.map((listing) => [listing.id, listing]));
  const harness = createDeletionHarness({ ...options, clock, audit, listings: backing });
  let ids = 0;
  const handler = createAdminHandler({
    apiKeys: new InMemoryApiKeyStore(),
    accessConfig: new StaticAccessConfigSource({
      mode: 'open',
      rateLimit: { requests: 60, windowSeconds: 60 },
    }),
    audit,
    clock,
    deletions: {
      ...harness.deletions,
      ...(options.starter !== undefined && { starter: options.starter }),
      newRequestId: () => `req-${++ids}`,
    },
  });
  return { ...harness, handler, backing, advance: (ms: number) => (now += ms) };
}

function request(httpMethod: string, path: string, body?: unknown): AdminRequest {
  return {
    httpMethod,
    path,
    body: body === undefined ? null : JSON.stringify(body),
    requestContext: { identity: { userArn: ADMIN } },
  };
}

const parse = (body: string) => JSON.parse(body) as Record<string, unknown>;

/** Starter that only records; the test runs the workflow explicitly. */
class DeferredStarter implements DeletionWorkflowStarter {
  readonly started: string[] = [];
  async start(requestId: string): Promise<void> {
    this.started.push(requestId);
  }
}

describe('Deletion process', () => {
  describe('POST /admin/deletions', () => {
    it('listing criterion: blocks and removes exactly that listing, then EXECUTED', async () => {
      const { handler, backing, blocklist, requests, starter } = setup([
        stored('L-1', 'partner-a'),
        stored('L-2', 'partner-a'),
      ]);

      const res = await handler(request('POST', '/admin/deletions', { listingId: 'L-1' }));

      expect(res.statusCode).toBe(202);
      expect(parse(res.body)).toEqual({
        requestId: 'req-1',
        criterion: { listingId: 'L-1' },
        status: 'OPEN',
        requestedBy: ADMIN,
        requestedAt: T0_ISO,
        removedCount: 0,
      });
      expect(starter.started).toEqual(['req-1']);
      expect([...backing.keys()]).toEqual(['L-2']);
      expect(blocklist.ids()).toEqual(['L-1']);
      expect(blocklist.get('L-1')).toEqual({
        listingId: 'L-1',
        source: 'partner-a',
        requestId: 'req-1',
        deletedAt: T0_ISO,
      });
      expect(await requests.get('req-1')).toMatchObject({
        status: 'EXECUTED',
        executedAt: T0_ISO,
        removedCount: 1,
      });
    });

    it('source criterion: removes all listings of the source across pages, others stay', async () => {
      const { handler, backing, blocklist, requests } = setup(
        [
          stored('A-1', 'partner-a'),
          stored('A-2', 'partner-a'),
          stored('B-1', 'partner-b'),
          stored('A-3', 'partner-a'),
        ],
        { pageSize: 2 },
      );

      const res = await handler(request('POST', '/admin/deletions', { source: 'partner-a' }));

      expect(res.statusCode).toBe(202);
      expect(parse(res.body)).toMatchObject({ criterion: { source: 'partner-a' }, status: 'OPEN' });
      expect([...backing.keys()]).toEqual(['B-1']);
      expect(blocklist.ids().sort()).toEqual(['A-1', 'A-2', 'A-3']);
      expect(await requests.get('req-1')).toMatchObject({ status: 'EXECUTED', removedCount: 3 });
    });

    it.each([
      [{ listingId: 'L-404' }, 'listingId', 'listingId "L-404"'],
      [{ source: 'unknown-source' }, 'source', 'source "unknown-source"'],
    ])(
      'no match for %p → 404 DELETION_TARGET_NOT_FOUND naming the criterion, nothing changed',
      async (criterion, field, described) => {
        const { handler, backing, blocklist, requests, starter, audit } = setup([
          stored('L-1', 'partner-a'),
        ]);

        const res = await handler(request('POST', '/admin/deletions', criterion));

        expect(res.statusCode).toBe(404);
        expect(parse(res.body)).toEqual({
          errors: [
            {
              code: 'DELETION_TARGET_NOT_FOUND',
              message: `No listing found for ${described}`,
              field,
              details: { criterion },
            },
          ],
        });
        expect([...backing.keys()]).toEqual(['L-1']);
        expect(blocklist.ids()).toEqual([]);
        expect(requests.all()).toEqual([]);
        expect(starter.started).toEqual([]);
        expect(audit.entries).toEqual([]);
      },
    );

    it.each([
      [{}, 'body'],
      [{ listingId: 'L-1', source: 'partner-a' }, 'body'],
      [{ listingId: 'L-1', extra: true }, 'extra'],
      [{ listingId: '' }, 'listingId'],
      [{ source: 'x'.repeat(129) }, 'source'],
      [{ listingId: 42 }, 'listingId'],
    ])('rejects body %p with 400 on %s, nothing changed', async (body, field) => {
      const { handler, backing, requests, starter } = setup([stored('L-1', 'partner-a')]);
      const res = await handler(request('POST', '/admin/deletions', body));
      expect(res.statusCode).toBe(400);
      expect(parse(res.body)).toMatchObject({ errors: [{ code: 'INVALID_PARAMETER', field }] });
      expect([...backing.keys()]).toEqual(['L-1']);
      expect(requests.all()).toEqual([]);
      expect(starter.started).toEqual([]);
    });
  });

  describe('GET /admin/deletions/{requestId}', () => {
    it('reports OPEN until the workflow ran, then EXECUTED with count and times', async () => {
      const starter = new DeferredStarter();
      const { handler, workflow, advance } = setup(
        [stored('L-1', 'partner-a'), stored('L-2', 'partner-b')],
        { starter },
      );
      await handler(request('POST', '/admin/deletions', { listingId: 'L-1' }));
      expect(starter.started).toEqual(['req-1']);

      const open = await handler(request('GET', '/admin/deletions/req-1'));
      expect(open.statusCode).toBe(200);
      expect(parse(open.body)).toMatchObject({ status: 'OPEN', removedCount: 0 });

      advance(60_000);
      await runDeletionWorkflow(workflow, 'req-1');

      const done = await handler(request('GET', '/admin/deletions/req-1'));
      expect(parse(done.body)).toEqual({
        requestId: 'req-1',
        criterion: { listingId: 'L-1' },
        status: 'EXECUTED',
        requestedBy: ADMIN,
        requestedAt: T0_ISO,
        executedAt: new Date(T0 + 60_000).toISOString(),
        removedCount: 1,
      });
    });

    it('unknown request → 404 NOT_FOUND', async () => {
      const { handler } = setup();
      const res = await handler(request('GET', '/admin/deletions/nope'));
      expect(res.statusCode).toBe(404);
      expect(parse(res.body)).toMatchObject({ errors: [{ code: 'NOT_FOUND' }] });
    });
  });

  describe('DELETE /admin/deletion-blocklist/{listingId}', () => {
    it('lifts the block explicitly (also for the import pipeline) and audits it', async () => {
      const pipelineBlocklist = new InMemoryDeletionBlocklist();
      const { handler, blocklist, audit } = setup([stored('L 1/x', 'partner-a')], {
        blocklistMirror: pipelineBlocklist,
      });
      await handler(request('POST', '/admin/deletions', { listingId: 'L 1/x' }));
      expect(await pipelineBlocklist.has('L 1/x')).toBe(true);

      const path = `/admin/deletion-blocklist/${encodeURIComponent('L 1/x')}`;
      const res = await handler(request('DELETE', path));

      expect(res.statusCode).toBe(200);
      expect(parse(res.body)).toEqual({ listingId: 'L 1/x' });
      expect(blocklist.ids()).toEqual([]);
      expect(await pipelineBlocklist.has('L 1/x')).toBe(false);
      expect(audit.entries.at(-1)).toEqual({
        type: 'deletion',
        action: BLOCKLIST_ENTRY_REMOVED_ACTION,
        actor: ADMIN,
        at: T0_ISO,
        details: { listingId: 'L 1/x' },
      });

      const again = await handler(request('DELETE', path));
      expect(again.statusCode).toBe(404);
      expect(parse(again.body)).toMatchObject({ errors: [{ code: 'NOT_FOUND' }] });
    });

    it('rejects a malformed path segment with 400', async () => {
      const { handler } = setup();
      const res = await handler(request('DELETE', '/admin/deletion-blocklist/%E0%A4%A'));
      expect(res.statusCode).toBe(400);
      expect(parse(res.body)).toMatchObject({
        errors: [{ code: 'INVALID_PARAMETER', field: 'listingId' }],
      });
    });
  });

  describe('workflow', () => {
    it('blocks each id before removing it', async () => {
      const { handler, blocklist, listings } = setup([
        stored('A-1', 'partner-a'),
        stored('A-2', 'partner-a'),
      ]);
      const order: string[] = [];
      const block = blocklist.block.bind(blocklist);
      const remove = listings.removeForRequest.bind(listings);
      jest.spyOn(blocklist, 'block').mockImplementation(async (entry) => {
        order.push(`block ${entry.listingId}`);
        await block(entry);
      });
      jest.spyOn(listings, 'removeForRequest').mockImplementation(async (id, requestId) => {
        expect(await blocklist.has(id)).toBe(true);
        order.push(`remove ${id}`);
        return remove(id, requestId);
      });

      await handler(request('POST', '/admin/deletions', { source: 'partner-a' }));

      expect(order).toEqual(['block A-1', 'remove A-1', 'block A-2', 'remove A-2']);
    });

    it('blocked ids cannot be re-imported (shared blocklist with the listing writer)', async () => {
      const pipelineBlocklist = new InMemoryDeletionBlocklist();
      const { handler } = setup([stored('L-1', 'partner-a')], {
        blocklistMirror: pipelineBlocklist,
      });
      await handler(request('POST', '/admin/deletions', { listingId: 'L-1' }));

      const writer = new InMemoryListingWriter(pipelineBlocklist);
      await expect(writer.write({ id: 'L-1' } as Listing)).rejects.toBeInstanceOf(
        DeletionBlockedError,
      );
      expect(writer.size).toBe(0);
    });

    it('writes one audit entry with exactly the required fields and no PII', async () => {
      const log = jest.spyOn(console, 'log');
      const error = jest.spyOn(console, 'error');
      const { handler, audit, advance, workflow } = setup(
        [stored('A-1', 'partner-a'), stored('A-2', 'partner-a')],
        { starter: new DeferredStarter() },
      );
      await handler(request('POST', '/admin/deletions', { source: 'partner-a' }));
      advance(5_000);
      await runDeletionWorkflow(workflow, 'req-1');

      const executedAt = new Date(T0 + 5_000).toISOString();
      expect(audit.entries).toEqual([
        {
          type: 'deletion',
          action: DELETION_EXECUTED_ACTION,
          actor: ADMIN,
          at: executedAt,
          id: 'req-1',
          details: {
            requestId: 'req-1',
            requestedAt: T0_ISO,
            executedAt,
            requestedBy: ADMIN,
            criterion: { source: 'partner-a' },
            removedCount: 2,
          },
        },
      ]);
      const written = JSON.stringify([audit.entries, log.mock.calls, error.mock.calls]);
      for (const value of [...Object.values(PII), 'Wohnung']) {
        expect(written).not.toContain(value);
      }
      log.mockRestore();
      error.mockRestore();
    });

    it('is idempotent: re-running steps neither double-counts nor duplicates the audit', async () => {
      const { handler, workflow, audit, requests, advance } = setup([stored('L-1', 'partner-a')]);
      await handler(request('POST', '/admin/deletions', { listingId: 'L-1' }));
      const first = (await requests.get('req-1')) as DeletionRequestRecord;

      advance(10_000);
      await expect(
        workflow.deleteListing({ requestId: 'req-1', listingId: 'L-1', source: 'partner-a' }),
      ).resolves.toEqual({ removed: false });
      await runDeletionWorkflow(workflow, 'req-1');

      expect(await requests.get('req-1')).toEqual(first);
      expect(audit.entries).toHaveLength(1);
    });

    it('steps fail for an unknown request without touching data', async () => {
      const { workflow, backing, blocklist } = setup([stored('L-1', 'partner-a')]);
      await expect(workflow.resolveTargets({ requestId: 'nope' })).rejects.toBeInstanceOf(
        DeletionRequestNotFoundError,
      );
      await expect(workflow.finalize({ requestId: 'nope' })).rejects.toBeInstanceOf(
        DeletionRequestNotFoundError,
      );
      expect([...backing.keys()]).toEqual(['L-1']);
      expect(blocklist.ids()).toEqual([]);
    });
  });

  describe('Step Functions task handler', () => {
    it('dispatches each step and rejects malformed events', async () => {
      const starter = new DeferredStarter();
      const { handler, workflow, backing } = setup([stored('L-1', 'partner-a')], { starter });
      await handler(request('POST', '/admin/deletions', { listingId: 'L-1' }));
      const task = createDeletionTaskHandler(workflow);

      await expect(task({ step: 'resolveTargets', requestId: 'req-1' })).resolves.toEqual({
        targets: [{ listingId: 'L-1', source: 'partner-a' }],
      });
      await expect(
        task({ step: 'deleteListing', requestId: 'req-1', listingId: 'L-1', source: 'partner-a' }),
      ).resolves.toEqual({ removed: true });
      await expect(task({ step: 'finalize', requestId: 'req-1' })).resolves.toMatchObject({
        status: 'EXECUTED',
        removedCount: 1,
      });
      expect(backing.size).toBe(0);
      await expect(task({ step: 'unknown', requestId: 'req-1' })).rejects.toThrow();
    });
  });
});
