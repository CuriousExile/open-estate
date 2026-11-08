import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  duplicateReportId,
  DynamoDbDuplicateReportStore,
  InMemoryDuplicateReportStore,
  InMemoryTransactor,
  InvalidCursorError,
  reportStateSortKey,
  type DuplicateReport,
} from '@open-estate/core';

// `DuplicateReports` (duplicate-detection design: "Agenturübergreifende Treffer", Req 11).

const report = (
  a: string,
  b: string,
  overrides: Partial<DuplicateReport> = {},
): DuplicateReport => ({
  reportId: duplicateReportId(a, b),
  listingA: a < b ? a : b,
  listingB: a < b ? b : a,
  agencyA: 'agy-a',
  agencyB: 'agy-b',
  score: 0.9,
  reasons: ['SAME_ADDRESS'],
  state: 'OPEN',
  firstSeenAt: '2026-03-01T03:00:00.000Z',
  lastSeenAt: '2026-03-01T03:00:00.000Z',
  lastSweepId: 'sweep-1',
  ...overrides,
});

describe('report ids and sort keys', () => {
  it('names a pair independently of its order', () => {
    expect(duplicateReportId('a', 'b')).toBe(duplicateReportId('b', 'a'));
    expect(duplicateReportId('a', 'b')).toMatch(/^[0-9a-f]{64}$/);
    expect(duplicateReportId('a', 'b')).not.toBe(duplicateReportId('a', 'c'));
    // No ambiguity through concatenation.
    expect(duplicateReportId('ab', 'c')).not.toBe(duplicateReportId('a', 'bc'));
  });

  it('sorts by descending score', () => {
    expect(reportStateSortKey(1, 'x')).toBe('0000#x');
    expect(reportStateSortKey(0.9, 'x')).toBe('0100#x');
    expect(reportStateSortKey(0, 'x')).toBe('1000#x');
    expect(reportStateSortKey(0.95, 'x') < reportStateSortKey(0.7, 'x')).toBe(true);
  });
});

describe('InMemoryDuplicateReportStore', () => {
  const tx = new InMemoryTransactor();

  it('writes by revision: new only once, updates only from the stored revision', async () => {
    const store = new InMemoryDuplicateReportStore();
    const r = report('a', 'b');
    expect((await tx.transact([store.putOp(r, null)])).ok).toBe(true);
    expect((await tx.transact([store.putOp(r, null)])).ok).toBe(false);
    const stored = await store.get(r.reportId);
    expect(stored).toEqual({ ...r, revision: 1 });
    if (stored === null) throw new Error('missing');
    const dismissed = { ...stored, state: 'DISMISSED' as const };
    expect((await tx.transact([store.putOp(dismissed, stored)])).ok).toBe(true);
    // A writer based on revision 1 loses.
    expect((await tx.transact([store.putOp({ ...stored, score: 0.5 }, stored)])).ok).toBe(false);
    expect((await store.get(r.reportId))?.state).toBe('DISMISSED');
    expect((await tx.transact([store.deleteOp(stored)])).ok).toBe(false);
    const current = await store.get(r.reportId);
    if (current === null) throw new Error('missing');
    expect((await tx.transact([store.deleteOp(current)])).ok).toBe(true);
    expect(await store.get(r.reportId)).toBeNull();
  });

  it('lists one state by descending score, filters by agency and pages', async () => {
    const store = new InMemoryDuplicateReportStore();
    const reports = [
      report('a', 'b', { score: 0.8 }),
      report('c', 'd', { score: 0.95, agencyA: 'agy-c' }),
      report('e', 'f', { score: 0.7 }),
      report('g', 'h', { score: 0.99, state: 'DISMISSED' }),
    ];
    await tx.transact(reports.map((r) => store.putOp(r, null)));
    const open = await store.list({ state: 'OPEN' }, { limit: 10 });
    expect(open.items.map((r) => r.score)).toEqual([0.95, 0.8, 0.7]);
    expect(open.nextCursor).toBeUndefined();
    const first = await store.list({ state: 'OPEN' }, { limit: 2 });
    expect(first.items.map((r) => r.score)).toEqual([0.95, 0.8]);
    const second = await store.list(
      { state: 'OPEN' },
      { limit: 2, ...(first.nextCursor !== undefined && { cursor: first.nextCursor }) },
    );
    expect(second.items.map((r) => r.score)).toEqual([0.7]);
    const agency = await store.list({ state: 'OPEN', agencyId: 'agy-c' }, { limit: 10 });
    expect(agency.items.map((r) => r.listingA)).toEqual(['c']);
    await expect(store.list({ state: 'OPEN' }, { limit: 1, cursor: 'x' })).rejects.toBeInstanceOf(
      InvalidCursorError,
    );
  });

  it('rejects malformed reports', () => {
    const store = new InMemoryDuplicateReportStore();
    expect(() => store.putOp({ ...report('a', 'b'), reportId: 'nope' }, null)).toThrow();
    expect(() => store.putOp({ ...report('a', 'b'), score: 2 }, null)).toThrow();
  });
});

