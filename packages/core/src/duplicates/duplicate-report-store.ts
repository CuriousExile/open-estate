import { createHash } from 'node:crypto';
import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  DUPLICATE_REPORT_STATES,
  EntityId,
  IsoDateTime,
  LISTING_BOUNDS,
  MATCH_REASONS,
  type DuplicateReportState,
  type MatchReason,
} from '@open-estate/shared';
import { z } from 'zod';
import {
  decodeKeyCursor,
  encodeKeyCursor,
  InvalidCursorError,
  type KeyPage,
  type KeyPageRequest,
} from '../management/key-page';
import type { DynamoDbOp, InMemoryOp } from '../management/transaction';

// `DuplicateReports` table (duplicate-detection design: "Agenturübergreifende Treffer", Req 11):
// one item per pair of listings of different Prüfbereiche that the Duplikat_Abgleich found to be
// duplicates. PK `reportId` = sha256 of the ordered pair; GSI `byState` (PK `state`, SK
// `stateSk` = `{1000 − ⌊score·1000⌋, 4 digits}#{reportId}`, projection ALL) lists one state by
// descending Übereinstimmungswert. Every write is conditioned on the `revision` it was based on,
// so the Abgleich never undoes a concurrent Verwerfung (Req 11.5). Only identifiers, values,
// reasons and times are stored (Req 12.2).

export const DUPLICATE_REPORTS_PK = 'reportId';
export const DUPLICATE_REPORTS_BY_STATE = 'byState';
export const DUPLICATE_REPORTS_STATE_ATTRIBUTE = 'state';
export const DUPLICATE_REPORTS_STATE_SK_ATTRIBUTE = 'stateSk';

/** Stored Agenturübergreifender_Treffer. */
export interface DuplicateReport {
  reportId: string;
  /** The smaller listing id of the pair. */
  listingA: string;
  listingB: string;
  /** Owning agencies; absent for listings without agency. */
  agencyA?: string;
  agencyB?: string;
  score: number;
  reasons: MatchReason[];
  state: DuplicateReportState;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Duplikat_Abgleich that last found the pair; the ResolvePhase compares it (Req 11.6). */
  lastSweepId: string;
  dismissedAt?: string;
  /** Write counter, set by the store. */
  revision?: number;
}

/** Id of the pair `{a, b}`, independent of the order. */
export function duplicateReportId(a: string, b: string): string {
  const [first, second] = a < b ? [a, b] : [b, a];
  return createHash('sha256').update(`${first}\u0000${second}`, 'utf8').digest('hex');
}

/** GSI sort key: ascending order = descending score, ties by report id. */
export function reportStateSortKey(score: number, reportId: string): string {
  const inverted = 1000 - Math.floor(Math.min(Math.max(score, 0), 1) * 1000);
  return `${String(inverted).padStart(4, '0')}#${reportId}`;
}

const ListingId = z.string().min(LISTING_BOUNDS.id.min).max(LISTING_BOUNDS.id.max);

const ReportSchema: z.ZodType<DuplicateReport> = z.object({
  reportId: z.string().regex(/^[0-9a-f]{64}$/),
  listingA: ListingId,
  listingB: ListingId,
  agencyA: EntityId.optional(),
  agencyB: EntityId.optional(),
  score: z.number().min(0).max(1),
  reasons: z.array(z.enum(MATCH_REASONS)),
  state: z.enum(DUPLICATE_REPORT_STATES),
  firstSeenAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  lastSweepId: z.string().min(1).max(128),
  dismissedAt: IsoDateTime.optional(),
  revision: z.int().min(1).optional(),
}) as z.ZodType<DuplicateReport>;

/** Validates a report; unknown attributes (GSI keys) are stripped. */
export const parseDuplicateReport = (value: unknown): DuplicateReport => ReportSchema.parse(value);

export interface DuplicateReportFilter {
  state: DuplicateReportState;
  /** Only Treffer naming a listing of this agency. */
  agencyId?: string;
}

