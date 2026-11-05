import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  AUDIT_LOG_BY_AGENCY_INDEX,
  DynamoDbAuditService,
  InMemoryAuditService,
  InvalidCursorError,
  auditActorId,
  encodeKeyCursor,
  type AuditAppendEntry,
  type AuditRecord,
} from '@open-estate/core';

const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const user = { kind: 'user' as const, userId: 'u1', displayName: 'Admin' };
const machine = { kind: 'machine' as const, keyId: 'k1', label: 'CI' };

const entry = (overrides: Partial<AuditAppendEntry> = {}): AuditAppendEntry => ({
  category: 'management',
  actor: user,
  channel: 'PORTAL',
  action: 'agency.created',
  target: 'agency/a1',
  agencyId: 'a1',
  result: 'success',
  ...overrides,
});

/** Clock advancing one minute per call and sequential ids. */
function deterministic() {
  let tick = 0;
  let id = 0;
  return {
    now: () => T0 + 60_000 * tick++,
    newId: () => `id${String(id++).padStart(3, '0')}`,
  };
}

async function collectAll(
  service: InMemoryAuditService,
  filter: Parameters<InMemoryAuditService['query']>[0],
  limit: number,
): Promise<AuditRecord[]> {
  const all: AuditRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await service.query(filter, { limit, ...(cursor !== undefined && { cursor }) });
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return all;
}

describe('auditActorId', () => {
  it('maps every actor kind to its id', () => {
    expect(auditActorId(user)).toBe('u1');
    expect(auditActorId(machine)).toBe('k1');
    expect(auditActorId({ kind: 'connector', connectorId: 'c1', runId: 'r1' })).toBe('c1');
    expect(auditActorId({ kind: 'iam', userArn: 'arn:aws:iam::1:user/x' })).toBe(
      'arn:aws:iam::1:user/x',
    );
  });
});

describe('InMemoryAuditService', () => {
  it('appends entries with id and timestamp and offers no update or delete', async () => {
    const audit = new InMemoryAuditService(deterministic());
    const record = await audit.append(entry());
    expect(record).toEqual({ ...entry(), id: 'id000', timestamp: '2026-03-01T10:00:00.000Z' });
    expect(audit.entries).toEqual([record]);
    expect(Object.getOwnPropertyNames(InMemoryAuditService.prototype).sort()).toEqual(
      ['append', 'constructor', 'entries', 'query'].sort(),
    );
  });

  it('records access-denied entries without actor', async () => {
    const audit = new InMemoryAuditService(deterministic());
    const denied = {
      category: 'access-denied' as const,
      action: 'GET /listings',
      target: 'listing/l1',
      result: 'UNAUTHENTICATED',
    };
    await expect(audit.append(denied)).resolves.toMatchObject(denied);
  });

  it('rejects unknown keys (no free-form details), unknown categories and empty targets', async () => {
    const audit = new InMemoryAuditService();
    await expect(
      audit.append({ ...entry(), details: { email: 'x@example.com' } } as AuditAppendEntry),
    ).rejects.toThrow();
    await expect(
      audit.append(entry({ category: 'deletion' as AuditAppendEntry['category'] })),
    ).rejects.toThrow();
    await expect(audit.append(entry({ target: '' }))).rejects.toThrow();
    expect(audit.entries).toEqual([]);
  });

  it('returns entries newest first and each exactly once across pages', async () => {
    const audit = new InMemoryAuditService(deterministic());
    for (let i = 0; i < 7; i++) {
      await audit.append(entry({ category: i % 2 === 0 ? 'management' : 'access-denied' }));
    }
    const all = await collectAll(audit, {}, 3);
    expect(all.map((r) => r.id)).toEqual([
      'id006',
      'id005',
      'id004',
      'id003',
      'id002',
      'id001',
      'id000',
    ]);
    const first = await audit.query({}, { limit: 7 });
    expect(first.nextCursor).toBeUndefined();
  });

  it('filters by actor, agency, action and inclusive period', async () => {
    const audit = new InMemoryAuditService(deterministic());
    await audit.append(entry()); // 10:00
    await audit.append(entry({ actor: machine, channel: 'API', action: 'listing.update' })); // 10:01
    await audit.append(entry({ agencyId: 'a2', target: 'agency/a2' })); // 10:02
    await audit.append(entry({ agencyId: undefined, action: 'access-mode.changed' })); // 10:03

    const ids = async (filter: Parameters<InMemoryAuditService['query']>[0]) =>
      (await collectAll(audit, filter, 2)).map((r) => r.id);

    expect(await ids({ actor: 'k1' })).toEqual(['id001']);
    expect(await ids({ actor: 'u1' })).toEqual(['id003', 'id002', 'id000']);
    expect(await ids({ agencyId: 'a1' })).toEqual(['id001', 'id000']);
    expect(await ids({ action: 'agency.created' })).toEqual(['id002', 'id000']);
    expect(
      await ids({ from: '2026-03-01T10:01:00.000Z', to: '2026-03-01T11:02:00+01:00' }),
    ).toEqual(['id002', 'id001']);
    expect(await ids({ agencyId: 'a1', actor: 'u1', from: '2026-03-01T10:00:00Z' })).toEqual([
      'id000',
    ]);
    expect(await ids({ from: '2026-03-01T10:03:00Z', to: '2026-03-01T10:00:00Z' })).toEqual([]);
  });

  it('rejects foreign cursors', async () => {
    const audit = new InMemoryAuditService();
    await expect(audit.query({}, { limit: 1, cursor: 'not-json' })).rejects.toThrow(
      InvalidCursorError,
    );
    await expect(
      audit.query(
        {},
        { limit: 1, cursor: encodeKeyCursor({ category: 'deletion', timestampId: 'x' }) },
      ),
    ).rejects.toThrow(InvalidCursorError);
  });
});

