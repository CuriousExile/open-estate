import {
  createAdminOperations,
  InMemoryAdminAuditLog,
  InMemoryApiKeyStore,
  StaticAccessConfigSource,
  type AdminActor,
  type DeletionRequestRecord,
} from '@open-estate/core';

const NOW = Date.parse('2025-01-01T00:00:00.000Z');
const user: AdminActor = { kind: 'user', userId: 'user-1', displayName: 'Platform Admin' };
const iam: AdminActor = { kind: 'iam', userArn: 'arn:aws:iam::123456789012:user/admin' };

function setup() {
  const audit = new InMemoryAdminAuditLog();
  const accessConfig = new StaticAccessConfigSource({
    mode: 'open',
    rateLimit: { requests: 60, windowSeconds: 60 },
  });
  const requests = new Map<string, DeletionRequestRecord>();
  const blocked = new Set(['L-1']);
  const started: string[] = [];
  const ops = createAdminOperations({
    apiKeys: new InMemoryApiKeyStore(),
    accessConfig,
    audit,
    clock: () => NOW,
    generateKey: () => ({ keyId: 'key-1', apiKey: 'secret' }),
    deletions: {
      requests: {
        create: async (record) => void requests.set(record.requestId, record),
        get: async (id) => requests.get(id) ?? null,
        markExecuted: async () => null,
        listOpenRequestedBefore: async () => ({ requestIds: [] }),
        markNotified: async () => false,
      },
      listings: {
        find: async (listingId) => (listingId === 'L-1' ? { listingId, source: 's' } : null),
        listBySource: async () => ({ targets: [] }),
        removeForRequest: async () => false,
      },
      blocklist: { block: async () => undefined, unblock: async (id) => blocked.delete(id) },
      starter: { start: async (id) => void started.push(id) },
      newRequestId: () => 'req-1',
    },
  });
  return { ops, audit, accessConfig, started };
}

describe('AdminOperations', () => {
  it('records the user id of a Plattform_Admin as actor and requester', async () => {
    const { ops, audit, started } = setup();

    expect(await ops.setAccessMode(user, { mode: 'api-keys' })).toEqual({
      ok: true,
      value: { mode: 'api-keys' },
    });
    const deletion = await ops.requestDeletion(user, { listingId: 'L-1' });
    expect(deletion.ok && deletion.value.requestedBy).toBe('user-1');
    expect(started).toEqual(['req-1']);
    expect(await ops.removeBlocklistEntry(user, 'L-1')).toEqual({
      ok: true,
      value: { listingId: 'L-1' },
    });

    expect(audit.entries.map((e) => [e.type, e.action, e.actor])).toEqual([
      ['access-config', 'access-mode.set', 'user-1'],
      ['deletion', 'deletion-blocklist.entry-removed', 'user-1'],
    ]);
  });

  it('records the IAM userArn and never the plain key on API key creation', async () => {
    const { ops, audit } = setup();

    const created = await ops.createApiKey(iam, {});
    expect(created).toEqual({
      ok: true,
      value: { keyId: 'key-1', status: 'active', apiKey: 'secret' },
    });
    expect(audit.entries).toEqual([
      {
        type: 'access-config',
        action: 'api-key.created',
        actor: iam.userArn,
        at: new Date(NOW).toISOString(),
        details: { keyId: 'key-1', status: 'active' },
      },
    ]);
  });

  it('rejects invalid input with the catalog code and writes nothing', async () => {
    const { ops, audit, accessConfig } = setup();

    const result = await ops.setRateLimit(user, { requests: 0, windowSeconds: 60 });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_PARAMETER',
        errors: [{ code: 'INVALID_RATE_LIMIT', field: 'requests' }],
      },
    });
    expect(await ops.requestDeletion(user, { listingId: 'L-404' })).toMatchObject({ ok: false });
    expect(await ops.revokeApiKey(user, 'missing')).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(audit.entries).toEqual([]);
    expect((await accessConfig.load()).rateLimit).toEqual({ requests: 60, windowSeconds: 60 });
  });

  it('maps an unknown deletion target to DELETION_TARGET_NOT_FOUND', async () => {
    const { ops } = setup();

    expect(await ops.requestDeletion(iam, { source: 'none' })).toMatchObject({
      ok: false,
      error: { code: 'DELETION_TARGET_NOT_FOUND', errors: [{ field: 'source' }] },
    });
  });
});
