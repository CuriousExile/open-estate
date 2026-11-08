import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { StaticDuplicateDetectionSetting, type DuplicateDetectionSwitch } from '@open-estate/core';
import {
  createImportPipeline,
  createRunLogger,
  DUPLICATE_CHECK_UNAVAILABLE_REASON,
  ImportPipeline,
  InMemoryImportStore,
  type ImportConfig,
} from '@open-estate/ingestion';
import {
  buildSchemas,
  DEFAULT_DUPLICATE_CONFIG,
  TourProvidersConfig,
  type ListingContentInput,
} from '@open-estate/shared';
import fc from 'fast-check';
import { arbRealisticInput, TAXONOMY } from '../../shared/test/arbitraries/duplicates';

// Ein/Aus of the Duplikat-Erkennung in the import (duplicate-detection design: "Ein- und
// Ausschalten"): switched off, records are written without check and without Duplikat_Index
// maintenance; an unreadable switch rejects the record like an unreachable index.

const LOCALES = { defaultLocale: 'de', enabled: [{ locale: 'de', label: 'Deutsch' }] };
const listingSchema = buildSchemas(TAXONOMY, LOCALES).listing;
const tourProviders = TourProvidersConfig.parse({ providers: [] });
const [RECORD] = fc.sample(arbRealisticInput(), { numRuns: 1, seed: 7 }) as ListingContentInput[];

function setup(detection: DuplicateDetectionSwitch) {
  let time = Date.parse('2026-11-05T10:00:00.000Z');
  const clock = () => (time += 1000);
  const store = new InMemoryImportStore({ clock, duplicates: { taxonomy: TAXONOMY } });
  const pipeline = new ImportPipeline({
    listingSchema,
    reader: store.reader,
    writer: store.writer,
    tourProviders,
    taxonomy: TAXONOMY,
    ...(store.detector !== undefined && { duplicates: store.detector }),
    detection,
    clock,
  });
  const lines: string[] = [];
  const logger = createRunLogger({ runId: 'run-1', source: 'feed', sink: (l) => lines.push(l) });
  const importTwice = async () => {
    const outcomes = [];
    for (const id of ['imp-1', 'imp-2']) {
      outcomes.push(
        await pipeline.process(
          { ...RECORD, id, status: 'ACTIVE' },
          {
            runId: 'run-1',
            source: 'feed',
            logger,
          },
        ),
      );
    }
    return outcomes;
  };
  return { store, lines, importTwice };
}

describe('import with the Duplikat-Erkennung switched on or off', () => {
  it('flags the second of two equal records while switched on', async () => {
    const { store, importTwice } = setup(new StaticDuplicateDetectionSetting(true));
    expect(await importTwice()).toEqual(['imported', 'flagged']);
    expect(store.managed('imp-2')?.management.status).toBe('INACTIVE');
  });

  it('imports both as delivered, without flag and index entry, while switched off', async () => {
    const { store, lines, importTwice } = setup(new StaticDuplicateDetectionSetting(false));
    expect(await importTwice()).toEqual(['imported', 'imported']);
    for (const id of ['imp-1', 'imp-2']) {
      expect(store.managed(id)?.management).toMatchObject({ status: 'ACTIVE' });
      expect(store.managed(id)?.management.flags).toBeUndefined();
    }
    expect(store.duplicateIndex.snapshot()).toEqual({
      profiles: [],
      blocks: [],
      exact: [],
      reportRefs: [],
    });
    expect(lines.some((line) => line.includes('record.flagged'))).toBe(false);
  });

  it('rejects the record when the switch cannot be read', async () => {
    const { store, lines, importTwice } = setup({
      isEnabled: () => Promise.reject(new Error('ssm down')),
    });
    expect(await importTwice()).toEqual(['rejected', 'rejected']);
    expect(store.size).toBe(0);
    expect(lines.join('\n')).toContain(DUPLICATE_CHECK_UNAVAILABLE_REASON);
  });
});

describe('createImportPipeline with the SSM switch', () => {
  it('reads the parameter and leaves the Duplikat_Index alone while switched off', async () => {
    const region = 'eu-central-1';
    const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
    const writes = jest.spyOn(dynamo, 'send').mockImplementation(async () => ({}) as never);
    const s3 = new S3Client({ region });
    jest.spyOn(s3, 'send').mockImplementation(async () => ({}) as never);
    const ssm = new SSMClient({ region });
    const reads = jest.spyOn(ssm, 'send').mockImplementation(async (command: unknown) => {
      const name = (command as GetParametersCommand).input.Names?.[0] ?? '';
      return { Parameters: [{ Name: name, Value: 'disabled' }] } as never;
    });
    const config: ImportConfig = {
      taxonomy: TAXONOMY,
      locales: LOCALES,
      tourProviders,
      piiAllowlist: { allowedFields: [] },
      duplicateConfig: DEFAULT_DUPLICATE_CONFIG,
    };
    const pipeline = createImportPipeline({
      names: {
        listingsTable: 'Listings',
        deletionBlocklistTable: 'DeletionBlocklist',
        listingVersionsTable: 'ListingVersions',
        listingKeysTable: 'ListingKeys',
        metricCountersTable: 'MetricCounters',
        snapshotBucket: 'snapshots',
        duplicateIndexTable: 'DuplicateIndex',
      },
      config,
      dynamo,
      s3,
      ssm,
      duplicateDetectionParameter: '/open-estate/test/duplicate-detection',
    });
    const logger = createRunLogger({ runId: 'run-1', source: 'feed', sink: () => undefined });

    const outcome = await pipeline.process(
      { ...RECORD, id: 'imp-1' },
      { runId: 'run-1', source: 'feed', logger },
    );

    expect(outcome).toBe('imported');
    const [command] = reads.mock.calls[0] as unknown as [GetParametersCommand];
    expect(command.input.Names).toEqual(['/open-estate/test/duplicate-detection']);
    expect(JSON.stringify(writes.mock.calls)).not.toContain('DuplicateIndex');
  });
});

afterEach(() => jest.restoreAllMocks());
