import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  DynamoDbTransactor,
  InMemoryTransactor,
  type DynamoDbOp,
  type InMemoryOp,
} from '@open-estate/core';

const documentClient = () =>
  DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));

function canceled(codes: string[]): Error {
  return Object.assign(new Error('canceled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

describe('InMemoryTransactor', () => {
  const state = new Map<string, number>();
  const op = (label: string, target: string, holds: boolean): InMemoryOp => ({
    label,
    target,
    check: () => holds,
    apply: () => void state.set(target, (state.get(target) ?? 0) + 1),
  });

  beforeEach(() => state.clear());

  it('applies all operations when every condition holds', async () => {
    const result = await new InMemoryTransactor().transact([
      op('a', 'T#1', true),
      op('b', 'T#2', true),
    ]);
    expect(result).toEqual({ ok: true, value: undefined });
    expect([...state.entries()]).toEqual([
      ['T#1', 1],
      ['T#2', 1],
    ]);
  });

  it('applies nothing and names every failed condition', async () => {
    const result = await new InMemoryTransactor().transact([
      op('a', 'T#1', false),
      op('b', 'T#2', true),
      op('c', 'T#3', false),
    ]);
    expect(result).toEqual({ ok: false, error: { failed: ['a', 'c'] } });
    expect(state.size).toBe(0);
  });

  it('checks all conditions before the first write', async () => {
    let written = false;
    const write: InMemoryOp = {
      label: 'w',
      target: 'T#1',
      check: () => true,
      apply: () => void (written = true),
    };
    const read: InMemoryOp = {
      label: 'r',
      target: 'T#2',
      check: () => !written,
      apply: () => undefined,
    };
    expect((await new InMemoryTransactor().transact([write, read])).ok).toBe(true);
  });

  it('rejects two operations on the same item like DynamoDB', async () => {
    await expect(
      new InMemoryTransactor().transact([op('a', 'T#1', true), op('b', 'T#1', true)]),
    ).rejects.toThrow('T#1');
    expect(state.size).toBe(0);
  });
});

describe('DynamoDbTransactor', () => {
  const ops: DynamoDbOp[] = [
    {
      label: 'first',
      item: { ConditionCheck: { TableName: 'a', Key: { id: '1' }, ConditionExpression: 'x' } },
    },
    { label: 'second', item: { Delete: { TableName: 'b', Key: { id: '2' } } } },
  ];

  it('sends one TransactWriteItems with the items in order', async () => {
    const client = documentClient();
    const send = jest.spyOn(client, 'send').mockImplementation(async () => ({}));
    await expect(new DynamoDbTransactor({ client }).transact(ops)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect((command as TransactWriteCommand).input).toEqual({
      TransactItems: ops.map((op) => op.item),
    });
  });

  it('sends nothing for an empty transaction', async () => {
    const client = documentClient();
    const send = jest.spyOn(client, 'send');
    await expect(new DynamoDbTransactor({ client }).transact([])).resolves.toMatchObject({
      ok: true,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('maps ConditionalCheckFailed reasons to the labels at their positions', async () => {
    const client = documentClient();
    jest.spyOn(client, 'send').mockImplementation(async () => {
      throw canceled(['None', 'ConditionalCheckFailed']);
    });
    await expect(new DynamoDbTransactor({ client }).transact(ops)).resolves.toEqual({
      ok: false,
      error: { failed: ['second'] },
    });
  });

  it('rethrows cancellations without failed condition and other errors', async () => {
    const client = documentClient();
    const send = jest.spyOn(client, 'send');
    send.mockImplementationOnce(async () => {
      throw canceled(['TransactionConflict', 'None']);
    });
    await expect(new DynamoDbTransactor({ client }).transact(ops)).rejects.toThrow('canceled');
    send.mockImplementationOnce(async () => {
      throw new Error('throttled');
    });
    await expect(new DynamoDbTransactor({ client }).transact(ops)).rejects.toThrow('throttled');
  });

  it('rejects more than 100 operations before sending', async () => {
    const client = documentClient();
    const send = jest.spyOn(client, 'send');
    const many = Array.from({ length: 101 }, () => ops[1] as DynamoDbOp);
    await expect(new DynamoDbTransactor({ client }).transact(many)).rejects.toThrow('100');
    expect(send).not.toHaveBeenCalled();
  });
});
