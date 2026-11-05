import {
  BatchWriteCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { ConnectorRunView, RunRejectionView } from '@open-estate/shared';
import { z } from 'zod';
import {
  CONNECTOR_RUN_FAILURE_STATUS,
  type ConnectorRunFilter,
  type ConnectorRunReader,
  type RunRejectionPage,
} from './connector-run-reader';
import { decodeKeyCursor, toKeyPage, type KeyPage, type KeyPageRequest } from './key-page';

// Write side and DynamoDB implementation of `ConnectorRuns` / `RunRejections` (design:
// "DynamoDB-Tabellen", "Import-Pipeline", Req 13.2, 13.3, 14.3):
// - `ConnectorRuns`: PK `connectorId`, SK `runKey` = `startedAt#runId`, GSI `byAgency` (PK
//   `agencyId`, SK `runKey`), TTL `expiresAt`.
// - `RunRejections`: PK `runId`, SK `seq` (number). `seq = 0` is the run marker (connector,
//   agency, start), so the rejections of a run resolve its agency and tell an unknown run from one
//   without rejections; rejections follow with `seq = 1…n`. TTL `expiresAt`.
// All items of a run expire 100 days after its start (≥ 90 days of Req 13.2).

export const CONNECTOR_RUNS_PK_ATTRIBUTE = 'connectorId';
export const CONNECTOR_RUNS_SK_ATTRIBUTE = 'runKey';
export const CONNECTOR_RUNS_AGENCY_ATTRIBUTE = 'agencyId';
export const CONNECTOR_RUNS_BY_AGENCY_INDEX = 'byAgency';
export const RUN_REJECTIONS_PK_ATTRIBUTE = 'runId';
export const RUN_REJECTIONS_SK_ATTRIBUTE = 'seq';
/** TTL attribute (epoch seconds) of both tables. */
export const CONNECTOR_RUNS_TTL_ATTRIBUTE = 'expiresAt';

/** Runs and rejections are kept 100 days (design: TTL of `ConnectorRuns`/`RunRejections`). */
export const CONNECTOR_RUN_RETENTION_SECONDS = 100 * 24 * 60 * 60;

/** `seq` of the run marker in `RunRejections`; rejections start at 1. */
export const RUN_MARKER_SEQ = 0;

/** Sort key `startedAt#runId`; `startedAt` is normalized to `toISOString()` (sortable). */
export const connectorRunSortKey = (startedAt: string, runId: string): string =>
  `${normalizeInstant(startedAt)}#${runId}`;

/** TTL (epoch seconds) of every item of a run started at `startedAt`. */
export function connectorRunExpiry(startedAt: string): number {
  return Math.floor(instantOf(startedAt) / 1000) + CONNECTOR_RUN_RETENTION_SECONDS;
}

export interface ConnectorRunWriter {
  /**
   * Stores the summary of a finished run and its rejections (in this order, `seq = 1…n`).
   * Rejections carry identifier/Custom_Id, field names and reason only, never values (Req 13.3).
   */
  record(run: ConnectorRunView, rejections: readonly RunRejectionView[]): Promise<void>;
}

function instantOf(timestamp: string): number {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) throw new Error(`Invalid timestamp ${timestamp}`);
  return ms;
}

const normalizeInstant = (timestamp: string): string =>
  new Date(instantOf(timestamp)).toISOString();

/** Upper bound of the sort keys of runs started at `to` (`#` < every run id character). */
const SORT_KEY_END = '#\uffff';

/** BatchWriteItem accepts at most 25 requests. */
const BATCH_SIZE = 25;
/** Attempts per batch while DynamoDB returns `UnprocessedItems`. */
const MAX_BATCH_ATTEMPTS = 5;

const markerSchema = z.object({
  [RUN_REJECTIONS_SK_ATTRIBUTE]: z.literal(RUN_MARKER_SEQ),
  agencyId: ConnectorRunView.shape.agencyId,
});

type WriteRequest = { PutRequest: { Item: Record<string, unknown> } };

