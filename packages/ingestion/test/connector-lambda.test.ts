import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ConfigError } from '@open-estate/core';
import {
  CONNECTOR_LAMBDA_ENV,
  createConnectorHandlerFromEnv,
  initConnectorHandler,
  UnknownConnectorError,
} from '@open-estate/ingestion';
import { DEFAULT_TAXONOMY_CONFIG } from '@open-estate/shared';

const REGION = 'eu-central-1';

const ENV = {
  [CONNECTOR_LAMBDA_ENV.listingsTable]: 'Listings',
  [CONNECTOR_LAMBDA_ENV.deletionBlocklistTable]: 'DeletionBlocklist',
  [CONNECTOR_LAMBDA_ENV.configBucket]: 'config-bucket',
};

const CRAWLER = {
  id: 'partner-site',
  type: 'web-crawler',
  module: 'web-crawler',
  enabled: true,
  schedule: 'rate(1 day)',
  settings: { startUrls: ['https://partner.example/listings'] },
};

const BASE_FILES: Record<string, string> = {
  'taxonomy.json': JSON.stringify(DEFAULT_TAXONOMY_CONFIG),
  'i18n-config.json': JSON.stringify({
    defaultLocale: 'de',
    enabled: [{ locale: 'de', label: 'Deutsch' }],
  }),
  'connectors.json': JSON.stringify([CRAWLER]),
};

function setup(files: Record<string, string> = BASE_FILES) {
  const s3 = new S3Client({ region: REGION });
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const reads = jest.spyOn(s3, 'send').mockImplementation(async (command: unknown) => {
    if (!(command instanceof GetObjectCommand)) throw new Error('unexpected command');
    const body = files[command.input.Key ?? ''];
    if (body === undefined) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    return { Body: { transformToString: async () => body } };
  });
  const writes = jest.spyOn(dynamo, 'send').mockResolvedValue({} as never);
  const lines: string[] = [];
  const sink = (line: string) => lines.push(line);
  const keys = () =>
    reads.mock.calls.map(([c]) => (c as GetObjectCommand).input.Key).sort() as string[];
  return { sources: { s3, dynamo, sink }, writes, lines, keys };
}

afterEach(() => jest.restoreAllMocks());

describe('connector Lambda', () => {
  it('runs the requested connector and returns a JSON-safe summary', async () => {
    const { sources, writes, lines, keys } = setup();
    const handler = await initConnectorHandler(ENV, sources);

    const result = await handler({ connectorId: 'partner-site', runId: 'exec-1' });

    // Missing crawler allowlist ⇒ no target allowed (default-deny), nothing fetched or written.
    expect(result).toMatchObject({
      runId: 'exec-1',
      source: 'partner-site',
      outcome: 'COMPLETED',
      status: 'SUCCESS',
      imported: 0,
      startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
    expect(writes).not.toHaveBeenCalled();
    expect(lines.map((l) => (JSON.parse(l) as { event: string }).event)).toContain('crawl.checked');
    expect(keys()).toEqual([
      'connectors.json',
      'crawler-allowlist.json',
      'i18n-config.json',
      'pii-allowlist.json',
      'taxonomy.json',
      'tour-providers.json',
    ]);
  });

  it('generates a run id when none is passed', async () => {
    const handler = await initConnectorHandler(ENV, setup().sources);
    const { runId } = await handler({ connectorId: 'partner-site' });
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses unknown connectors and ids other than the pinned one', async () => {
    const pinned = { ...ENV, [CONNECTOR_LAMBDA_ENV.connectorId]: 'other' };
    const handler = await initConnectorHandler(pinned, setup().sources);
    await expect(handler({ connectorId: 'partner-site' })).rejects.toThrow(UnknownConnectorError);
    const open = await initConnectorHandler(ENV, setup().sources);
    await expect(open({ connectorId: 'missing' })).rejects.toThrow(UnknownConnectorError);
    await expect(open({})).rejects.toThrow();
  });

  it('fails the init on missing or invalid configuration', async () => {
    await expect(initConnectorHandler({}, setup().sources)).rejects.toMatchObject({
      code: 'CONFIG_MISSING',
      names: [CONNECTOR_LAMBDA_ENV.listingsTable, CONNECTOR_LAMBDA_ENV.deletionBlocklistTable],
    });
    const invalidPii = { ...BASE_FILES, 'pii-allowlist.json': '{"allowedFields":["nope"]}' };
    await expect(initConnectorHandler(ENV, setup(invalidPii).sources)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    const withoutConnectors = Object.fromEntries(
      Object.entries(BASE_FILES).filter(([key]) => key !== 'connectors.json'),
    );
    await expect(initConnectorHandler(ENV, setup(withoutConnectors).sources)).rejects.toMatchObject(
      { code: 'CONFIG_MISSING', names: ['connectors.json'] },
    );
  });

  it('logs an init failure without values and fails every invocation', async () => {
    const { sources, lines } = setup();
    const handler = createConnectorHandlerFromEnv({}, sources);
    await expect(handler({ connectorId: 'partner-site' })).rejects.toBeInstanceOf(ConfigError);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      level: 'error',
      event: 'init.failed',
      code: 'CONFIG_MISSING',
    });
  });
});