describe('DynamoDbDuplicateReportStore', () => {
  const client = () => DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));

  it('builds conditional puts and deletes with the state sort key', () => {
    const store = new DynamoDbDuplicateReportStore({ client: client(), tableName: 'Reports' });
    const r = report('a', 'b');
    expect(store.putOp(r, null).item.Put).toMatchObject({
      TableName: 'Reports',
      Item: { ...r, revision: 1, stateSk: reportStateSortKey(0.9, r.reportId) },
      ConditionExpression: 'attribute_not_exists(#reportId)',
    });
    const stored = { ...r, revision: 3 };
    expect(store.putOp({ ...stored, state: 'RESOLVED' }, stored).item.Put).toMatchObject({
      Item: { state: 'RESOLVED', revision: 4 },
      ConditionExpression: '#revision = :revision',
      ExpressionAttributeValues: { ':revision': 3 },
    });
    expect(store.putOp(r, r).item.Put?.ConditionExpression).toBe(
      'attribute_exists(#reportId) AND attribute_not_exists(#revision)',
    );
    expect(store.deleteOp(stored).item.Delete).toMatchObject({
      Key: { reportId: r.reportId },
      ConditionExpression: '#revision = :revision',
    });
  });

  it('reads strongly consistent and lists by state with an agency filter', async () => {
    const c = client();
    const r = report('a', 'b');
    const item = { ...r, stateSk: reportStateSortKey(r.score, r.reportId), revision: 1 };
    const send = jest
      .spyOn(c, 'send')
      .mockImplementationOnce(async () => ({ Item: item }))
      .mockImplementationOnce(async () => ({ Items: [item, item], LastEvaluatedKey: { x: 1 } }));
    const store = new DynamoDbDuplicateReportStore({ client: c, tableName: 'Reports' });
    expect(await store.get(r.reportId)).toEqual({ ...r, revision: 1 });
    expect((send.mock.calls[0]?.[0] as GetCommand).input.ConsistentRead).toBe(true);
    const page = await store.list({ state: 'OPEN', agencyId: 'agy-a' }, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    expect((send.mock.calls[1]?.[0] as QueryCommand).input).toMatchObject({
      IndexName: 'byState',
      KeyConditionExpression: '#state = :state',
      FilterExpression: '#agencyA = :agency OR #agencyB = :agency',
      ExpressionAttributeValues: { ':state': 'OPEN', ':agency': 'agy-a' },
    });
  });

  it('continues with further reads until a filtered page is full', async () => {
    const c = client();
    const r = report('a', 'b');
    const send = jest
      .spyOn(c, 'send')
      .mockImplementationOnce(async () => ({ Items: [], LastEvaluatedKey: { k: 1 } }))
      .mockImplementationOnce(async () => ({ Items: [{ ...r, stateSk: 'x' }] }));
    const store = new DynamoDbDuplicateReportStore({ client: c, tableName: 'Reports' });
    const page = await store.list({ state: 'OPEN' }, { limit: 5 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeUndefined();
    expect((send.mock.calls[1]?.[0] as QueryCommand).input.ExclusiveStartKey).toEqual({ k: 1 });
  });
});
