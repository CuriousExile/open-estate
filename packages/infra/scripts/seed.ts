// Seeds the platform with example listings, written like an import of source `seed`: version 1,
// Feldherkunft, counters, snapshot and Duplikat_Prüfung (the example duplicate is stored inactive
// with a Markierung, unless the duplicate detection is switched off).
//
//   npm run seed --workspace @open-estate/infra -- [--env dev] [--concurrency 1]
//
// Stores: the outputs of `OpenEstate-<env>-Data` and `OpenEstate-<env>-ManagementData` (default
// env `dev`), each overridable by the connector Lambda's variable (`LISTINGS_TABLE_NAME`, …,
// `CONFIG_BUCKET`). Taxonomy, allowlists and `duplicate-detection.json` come from the deployed
// config bucket. Credentials and region come from the AWS SDK default provider chain.
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CONFIG_BUCKET_ENV } from '@open-estate/core';
import { createImportPipeline, loadImportConfig } from '@open-estate/ingestion';
import { parseArgs } from 'node:util';
import { SEED_SOURCE, seedListings } from './seed-data';
import {
  duplicateDetectionParameterName,
  importListings,
  resolveSeedTargets,
  seedRunId,
} from './seed-writer';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      env: { type: 'string', default: 'dev' },
      // One at a time by default: the repost is then flagged deterministically.
      concurrency: { type: 'string', default: '1' },
    },
    strict: true,
  });

  // Validate before any AWS call.
  const listings = seedListings();
  const targets = await resolveSeedTargets({
    env: process.env,
    envName: values.env,
    cloudFormation: () => new CloudFormationClient({}),
  });
  const s3 = new S3Client({});
  const config = await loadImportConfig({
    env: { [CONFIG_BUCKET_ENV]: targets.configBucket },
    s3,
  });
  const pipeline = createImportPipeline({
    names: targets,
    config,
    dynamo: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    s3,
    // Switched off on the platform, the seed is stored without duplicate check as well.
    duplicateDetectionParameter: duplicateDetectionParameterName(values.env, process.env),
  });
  const summary = await importListings(pipeline, listings, {
    source: SEED_SOURCE,
    runId: seedRunId(SEED_SOURCE),
    concurrency: Number(values.concurrency),
    sink: (line) => console.error(line),
  });
  console.log(
    `Seeded ${listings.length} listing(s) into ${targets.listingsTable}: ` +
      `${summary.imported} created (${summary.flagged} as possible duplicates), ` +
      `${summary.updated} updated, ${summary.unchanged} unchanged, ` +
      `${summary.rejected.length} rejected`,
  );
  if (summary.rejected.length > 0) {
    throw new Error(`Rejected (see the run log above): ${summary.rejected.join(', ')}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
