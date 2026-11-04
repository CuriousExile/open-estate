// Seeds the Listings table with example listings.
//
//   npm run seed --workspace @open-estate/infra -- [--env dev] [--table <name>]
//
// Table name: `--table`, else `LISTINGS_TABLE_NAME`, else the `ListingsTableName` output of stack
// `OpenEstate-<env>-Data` (default env `dev`). Credentials and region come from the AWS SDK
// default provider chain (e.g. `AWS_PROFILE`, `AWS_REGION`).
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { parseArgs } from 'node:util';
import { seedListings } from './seed-data';
import { resolveTableName, writeListings } from './seed-writer';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      env: { type: 'string', default: 'dev' },
      table: { type: 'string' },
    },
    strict: true,
  });

  // Validate before any AWS call.
  const listings = seedListings();
  const tableName = await resolveTableName({
    table: values.table,
    env: process.env,
    envName: values.env,
    cloudFormation: () => new CloudFormationClient({}),
  });

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const written = await writeListings(client, tableName, listings);
  console.log(`Seeded ${written} listing(s) into ${tableName}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
