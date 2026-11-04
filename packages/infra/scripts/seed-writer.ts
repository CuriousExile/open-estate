import { DescribeStacksCommand, type CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { BatchWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toListingItem } from '@open-estate/core';
import type { Listing } from '@open-estate/shared';

/** DynamoDB's BatchWriteItem limit. */
export const BATCH_SIZE = 25;
/** CfnOutput id in `DataStack`; kept in sync by a test against the synthesized template. */
export const LISTINGS_TABLE_OUTPUT = 'ListingsTableName';
export const TABLE_NAME_ENV_VAR = 'LISTINGS_TABLE_NAME';

const ENV_NAME_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;

/** Data stack name per environment; mirrors `resolveEnvironment` in `src/config.ts` (checked by a test). */
export function dataStackName(envName: string): string {
  if (!ENV_NAME_PATTERN.test(envName)) {
    throw new Error(`Invalid environment name ${JSON.stringify(envName)}`);
  }
  return `OpenEstate-${envName}-Data`;
}

export type DocumentSender = Pick<DynamoDBDocumentClient, 'send'>;
export type CloudFormationSender = Pick<CloudFormationClient, 'send'>;

export interface TableNameSources {
  /** `--table` CLI argument (highest priority). */
  table?: string | undefined;
  /** Process environment; `LISTINGS_TABLE_NAME` is used when `--table` is absent. */
  env: NodeJS.ProcessEnv;
  /** Environment name for the stack-output lookup. */
  envName: string;
  /** Lazily created so that no CloudFormation client exists when the name is given explicitly. */
  cloudFormation: () => CloudFormationSender;
}

/** `--table` → `LISTINGS_TABLE_NAME` → output `ListingsTableName` of stack `OpenEstate-<env>-Data`. */
export async function resolveTableName(sources: TableNameSources): Promise<string> {
  if (sources.table) return sources.table;
  const fromEnv = sources.env[TABLE_NAME_ENV_VAR];
  if (fromEnv) return fromEnv;

  const stackName = dataStackName(sources.envName);
  const { Stacks } = await sources
    .cloudFormation()
    .send(new DescribeStacksCommand({ StackName: stackName }));
  const value = Stacks?.[0]?.Outputs?.find(
    (o) => o.OutputKey === LISTINGS_TABLE_OUTPUT,
  )?.OutputValue;
  if (!value) {
    throw new Error(`Stack ${stackName} has no output ${LISTINGS_TABLE_OUTPUT}`);
  }
  return value;
}

export interface WriteOptions {
  /** Attempts per batch, including the first one. */
  maxAttempts?: number;
  /** Base delay for exponential backoff between retries of unprocessed items. */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type WriteRequests = NonNullable<BatchWriteCommand['input']['RequestItems']>[string];

/**
 * Writes listings with BatchWrite in batches of 25 and retries `UnprocessedItems` with exponential
 * backoff. Puts by primary key `id`, so re-running overwrites the same items (idempotent).
 * Item layout comes from `toListingItem` in core (listing + flat search fields + `gsiPk`).
 *
 * @returns number of written items
 * @throws if items remain unprocessed after `maxAttempts`
 */
export async function writeListings(
  client: DocumentSender,
  tableName: string,
  listings: readonly Listing[],
  { maxAttempts = 8, baseDelayMs = 100, sleep = defaultSleep }: WriteOptions = {},
): Promise<number> {
  for (let start = 0; start < listings.length; start += BATCH_SIZE) {
    let pending: WriteRequests = listings
      .slice(start, start + BATCH_SIZE)
      .map((listing) => ({ PutRequest: { Item: toListingItem(listing) } }));

    for (let attempt = 1; pending.length > 0; attempt++) {
      if (attempt > maxAttempts) {
        throw new Error(
          `${pending.length} item(s) still unprocessed after ${maxAttempts} attempts on ${tableName}`,
        );
      }
      if (attempt > 1) await sleep(baseDelayMs * 2 ** (attempt - 2));
      const { UnprocessedItems } = await client.send(
        new BatchWriteCommand({ RequestItems: { [tableName]: pending } }),
      );
      pending = UnprocessedItems?.[tableName] ?? [];
    }
  }
  return listings.length;
}
