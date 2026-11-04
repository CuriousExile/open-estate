import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toListingItem } from '@open-estate/core';
import type { Listing } from '@open-estate/shared';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { resolveEnvironment } from '../src/config';
import { DataStack } from '../src/data-stack';
import { seedListings } from '../scripts/seed-data';
import {
  BATCH_SIZE,
  dataStackName,
  LISTINGS_TABLE_OUTPUT,
  resolveTableName,
  writeListings,
} from '../scripts/seed-writer';

const TABLE = 'test-listings';
type WriteRequest = { PutRequest?: { Item?: Record<string, unknown> } };

/** Document client with stubbed `send`; `unprocessed(call)` returns the requests to hand back. */
function stubDocumentClient(
  unprocessed: (call: number, requests: WriteRequest[]) => WriteRequest[],
) {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
  let call = 0;
  const send = jest.spyOn(client, 'send').mockImplementation(async (command: unknown) => {
    if (!(command instanceof BatchWriteCommand)) throw new Error('unexpected command');
    const requests = (command.input.RequestItems?.[TABLE] ?? []) as WriteRequest[];
    const rest = unprocessed(call++, requests);
    return rest.length > 0 ? { UnprocessedItems: { [TABLE]: rest } } : { UnprocessedItems: {} };
  });
  const batches = () =>
    send.mock.calls.map(([cmd]) => (cmd as BatchWriteCommand).input.RequestItems?.[TABLE] ?? []);
  return { client, send, batches };
}

function many(n: number): Listing[] {
  const [template] = seedListings();
  if (!template) throw new Error('seed data is empty');
  return Array.from({ length: n }, (_, i) => ({ ...template, id: `l-${i}` }));
}

const ids = (requests: WriteRequest[]) => requests.map((r) => r.PutRequest?.Item?.['id']);
const noSleep = async () => undefined;

describe('writeListings', () => {
  it('puts all listings with their search fields in batches of at most 25', async () => {
    const listings = many(60);
    const { client, batches } = stubDocumentClient(() => []);

    await expect(writeListings(client, TABLE, listings, { sleep: noSleep })).resolves.toBe(60);

    expect(batches().map((b) => b.length)).toEqual([BATCH_SIZE, BATCH_SIZE, 10]);
    expect(
      batches()
        .flat()
        .map((r) => r.PutRequest?.Item),
    ).toEqual(listings.map(toListingItem));
  });

  it('retries UnprocessedItems with backoff until all are written', async () => {
    const listings = many(5);
    // First call leaves the last two items unprocessed, the retry leaves one, then all succeed.
    const { client, batches } = stubDocumentClient((call, requests) =>
      call === 0 ? requests.slice(3) : call === 1 ? requests.slice(1) : [],
    );
    const sleep = jest.fn(noSleep);

    await writeListings(client, TABLE, listings, { sleep, baseDelayMs: 10 });

    expect(batches().map(ids)).toEqual([
      ['l-0', 'l-1', 'l-2', 'l-3', 'l-4'],
      ['l-3', 'l-4'],
      ['l-4'],
    ]);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });

  it('fails when items stay unprocessed after maxAttempts', async () => {
    const { client, send } = stubDocumentClient((_, requests) => requests);
    await expect(
      writeListings(client, TABLE, many(2), { maxAttempts: 3, sleep: noSleep }),
    ).rejects.toThrow('2 item(s) still unprocessed after 3 attempts');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('writes nothing for an empty list', async () => {
    const { client, send } = stubDocumentClient(() => []);
    await expect(writeListings(client, TABLE, [])).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('resolveTableName', () => {
  function stubCloudFormation(outputs: { OutputKey: string; OutputValue: string }[]) {
    const client = new CloudFormationClient({ region: 'eu-central-1' });
    const send = jest
      .spyOn(client, 'send')
      .mockImplementation(async () => ({ Stacks: [{ Outputs: outputs }] }));
    return { factory: jest.fn(() => client), send };
  }

  it('prefers --table, then LISTINGS_TABLE_NAME, without calling CloudFormation', async () => {
    const { factory } = stubCloudFormation([]);
    const env = { LISTINGS_TABLE_NAME: 'from-env' };
    await expect(
      resolveTableName({ table: 'from-arg', env, envName: 'dev', cloudFormation: factory }),
    ).resolves.toBe('from-arg');
    await expect(resolveTableName({ env, envName: 'dev', cloudFormation: factory })).resolves.toBe(
      'from-env',
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it('reads the ListingsTableName output of OpenEstate-<env>-Data', async () => {
    const { factory, send } = stubCloudFormation([
      { OutputKey: 'Other', OutputValue: 'x' },
      { OutputKey: LISTINGS_TABLE_OUTPUT, OutputValue: 'OpenEstate-prod-Data-Listings-ABC' },
    ]);
    await expect(
      resolveTableName({ env: {}, envName: 'prod', cloudFormation: factory }),
    ).resolves.toBe('OpenEstate-prod-Data-Listings-ABC');
    const command = send.mock.calls[0]?.[0] as DescribeStacksCommand;
    expect(command).toBeInstanceOf(DescribeStacksCommand);
    expect(command.input).toEqual({ StackName: 'OpenEstate-prod-Data' });
  });

  it('fails when the stack has no ListingsTableName output', async () => {
    const { factory } = stubCloudFormation([]);
    await expect(
      resolveTableName({ env: {}, envName: 'dev', cloudFormation: factory }),
    ).rejects.toThrow('Stack OpenEstate-dev-Data has no output ListingsTableName');
  });

  it('rejects an invalid environment name', () => {
    expect(() => dataStackName('Prod!')).toThrow('Invalid environment name');
  });
});

describe('consistency with the CDK app', () => {
  it.each(['dev', 'prod'])('stack name for %s matches the app config', (envName) => {
    expect(dataStackName(envName)).toBe(`${resolveEnvironment(envName).stackPrefix}-Data`);
  });

  it('DataStack exposes the output the seed script reads', () => {
    const stack = new DataStack(new App(), 'OpenEstate-dev-Data', {
      environment: resolveEnvironment('dev'),
    });
    expect(Object.keys(Template.fromStack(stack).findOutputs(LISTINGS_TABLE_OUTPUT))).toEqual([
      LISTINGS_TABLE_OUTPUT,
    ]);
  });
});
