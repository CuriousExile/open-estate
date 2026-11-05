// Generates load-test listings and writes them as JSONL and/or into the Listings table.
//
//   npm run generate --workspace @open-estate/loadtest -- \
//     [--count 100000] [--seed 1] [--out out/listings.jsonl] [--ids out/ids.txt] \
//     [--table <name> | --env <env>] [--region eu-central-1]
//
// Writes to DynamoDB when `--table` or `--env` is given (table resolution as in the infra seed:
// `--table` → `LISTINGS_TABLE_NAME` → output `ListingsTableName` of `OpenEstate-<env>-Data`).
// With the OpenSearch provider the indexer stream picks up the written items automatically.
// Listings are generated, written and released in chunks, so memory stays flat for any count.
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { resolveTableName, writeListings } from '@open-estate/infra/dist/scripts/seed-writer';
import type { Listing } from '@open-estate/shared';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { once } from 'node:events';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_COUNT, DEFAULT_SEED, generateListings } from './generator';

/** Listings per write chunk (20 BatchWrite calls of 25 items). */
const CHUNK_SIZE = 500;
const PROGRESS_EVERY = 10_000;

function parseInteger(name: string, raw: string, min: number): number {
  if (!/^\d+$/.test(raw) || Number(raw) < min || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`--${name} must be an integer ≥ ${min}, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

function openFile(path: string): WriteStream {
  mkdirSync(dirname(path), { recursive: true });
  return createWriteStream(path, { encoding: 'utf8' });
}

/** Writes with backpressure: waits for `drain` when the stream buffer is full. */
async function write(stream: WriteStream, chunk: string): Promise<void> {
  if (!stream.write(chunk)) await once(stream, 'drain');
}

async function close(stream: WriteStream): Promise<void> {
  stream.end();
  await once(stream, 'finish');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      count: { type: 'string', default: String(DEFAULT_COUNT) },
      seed: { type: 'string', default: String(DEFAULT_SEED) },
      out: { type: 'string' },
      ids: { type: 'string', default: 'out/ids.txt' },
      table: { type: 'string' },
      env: { type: 'string' },
      region: { type: 'string' },
    },
    strict: true,
  });
  const count = parseInteger('count', values.count, 1);
  const seed = parseInteger('seed', values.seed, 0);
  const toTable = values.table !== undefined || values.env !== undefined;
  if (values.out === undefined && !toTable) {
    throw new Error('Nothing to do: pass --out <file.jsonl> and/or --table <name> / --env <env>');
  }

  const clientConfig = values.region === undefined ? {} : { region: values.region };
  const tableName = toTable
    ? await resolveTableName({
        table: values.table,
        env: process.env,
        envName: values.env ?? 'dev',
        cloudFormation: () => new CloudFormationClient(clientConfig),
      })
    : undefined;
  const client =
    tableName === undefined
      ? undefined
      : DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig));

  const out = values.out === undefined ? undefined : openFile(values.out);
  const ids = openFile(values.ids);
  let chunk: Listing[] = [];
  let done = 0;

  const flush = async (): Promise<void> => {
    if (client !== undefined && tableName !== undefined) {
      await writeListings(client, tableName, chunk);
    }
    if (out !== undefined) await write(out, chunk.map((l) => JSON.stringify(l)).join('\n') + '\n');
    await write(ids, chunk.map((l) => l.id).join('\n') + '\n');
    done += chunk.length;
    chunk = [];
    if (done % PROGRESS_EVERY === 0 || done === count) console.error(`${done}/${count} listings`);
  };

  for (const listing of generateListings({ count, seed })) {
    chunk.push(listing);
    if (chunk.length === CHUNK_SIZE) await flush();
  }
  if (chunk.length > 0) await flush();
  await Promise.all([out === undefined ? undefined : close(out), close(ids)]);

  const targets = [values.out, tableName && `table ${tableName}`].filter(Boolean).join(' and ');
  console.log(`Generated ${count} listing(s) (seed ${seed}) into ${targets}; ids in ${values.ids}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
