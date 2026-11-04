import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  CONNECTOR_LAMBDA_ENV,
  initConnectorHandler,
  type ConnectorHandler,
} from '@open-estate/ingestion';
import { DEFAULT_TAXONOMY_CONFIG } from '@open-estate/shared';
import { createFakeSecrets } from './support/fake-secrets';

/**
 * Task 10.16, "a timeout of one connector ends only that connector" (Req 5.7), behavioral half.
 *
 * In AWS, each connector has its own Lambda (timeout = `timeoutSeconds`) and its own state machine
 * (execution timeout = `timeoutSeconds`); packages/infra/test/ingestion-stack.test.ts proves that
 * structurally (no shared function, state machine, role, concurrency setting or IAM grant).
 * A real Lambda timeout (the sandbox is stopped) cannot be reproduced in-process. Here each
 * connector gets its own handler, pinned via `CONNECTOR_ID` like its Lambda, the shared tables
 * and config bucket are in-memory fakes, and the timeout is a fake-timer race with
 * `timeoutSeconds`. Proven: a hanging source in connector A neither blocks nor fails
 * connector B running at the same time; B writes its listings and logs SUCCESS, and A writes
 * nothing and never logs a finished run.
 */

const REGION = 'eu-central-1';
const HANGING_ENDPOINT = 'https://hanging.partner.example/v1/listings';
const HEALTHY_ENDPOINT = 'https://healthy.partner.example/v1/listings';

const LISTING_FIELDS = [
  'id',
  'originalLocale',
  'title',
  'description',
  'translations',
  'offers',
  'listingType',
  'rooms',
  'area',
  'address',
  'sourceUrl',
  'media',
] as const;
const identityMapping = { fields: Object.fromEntries(LISTING_FIELDS.map((f) => [f, f])) };

function connector(id: string, endpoint: string, timeoutSeconds: number) {
  return {
    id,
    type: 'external-api',
    module: 'external-api',
    enabled: true,
    schedule: 'rate(1 hour)',
    timeoutSeconds,
    settings: { endpoint, recordsPath: 'items', mapping: identityMapping },
  };
}

const HANGING = connector('partner-hanging', HANGING_ENDPOINT, 60);
const HEALTHY = connector('partner-healthy', HEALTHY_ENDPOINT, 600);

function rawListing(id: string): Record<string, unknown> {
  return {
    id,
    originalLocale: 'de',
    title: 'Helle Wohnung',
    description: 'Mit Balkon',
    translations: [],
    offers: [{ offerType: 'RENT', coldRent: '900.00', currency: 'EUR' }],
    listingType: 'loft',
    rooms: 2.5,
    area: '72.50',
    address: { city: 'Berlin', postalCode: '10115', country: 'DE' },
    sourceUrl: `https://healthy.partner.example/listings/${id}`,
    media: [],
  };
}

const CONFIG_FILES: Record<string, string> = {
  'taxonomy.json': JSON.stringify(DEFAULT_TAXONOMY_CONFIG),
  'i18n-config.json': JSON.stringify({
    defaultLocale: 'de',
    enabled: [{ locale: 'de', label: 'Deutsch' }],
  }),
  'connectors.json': JSON.stringify([HANGING, HEALTHY]),
};

/** Shared in-memory "tables": every TransactWrite put, from any connector function. */
const putItems: Record<string, unknown>[] = [];

/** Sources of one connector Lambda: own SDK clients, shared fake tables and bucket. */
function lambdaSources(lines: string[]) {
  const s3 = new S3Client({ region: REGION });
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  jest.spyOn(s3, 'send').mockImplementation(async (command: unknown) => {
    if (!(command instanceof GetObjectCommand)) throw new Error('unexpected command');
    const body = CONFIG_FILES[command.input.Key ?? ''];
    if (body === undefined) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    return { Body: { transformToString: async () => body } };
  });
  jest.spyOn(dynamo, 'send').mockImplementation(async (command: unknown) => {
    // Blocklist GetItem: nothing blocked. TransactWrite: record the listing put.
    if (command instanceof TransactWriteCommand) {
      for (const item of command.input.TransactItems ?? []) {
        if (item.Put?.Item) putItems.push(item.Put.Item);
      }
    }
    return {};
  });
  return { s3, dynamo, secrets: createFakeSecrets({}), sink: (line: string) => lines.push(line) };
}