const documentClient = () =>
  DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));

const stored = (record: AuditRecord) => ({
  ...record,
  category: record.category,
  timestampId: `${record.timestamp}#${record.id}`,
});

describe('DynamoDbAuditService', () => {
  it('writes one PutItem with keys, GSI key and actor id', async () => {
    const client = documentClient();
    const send = jest.spyOn(client, 'send').mockImplementation(async () => ({}));
    const audit = new DynamoDbAuditService({ client, tableName: 'AuditLog', ...deterministic() });
    const record = await audit.append(entry());
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as PutCommand;
    expect(command).toBeInstanceOf(PutCommand);
    expect(command.input).toEqual({
      TableName: 'AuditLog',
      Item: {
        ...record,
        category: 'management',
        timestampId: '2026-03-01T10:00:00.000Z#id000',
        actorId: 'u1',
      },
    });
    expect(command.input).not.toHaveProperty('ConditionExpression');
  });

  it('queries the GSI byAgency descending with period in the key condition and filters', async () => {
    const client = documentClient();
    const send = jest.spyOn(client, 'send').mockImplementation(async () => ({ Items: [] }));
    const audit = new DynamoDbAuditService({ client, tableName: 'AuditLog' });
    const cursor = encodeKeyCursor({
      category: 'management',
      timestampId: '2026-03-01T10:05:00.000Z#x',
    });
    await audit.query(
      {
        agencyId: 'a1',
        actor: 'u1',
        action: 'agency.created',
        from: '2026-03-01T10:00:00Z',
        to: '2026-03-01T12:00:00+01:00',
      },
      { limit: 2, cursor },
    );
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as QueryCommand;
    expect(command).toBeInstanceOf(QueryCommand);
    expect(command.input).toEqual({
      TableName: 'AuditLog',
      IndexName: AUDIT_LOG_BY_AGENCY_INDEX,
      KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :lower AND :upper',
      FilterExpression: '#actorId = :actor AND #action = :action',
      ExpressionAttributeNames: {
        '#pk': 'agencyId',
        '#sk': 'timestampId',
        '#actorId': 'actorId',
        '#action': 'action',
      },
      ExpressionAttributeValues: {
        ':pk': 'a1',
        ':lower': '2026-03-01T10:00:00.000Z#',
        ':upper': '2026-03-01T11:00:00.000Z#\uffff',
        ':actor': 'u1',
        ':action': 'agency.created',
      },
      ScanIndexForward: false,
      Limit: 3,
      ExclusiveStartKey: {
        agencyId: 'a1',
        category: 'management',
        timestampId: '2026-03-01T10:05:00.000Z#x',
      },
    });
  });

  it('merges both categories newest first and continues filtered partitions', async () => {
    const mk = (category: AuditRecord['category'], minute: number, id: string): AuditRecord => ({
      id,
      timestamp: new Date(T0 + minute * 60_000).toISOString(),
      category,
      action: 'a',
      target: 't',
      result: 'success',
    });
    const management = [mk('management', 5, 'm5'), mk('management', 2, 'm2')];
    const denied = [mk('access-denied', 4, 'd4'), mk('access-denied', 1, 'd1')];
    const client = documentClient();
    const send = jest.spyOn(client, 'send').mockImplementation(async (command) => {
      const input = (command as QueryCommand).input;
      const partition = input.ExpressionAttributeValues?.[':pk'];
      if (partition === 'management') return { Items: management.map(stored) };
      // access-denied: first page filtered away completely, then a continuation.
      return input.ExclusiveStartKey === undefined
        ? { Items: [], LastEvaluatedKey: { category: 'access-denied', timestampId: 'z' } }
        : { Items: denied.map(stored) };
    });
    const audit = new DynamoDbAuditService({ client, tableName: 'AuditLog' });
    const page = await audit.query({ action: 'a' }, { limit: 3 });
    expect(page.items.map((r) => r.id)).toEqual(['m5', 'd4', 'm2']);
    expect(page.nextCursor).toBe(
      encodeKeyCursor({ category: 'management', timestampId: '2026-03-01T10:02:00.000Z#m2' }),
    );
    // management once, access-denied twice (filtered page + continuation)
    expect(send).toHaveBeenCalledTimes(3);
    const pks = send.mock.calls.map(
      ([command]) => (command as QueryCommand).input.ExpressionAttributeValues?.[':pk'],
    );
    expect(pks.sort()).toEqual(['access-denied', 'access-denied', 'management']);
  });

  it('continues each category from the cursor position', async () => {
    const client = documentClient();
    const send = jest.spyOn(client, 'send').mockImplementation(async () => ({ Items: [] }));
    const audit = new DynamoDbAuditService({ client, tableName: 'AuditLog' });
    const cursor = encodeKeyCursor({ category: 'access-denied', timestampId: 'T#x' });
    await expect(audit.query({}, { limit: 5, cursor })).resolves.toEqual({ items: [] });
    const starts = send.mock.calls.map(([command]) => (command as QueryCommand).input);
    expect(starts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          KeyConditionExpression: '#pk = :pk',
          ExclusiveStartKey: { category: 'management', timestampId: 'T#x' },
        }),
        expect.objectContaining({
          ExclusiveStartKey: { category: 'access-denied', timestampId: 'T#x' },
        }),
      ]),
    );
    expect(
      starts.every(
        (input) => input.IndexName === undefined && input.FilterExpression === undefined,
      ),
    ).toBe(true);
  });

  it('throws for malformed items and skips queries for an empty period', async () => {
    const client = documentClient();
    const send = jest
      .spyOn(client, 'send')
      .mockImplementation(async () => ({ Items: [{ category: 'management', id: 'x' }] }));
    const audit = new DynamoDbAuditService({ client, tableName: 'AuditLog' });
    await expect(audit.query({ agencyId: 'a1' }, { limit: 1 })).rejects.toThrow();
    send.mockClear();
    await expect(
      audit.query({ from: '2026-03-02T00:00:00Z', to: '2026-03-01T00:00:00Z' }, { limit: 1 }),
    ).resolves.toEqual({ items: [] });
    expect(send).not.toHaveBeenCalled();
  });
});
