import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { agencyScope, LISTING_COUNTER_CODES } from '@open-estate/core';
import { ImportPipeline, InMemoryImportStore, type RecordProcessor } from '@open-estate/ingestion';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  duplicateFlagOf,
  TourProvidersConfig,
} from '@open-estate/shared';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { resolveEnvironment } from '../src/config';
import { DataStack, ssmParameterNames } from '../src/data-stack';
import { ManagementDataStack } from '../src/management-stack';
import { SEED_SOURCE, seedListings } from '../scripts/seed-data';
import {
  dataStackName,
  duplicateDetectionParameterName,
  importListings,
  managementDataStackName,
  resolveSeedTargets,
  SEED_TARGET_ENV,
  seedRunId,
  STACK_OUTPUTS,
} from '../scripts/seed-writer';

// The seed script writes like an import (source `seed`), so seeded listings are complete managed
// listings: readable by the Management_API, versioned and covered by the Duplikat-Erkennung.

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);

function pipeline() {
  let now = Date.parse('2026-03-01T10:00:00.000Z');
  const clock = () => (now += 1000);
  const store = new InMemoryImportStore({ duplicates: { taxonomy }, clock });
  const processor = new ImportPipeline({
    listingSchema: buildSchemas(taxonomy, {
      defaultLocale: 'en',
      enabled: [
        { locale: 'en', label: 'English' },
        { locale: 'de', label: 'Deutsch' },
        { locale: 'de-DE', label: 'Deutsch (Deutschland)' },
        { locale: 'th', label: 'ไทย' },
      ],
    }).listing,
    reader: store.reader,
    writer: store.writer,
    tourProviders: TourProvidersConfig.parse({
      providers: [{ code: 'matterport', hostnames: ['my.matterport.com'] }],
    }),
    taxonomy,
    ...(store.detector !== undefined && { duplicates: store.detector }),
    clock,
  });
  return { store, processor };
}

describe('importListings', () => {
  it('creates every seed listing as a managed listing, the repost as a flagged duplicate', async () => {
    const { store, processor } = pipeline();
    const listings = seedListings();
    const lines: string[] = [];

    const summary = await importListings(processor, listings, {
      source: SEED_SOURCE,
      runId: 'seed-1',
      concurrency: 1,
      sink: (line) => lines.push(line),
    });

    expect(summary).toEqual({
      imported: listings.length,
      flagged: 1,
      updated: 0,
      unchanged: 0,
      rejected: [],
    });
    for (const listing of listings) {
      const stored = await store.listings.get(listing.id);
      expect(stored?.management).toMatchObject({ version: 1, origin: 'IMPORT' });
      expect(stored?.listing).toMatchObject({ source: SEED_SOURCE, lastRunId: 'seed-1' });
      expect(await store.versions.get(listing.id, 1)).not.toBeNull();
    }
    const repost = await store.listings.get('seed-de-berlin-010');
    expect(repost?.management.status).toBe('INACTIVE');
    expect(duplicateFlagOf(repost?.management.flags ?? [])?.originalId).toBe('seed-de-berlin-001');
    expect((await store.listings.get('seed-de-berlin-011'))?.management).toMatchObject({
      status: 'ACTIVE',
    });
    expect(
      await store.counters.get(agencyScope(undefined), LISTING_COUNTER_CODES.status('ACTIVE')),
    ).toBe(listings.length - 1);
    expect(lines.some((line) => line.includes('"runId":"seed-1"'))).toBe(true);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const { store, processor } = pipeline();
    const listings = seedListings();
    await importListings(processor, listings, { source: SEED_SOURCE, runId: 'seed-1' });
    const again = await importListings(processor, listings, {
      source: SEED_SOURCE,
      runId: 'seed-2',
      concurrency: 4,
    });
    expect(again).toEqual({
      imported: 0,
      flagged: 0,
      updated: 0,
      unchanged: listings.length,
      rejected: [],
    });
    expect((await store.listings.get('seed-de-berlin-001'))?.management.version).toBe(1);
  });

  it('counts rejected records by id', async () => {
    const processor: RecordProcessor = {
      process: async (record) => ((record as { id: string }).id === 'b' ? 'rejected' : 'updated'),
    };
    const [template] = seedListings();
    if (template === undefined) throw new Error('no seed data');
    const summary = await importListings(
      processor,
      ['a', 'b', 'c'].map((id) => ({ ...template, id })),
      { source: 'x', runId: 'r', concurrency: 2 },
    );
    expect(summary).toMatchObject({ updated: 2, rejected: ['b'] });
    expect(seedRunId('seed', new Date('2026-03-01T10:00:00.123Z'))).toBe('seed-20260301T100000Z');
  });
});