export interface DuplicateReportStore<Op> {
  /** Strongly consistent; `null` if unknown. */
  get(reportId: string): Promise<DuplicateReport | null>;
  /**
   * Writes `next` (label `duplicateReport.put`) if the stored report still has the revision of
   * `expected` (none stored for `null`); the stored revision becomes `expected.revision + 1`.
   */
  putOp(next: DuplicateReport, expected: DuplicateReport | null): Op;
  /** Removes a report (label `duplicateReport.delete`) if it still has the revision of `expected`. */
  deleteOp(expected: DuplicateReport): Op;
  /** Reports of one state by descending score (ties by id), optionally of one agency. */
  list(filter: DuplicateReportFilter, page: KeyPageRequest): Promise<KeyPage<DuplicateReport>>;
}

const agencyMatches = (report: DuplicateReport, agencyId: string | undefined): boolean =>
  agencyId === undefined || report.agencyA === agencyId || report.agencyB === agencyId;

const withRevision = (next: DuplicateReport, expected: DuplicateReport | null): DuplicateReport =>
  parseDuplicateReport({ ...next, revision: (expected?.revision ?? 0) + 1 });

// ---------------------------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------------------------

export class InMemoryDuplicateReportStore implements DuplicateReportStore<InMemoryOp> {
  private readonly reports = new Map<string, DuplicateReport>();

  async get(reportId: string): Promise<DuplicateReport | null> {
    const report = this.reports.get(reportId);
    return report === undefined ? null : structuredClone(report);
  }

  putOp(next: DuplicateReport, expected: DuplicateReport | null): InMemoryOp {
    const stored = withRevision(next, expected);
    return {
      label: 'duplicateReport.put',
      target: `DuplicateReports#${next.reportId}`,
      check: () => this.reports.get(next.reportId)?.revision === expected?.revision,
      apply: () => {
        this.reports.set(next.reportId, structuredClone(stored));
      },
    };
  }

  deleteOp(expected: DuplicateReport): InMemoryOp {
    return {
      label: 'duplicateReport.delete',
      target: `DuplicateReports#${expected.reportId}`,
      check: () => {
        const current = this.reports.get(expected.reportId);
        return current !== undefined && current.revision === expected.revision;
      },
      apply: () => {
        this.reports.delete(expected.reportId);
      },
    };
  }

  async list(
    filter: DuplicateReportFilter,
    { limit, cursor }: KeyPageRequest,
  ): Promise<KeyPage<DuplicateReport>> {
    let after: string | undefined;
    if (cursor !== undefined) {
      const key = decodeKeyCursor(cursor)[DUPLICATE_REPORTS_STATE_SK_ATTRIBUTE];
      if (typeof key !== 'string') throw new InvalidCursorError();
      after = key;
    }
    const sortKey = (r: DuplicateReport) => reportStateSortKey(r.score, r.reportId);
    const matching = [...this.reports.values()]
      .filter((r) => r.state === filter.state && agencyMatches(r, filter.agencyId))
      .filter((r) => after === undefined || sortKey(r) > after)
      .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
    const items = matching.slice(0, limit).map((r) => structuredClone(r));
    const last = items.at(-1);
    return {
      items,
      ...(last !== undefined &&
        matching.length > limit && {
          nextCursor: encodeKeyCursor({ [DUPLICATE_REPORTS_STATE_SK_ATTRIBUTE]: sortKey(last) }),
        }),
    };
  }

  /** Every stored report, for assertions in tests. */
  all(): DuplicateReport[] {
    return [...this.reports.values()]
      .map((report) => structuredClone(report))
      .sort((a, b) => (a.reportId < b.reportId ? -1 : 1));
  }
}

// ---------------------------------------------------------------------------------------------
// DynamoDB
// ---------------------------------------------------------------------------------------------

export interface DynamoDbDuplicateReportStoreOptions {
  client: DynamoDBDocumentClient;
  /** `DuplicateReports` table; PK `reportId`, GSI `byState`. */
  tableName: string;
}

/** Reads per page: the agency filter is a filter expression, so one page may need several. */
const REPORT_QUERY_BATCH = 100;
const REPORT_QUERY_MAX_REQUESTS = 5;

