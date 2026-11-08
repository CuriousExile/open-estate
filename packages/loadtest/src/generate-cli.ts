// Generates load-test listings and writes them as JSONL and/or into the platform.
//
//   npm run generate --workspace @open-estate/loadtest -- \
//     [--count 100000] [--seed 1] [--out out/listings.jsonl] [--ids out/ids.txt] \
//     [--env <env>] [--concurrency 16] [--region eu-central-1]
//
// With `--env` the listings are imported like the infra seed (source `loadtest`): through the
// import pipeline, so they are complete managed listings with version, counters and duplicate
// index. Stores: outputs of `OpenEstate-<env>-Data` and `-ManagementData`, each overridable by the
// connector Lambda's variable (`LISTINGS_TABLE_NAME`, …). With the OpenSearch provider the indexer
// stream picks up the written items automatically. Listings are generated, written and released
// in chunks, so memory stays flat for any count.
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CONFIG_BUCKET_ENV } from '@open-estate/core';
import {
  importListings,
  duplicateDetectionParameterName,
  resolveSeedTargets,
  seedRunId,
} from '@open-estate/infra/dist/scripts/seed-writer';
import {
  createImportPipeline,
  loadImportConfig,
  type ImportPipeline,
} from '@open-estate/ingestion';
import type { Listing } from '@open-estate/shared';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { once } from 'node:events';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_COUNT, DEFAULT_SEED, generateListings, LOADTEST_SOURCE } from './generator';

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
      env: { type: 'string' },
      concurrency: { type: 'string', default: '16' },
      region: { type: 'string' },
    },
    strict: true,
  });
  const count = parseInteger('count', values.count, 1);
  const seed = parseInteger('seed', values.seed, 0);
  const concurrency = parseInteger('concurrency', values.concurrency, 1);
  if (values.out === undefined && values.env === undefined) {
    throw new Error('Nothing to do: pass --out <file.jsonl> and/or --env <env>');
  }

  const clientConfig = values.region === undefined ? {} : { region: values.region };
  let pipeline: ImportPipeline | undefined;
  let tableName: string | undefined;
  if (values.env !== undefined) {
    const targets = await resolveSeedTargets({
      env: process.env,
      envName: values.env,
      cloudFormation: () => new CloudFormationClient(clientConfig),
    });
    const s3 = new S3Client(clientConfig);
    pipeline = createImportPipeline({
      names: targets,
      config: await loadImportConfig({ env: { [CONFIG_BUCKET_ENV]: targets.configBucket }, s3 }),
      dynamo: DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig)),
      s3,
      // Follows the platform's Ein/Aus of the duplicate detection.
      duplicateDetectionParameter: duplicateDetectionParameterName(values.env, process.env),
      ssm: new SSMClient(clientConfig),
    });
    tableName = targets.listingsTable;
  }
  const runId = seedRunId(LOADTEST_SOURCE);
  let rejected = 0;

  const out = values.out === undefined ? undefined : openFile(values.out);
  const ids = openFile(values.ids);
  let chunk: Listing[] = [];
  let done = 0;

  const flush = async (): Promise<void> => {
    if (pipeline !== undefined) {
      const summary = await importListings(pipeline, chunk, {
        source: LOADTEST_SOURCE,
        runId,
        concurrency,
      });
      rejected += summary.rejected.length;
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
  if (rejected > 0) throw new Error(`${rejected} listing(s) were rejected by the import`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