describe('resolveSeedTargets', () => {
  function stubCloudFormation(
    outputs: Record<string, { OutputKey: string; OutputValue: string }[]>,
  ) {
    const client = new CloudFormationClient({ region: 'eu-central-1' });
    const send = jest.spyOn(client, 'send').mockImplementation(async (command: unknown) => {
      const name = (command as DescribeStacksCommand).input.StackName ?? '';
      return { Stacks: [{ Outputs: outputs[name] ?? [] }] };
    });
    return { factory: jest.fn(() => client), send };
  }

  const allOutputs = (envName: string) => ({
    [dataStackName(envName)]: Object.values(STACK_OUTPUTS.data).map((key) => ({
      OutputKey: key,
      OutputValue: `data-${key}`,
    })),
    [managementDataStackName(envName)]: Object.values(STACK_OUTPUTS.managementData).map((key) => ({
      OutputKey: key,
      OutputValue: `md-${key}`,
    })),
  });

  it('reads every store from the outputs of the Data and ManagementData stacks', async () => {
    const { factory, send } = stubCloudFormation(allOutputs('prod'));
    await expect(
      resolveSeedTargets({ env: {}, envName: 'prod', cloudFormation: factory }),
    ).resolves.toEqual({
      listingsTable: 'data-ListingsTableName',
      deletionBlocklistTable: 'data-DeletionBlocklistTableName',
      configBucket: 'data-ConfigBucketName',
      listingVersionsTable: 'md-ListingVersionsTableName',
      listingKeysTable: 'md-ListingKeysTableName',
      metricCountersTable: 'md-MetricCountersTableName',
      duplicateIndexTable: 'md-DuplicateIndexTableName',
      snapshotBucket: 'md-SnapshotBucketName',
    });
    expect(send.mock.calls.map(([c]) => (c as DescribeStacksCommand).input.StackName)).toEqual([
      'OpenEstate-prod-Data',
      'OpenEstate-prod-ManagementData',
    ]);
  });

  it('prefers the environment and asks CloudFormation only for the rest', async () => {
    const { factory, send } = stubCloudFormation(allOutputs('dev'));
    const env = Object.fromEntries(
      Object.entries(SEED_TARGET_ENV).map(([key, variable]) => [variable, `env-${key}`]),
    );
    const targets = await resolveSeedTargets({ env, envName: 'dev', cloudFormation: factory });
    expect(targets.listingsTable).toBe('env-listingsTable');
    expect(factory).not.toHaveBeenCalled();
    const partial = { [SEED_TARGET_ENV.listingsTable]: 'mine' };
    const mixed = await resolveSeedTargets({
      env: partial,
      envName: 'dev',
      cloudFormation: factory,
    });
    expect(mixed.listingsTable).toBe('mine');
    expect(mixed.snapshotBucket).toBe('md-SnapshotBucketName');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('names a missing output', async () => {
    const { factory } = stubCloudFormation({});
    await expect(
      resolveSeedTargets({ env: {}, envName: 'dev', cloudFormation: factory }),
    ).rejects.toThrow('Stack OpenEstate-dev-Data has no output ListingsTableName');
  });

  it('rejects an invalid environment name', () => {
    expect(() => dataStackName('Prod!')).toThrow('Invalid environment name');
  });
});

describe('consistency with the CDK app', () => {
  it.each(['dev', 'prod'])('stack names for %s match the app config', (envName) => {
    const prefix = resolveEnvironment(envName).stackPrefix;
    expect(dataStackName(envName)).toBe(`${prefix}-Data`);
    expect(managementDataStackName(envName)).toBe(`${prefix}-ManagementData`);
  });

  it.each(['dev', 'prod'])('follows the Ein/Aus parameter of the %s DataStack', (envName) => {
    expect(duplicateDetectionParameterName(envName, {})).toBe(
      ssmParameterNames(envName).duplicateDetection,
    );
    expect(
      duplicateDetectionParameterName(envName, { DUPLICATE_DETECTION_PARAMETER_NAME: '/x/y' }),
    ).toBe('/x/y');
    expect(() => duplicateDetectionParameterName('Prod!', {})).toThrow('Invalid environment name');
  });

  it('the stacks expose every output the seed script reads', () => {
    const app = new App();
    const data = new DataStack(app, 'OpenEstate-dev-Data', {
      environment: resolveEnvironment('dev'),
    });
    const managementData = new ManagementDataStack(app, 'OpenEstate-dev-ManagementData', {
      removalPolicy: resolveEnvironment('dev').removalPolicy,
    });
    const outputs = (stack: DataStack | ManagementDataStack) =>
      Object.keys(Template.fromStack(stack).findOutputs('*'));
    expect(outputs(data)).toEqual(expect.arrayContaining(Object.values(STACK_OUTPUTS.data)));
    expect(outputs(managementData)).toEqual(
      expect.arrayContaining(Object.values(STACK_OUTPUTS.managementData)),
    );
  });
});