export interface DynamoDbConnectorRunStoreOptions {
  client: DynamoDBDocumentClient;
  /** `ConnectorRuns` table. */
  runsTableName: string;
  /** `RunRejections` table. */
  rejectionsTableName: string;
  /** Pause before retrying unprocessed items (tests pass 0). */
  retryDelayMs?: number;
}

/**
 * Writes with `BatchWriteItem` only (the connector Lambda has `PutItem`/`BatchWriteItem`), reads
 * with `Query`/`GetItem` and, without agency and connector filter, `Scan` (platform admins).
 */
export class DynamoDbConnectorRunStore implements ConnectorRunReader, ConnectorRunWriter {
  private readonly client: DynamoDBDocumentClient;
  private readonly runsTable: string;
  private readonly rejectionsTable: string;
  private readonly retryDelayMs: number;

  constructor({
    client,
    runsTableName,
    rejectionsTableName,
    retryDelayMs = 100,
  }: DynamoDbConnectorRunStoreOptions) {
    this.client = client;
    this.runsTable = runsTableName;
    this.rejectionsTable = rejectionsTableName;
    this.retryDelayMs = retryDelayMs;
  }

  async record(run: ConnectorRunView, rejections: readonly RunRejectionView[]): Promise<void> {
    const expiresAt = connectorRunExpiry(run.startedAt);
    const agency = run.agencyId === undefined ? {} : { agencyId: run.agencyId };
    const summary = ConnectorRunView.parse(run);
    // Summary and run marker in one request (two tables), then the rejections.
    await this.batchWrite({
      [this.runsTable]: [
        put({
          ...summary,
          startedAt: normalizeInstant(summary.startedAt),
          [CONNECTOR_RUNS_SK_ATTRIBUTE]: connectorRunSortKey(run.startedAt, run.runId),
          [CONNECTOR_RUNS_TTL_ATTRIBUTE]: expiresAt,
        }),
      ],
      [this.rejectionsTable]: [
        put({
          [RUN_REJECTIONS_PK_ATTRIBUTE]: run.runId,
          [RUN_REJECTIONS_SK_ATTRIBUTE]: RUN_MARKER_SEQ,
          connectorId: run.connectorId,
          ...agency,
          startedAt: normalizeInstant(run.startedAt),
          [CONNECTOR_RUNS_TTL_ATTRIBUTE]: expiresAt,
        }),
      ],
    });
    const items = rejections.map((rejection, index) =>
      put({
        ...RunRejectionView.parse(rejection),
        [RUN_REJECTIONS_PK_ATTRIBUTE]: run.runId,
        [RUN_REJECTIONS_SK_ATTRIBUTE]: index + 1,
        ...agency,
        [CONNECTOR_RUNS_TTL_ATTRIBUTE]: expiresAt,
      }),
    );
    for (let start = 0; start < items.length; start += BATCH_SIZE) {
      await this.batchWrite({ [this.rejectionsTable]: items.slice(start, start + BATCH_SIZE) });
    }
  }