function revisionCondition(expected: DuplicateReport | null): {
  ConditionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
} {
  if (expected === null) {
    return {
      ConditionExpression: 'attribute_not_exists(#reportId)',
      ExpressionAttributeNames: { '#reportId': DUPLICATE_REPORTS_PK },
    };
  }
  if (expected.revision === undefined) {
    return {
      ConditionExpression: 'attribute_exists(#reportId) AND attribute_not_exists(#revision)',
      ExpressionAttributeNames: { '#reportId': DUPLICATE_REPORTS_PK, '#revision': 'revision' },
    };
  }
  return {
    ConditionExpression: '#revision = :revision',
    ExpressionAttributeNames: { '#revision': 'revision' },
    ExpressionAttributeValues: { ':revision': expected.revision },
  };
}

export class DynamoDbDuplicateReportStore implements DuplicateReportStore<DynamoDbOp> {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor({ client, tableName }: DynamoDbDuplicateReportStoreOptions) {
    this.client = client;
    this.tableName = tableName;
  }

  async get(reportId: string): Promise<DuplicateReport | null> {
    const out = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { [DUPLICATE_REPORTS_PK]: reportId },
        ConsistentRead: true,
      }),
    );
    return out.Item === undefined ? null : parseDuplicateReport(out.Item);
  }

  putOp(next: DuplicateReport, expected: DuplicateReport | null): DynamoDbOp {
    const stored = withRevision(next, expected);
    return {
      label: 'duplicateReport.put',
      item: {
        Put: {
          TableName: this.tableName,
          Item: {
            ...stored,
            [DUPLICATE_REPORTS_STATE_SK_ATTRIBUTE]: reportStateSortKey(
              stored.score,
              stored.reportId,
            ),
          },
          ...revisionCondition(expected),
        },
      },
    };
  }

  deleteOp(expected: DuplicateReport): DynamoDbOp {
    return {
      label: 'duplicateReport.delete',
      item: {
        Delete: {
          TableName: this.tableName,
          Key: { [DUPLICATE_REPORTS_PK]: expected.reportId },
          ...revisionCondition(expected),
        },
      },
    };
  }

  async list(
    filter: DuplicateReportFilter,
    { limit, cursor }: KeyPageRequest,
  ): Promise<KeyPage<DuplicateReport>> {
    let startKey = cursor === undefined ? undefined : decodeKeyCursor(cursor);
    const items: DuplicateReport[] = [];
    const byAgency = filter.agencyId !== undefined;
    for (let request = 0; request < REPORT_QUERY_MAX_REQUESTS; request += 1) {
      const out = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: DUPLICATE_REPORTS_BY_STATE,
          KeyConditionExpression: '#state = :state',
          ...(byAgency && { FilterExpression: '#agencyA = :agency OR #agencyB = :agency' }),
          ExpressionAttributeNames: {
            '#state': DUPLICATE_REPORTS_STATE_ATTRIBUTE,
            ...(byAgency && { '#agencyA': 'agencyA', '#agencyB': 'agencyB' }),
          },
          ExpressionAttributeValues: {
            ':state': filter.state,
            ...(byAgency && { ':agency': filter.agencyId }),
          },
          Limit: REPORT_QUERY_BATCH,
          ...(startKey !== undefined && { ExclusiveStartKey: startKey }),
        }),
      );
      const batch = out.Items ?? [];
      for (const [index, item] of batch.entries()) {
        items.push(parseDuplicateReport(item));
        if (items.length === limit) {
          const more = index < batch.length - 1 || out.LastEvaluatedKey !== undefined;
          return {
            items,
            ...(more && {
              nextCursor: encodeKeyCursor({
                [DUPLICATE_REPORTS_PK]: item[DUPLICATE_REPORTS_PK],
                [DUPLICATE_REPORTS_STATE_ATTRIBUTE]: item[DUPLICATE_REPORTS_STATE_ATTRIBUTE],
                [DUPLICATE_REPORTS_STATE_SK_ATTRIBUTE]: item[DUPLICATE_REPORTS_STATE_SK_ATTRIBUTE],
              }),
            }),
          };
        }
      }
      startKey = out.LastEvaluatedKey;
      if (startKey === undefined) return { items };
    }
    return { items, ...(startKey !== undefined && { nextCursor: encodeKeyCursor(startKey) }) };
  }
}