/** Pinned handler like the connector's own Lambda (`CONNECTOR_ID`). */
async function connectorLambda(connectorId: string, lines: string[]): Promise<ConnectorHandler> {
  return initConnectorHandler(
    {
      [CONNECTOR_LAMBDA_ENV.listingsTable]: 'Listings',
      [CONNECTOR_LAMBDA_ENV.deletionBlocklistTable]: 'DeletionBlocklist',
      [CONNECTOR_LAMBDA_ENV.configBucket]: 'config-bucket',
      [CONNECTOR_LAMBDA_ENV.connectorId]: connectorId,
    },
    lambdaSources(lines),
  );
}

class SimulatedLambdaTimeout extends Error {
  constructor(readonly seconds: number) {
    super(`Task timed out after ${seconds}.00 seconds`);
    this.name = 'Sandbox.Timedout';
  }
}

/** Mirrors the Lambda timeout: the invocation ends after `seconds`, whatever the run does. */
function invokeWithTimeout<T>(run: Promise<T>, seconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SimulatedLambdaTimeout(seconds)), seconds * 1000);
  });
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

const events = (lines: string[]) => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

beforeEach(() => {
  putItems.length = 0;
  jest.useFakeTimers({ doNotFake: ['Date', 'nextTick', 'queueMicrotask'] });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('connector timeout isolation (Req 5.7)', () => {
  it('a hanging connector times out alone; a concurrent connector completes and writes', async () => {
    const fetched: string[] = [];
    // The hanging source never answers and ignores its abort signal (worst case).
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url.startsWith(HANGING_ENDPOINT)) return new Promise<Response>(() => undefined);
      return new Response(JSON.stringify({ items: [rawListing('H-1'), rawListing('H-2')] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const hangingLog: string[] = [];
    const healthyLog: string[] = [];
    const hangingLambda = await connectorLambda(HANGING.id, hangingLog);
    const healthyLambda = await connectorLambda(HEALTHY.id, healthyLog);

    // Both executions start at the same time (two schedules firing together).
    const hangingRun = invokeWithTimeout(
      hangingLambda({ connectorId: HANGING.id, runId: 'exec-hanging' }),
      HANGING.timeoutSeconds,
    );
    const hangingOutcome = hangingRun.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    const healthyRun = invokeWithTimeout(
      healthyLambda({ connectorId: HEALTHY.id, runId: 'exec-healthy' }),
      HEALTHY.timeoutSeconds,
    );

    // B finishes while A is still hanging, without any time passing.
    await expect(healthyRun).resolves.toMatchObject({
      runId: 'exec-healthy',
      source: HEALTHY.id,
      outcome: 'COMPLETED',
      status: 'SUCCESS',
      imported: 2,
    });
    expect(fetched).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^https:\/\/hanging\./),
        expect.stringMatching(/^https:\/\/healthy\./),
      ]),
    );

    // A's time limit elapses: only A's invocation ends, with the Lambda timeout error.
    await jest.advanceTimersByTimeAsync(HANGING.timeoutSeconds * 1000);
    await expect(hangingOutcome).resolves.toBeInstanceOf(SimulatedLambdaTimeout);

    // B's listings are in the shared table, tagged with B's run; A wrote nothing.
    expect(putItems.map((item) => [item['id'], item['source'], item['lastRunId']])).toEqual([
      ['H-1', HEALTHY.id, 'exec-healthy'],
      ['H-2', HEALTHY.id, 'exec-healthy'],
    ]);
    expect(events(healthyLog)).toContainEqual(
      expect.objectContaining({ event: 'run.finished', status: 'SUCCESS', source: HEALTHY.id }),
    );
    // A's run started but never finished; its end is reported by Step Functions (timeout).
    const hangingEvents = events(hangingLog).map((e) => e['event']);
    expect(hangingEvents).toContain('run.started');
    expect(hangingEvents).not.toContain('run.finished');
    expect(events(hangingLog).every((e) => e['source'] === HANGING.id)).toBe(true);

    // B's function is unaffected by A's timeout: its next scheduled run succeeds again.
    await expect(
      invokeWithTimeout(
        healthyLambda({ connectorId: HEALTHY.id, runId: 'exec-healthy-2' }),
        HEALTHY.timeoutSeconds,
      ),
    ).resolves.toMatchObject({ status: 'SUCCESS', imported: 2 });
  });
});