  async query(
    filter: ConnectorRunFilter,
    { limit, cursor }: KeyPageRequest,
    signal?: AbortSignal,
  ): Promise<KeyPage<ConnectorRunView>> {
    const names: Record<string, string> = { '#sk': CONNECTOR_RUNS_SK_ATTRIBUTE };
    const values: Record<string, unknown> = {
      ':from': normalizeInstant(filter.from),
      ':to': `${normalizeInstant(filter.to)}${SORT_KEY_END}`,
    };
    const conditions: string[] = [];
    const where = (attribute: string, value: string | undefined) => {
      if (value === undefined) return;
      names[`#${attribute}`] = attribute;
      values[`:${attribute}`] = value;
      conditions.push(`#${attribute} = :${attribute}`);
    };
    const keyAttribute = filter.agencyId !== undefined ? 'agencyId' : 'connectorId';
    const keyValue = filter.agencyId ?? filter.connectorId;
    if (filter.agencyId !== undefined) where('connectorId', filter.connectorId);
    where('status', filter.status);
    if (filter.problemsOnly === true) {
      names['#status'] = 'status';
      names['#rejected'] = 'rejected';
      values[':failure'] = CONNECTOR_RUN_FAILURE_STATUS;
      values[':zero'] = 0;
      conditions.push('(#status = :failure OR #rejected > :zero)');
    }
    const base = {
      TableName: this.runsTable,
      Limit: limit,
      ...(cursor !== undefined && { ExclusiveStartKey: decodeKeyCursor(cursor) }),
    };
    const options = signal === undefined ? {} : { abortSignal: signal };

    if (keyValue === undefined) {
      // No key to query: Scan with the period as filter; ordered per page only.
      const out = await this.client.send(
        new ScanCommand({
          ...base,
          FilterExpression: ['#sk BETWEEN :from AND :to', ...conditions].join(' AND '),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
        options,
      );
      const page = toKeyPage(out.Items, out.LastEvaluatedKey, parseRun);
      page.items.sort((a, b) =>
        connectorRunSortKey(b.startedAt, b.runId).localeCompare(
          connectorRunSortKey(a.startedAt, a.runId),
        ),
      );
      return page;
    }
    names['#pk'] = keyAttribute;
    values[':pk'] = keyValue;
    const out = await this.client.send(
      new QueryCommand({
        ...base,
        ...(filter.agencyId !== undefined && { IndexName: CONNECTOR_RUNS_BY_AGENCY_INDEX }),
        KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :from AND :to',
        ...(conditions.length > 0 && { FilterExpression: conditions.join(' AND ') }),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ScanIndexForward: false,
      }),
      options,
    );
    return toKeyPage(out.Items, out.LastEvaluatedKey, parseRun);
  }

  async rejections(
    runId: string,
    { limit, cursor }: KeyPageRequest,
    signal?: AbortSignal,
  ): Promise<RunRejectionPage | null> {
    const options = signal === undefined ? {} : { abortSignal: signal };
    const marker = await this.client.send(
      new GetCommand({
        TableName: this.rejectionsTable,
        Key: {
          [RUN_REJECTIONS_PK_ATTRIBUTE]: runId,
          [RUN_REJECTIONS_SK_ATTRIBUTE]: RUN_MARKER_SEQ,
        },
      }),
      options,
    );
    if (marker.Item === undefined) return null;
    const { agencyId } = markerSchema.parse(marker.Item);
    const out = await this.client.send(
      new QueryCommand({
        TableName: this.rejectionsTable,
        KeyConditionExpression: '#pk = :pk AND #sk > :marker',
        ExpressionAttributeNames: {
          '#pk': RUN_REJECTIONS_PK_ATTRIBUTE,
          '#sk': RUN_REJECTIONS_SK_ATTRIBUTE,
        },
        ExpressionAttributeValues: { ':pk': runId, ':marker': RUN_MARKER_SEQ },
        Limit: limit,
        ...(cursor !== undefined && { ExclusiveStartKey: decodeKeyCursor(cursor) }),
      }),
      options,
    );
    return {
      ...toKeyPage(out.Items, out.LastEvaluatedKey, parseRejection),
      ...(agencyId !== undefined && { agencyId }),
    };
  }

  /** One `BatchWriteItem`, repeated for `UnprocessedItems`; throws if items remain. */
  private async batchWrite(requests: Record<string, WriteRequest[]>): Promise<void> {
    let pending: Record<string, WriteRequest[]> = requests;
    for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt += 1) {
      const out = await this.client.send(new BatchWriteCommand({ RequestItems: pending }));
      const unprocessed = Object.fromEntries(
        Object.entries(out.UnprocessedItems ?? {}).filter(([, items]) => items.length > 0),
      ) as Record<string, WriteRequest[]>;
      if (Object.keys(unprocessed).length === 0) return;
      pending = unprocessed;
      if (attempt < MAX_BATCH_ATTEMPTS && this.retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempt));
      }
    }
    throw new Error('ConnectorRuns: unprocessed items remain after retries');
  }
}

const put = (item: Record<string, unknown>): WriteRequest => ({ PutRequest: { Item: item } });

const parseRun = (item: unknown): ConnectorRunView => ConnectorRunView.parse(item);

const parseRejection = (item: unknown): RunRejectionView => RunRejectionView.parse(item);
