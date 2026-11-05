import type { ConnectorRunView, RunRejectionView } from '@open-estate/shared';
import type { ConnectorRunWriter } from './connector-run-store';
import {
  encodeKeyCursor,
  decodeKeyCursor,
  InvalidCursorError,
  type KeyPage,
  type KeyPageRequest,
} from './key-page';

// Read side of `ConnectorRuns` / `RunRejections` (design: "DynamoDB-Tabellen", Req 13.2, 13.3,
// 14.3). The persisting `RunLogger` writes both tables through `ConnectorRunWriter`;
// `DynamoDbConnectorRunStore` (connector-run-store.ts) implements reader and writer.

/** Ergebnisstatus of a failed Connector_Lauf (the ingestion `RunStatus`). */
export const CONNECTOR_RUN_FAILURE_STATUS = 'FAILURE';

/** A run with Ergebnisstatus `Fehler` or with rejected Import_Datensätze (Req 13.6). */
export const isProblemRun = (run: Pick<ConnectorRunView, 'status' | 'rejected'>): boolean =>
  run.status === CONNECTOR_RUN_FAILURE_STATUS || run.rejected > 0;

/** Filters of the run overview; all given filters must match. */
export interface ConnectorRunFilter {
  /** Owning agency (GSI `byAgency`); absent = all agencies (platform admin only). */
  agencyId?: string;
  connectorId?: string;
  status?: string;
  /** `startedAt ≥ from` (ISO-8601). */
  from: string;
  /** `startedAt ≤ to` (ISO-8601). */
  to: string;
  /** Only runs with {@link isProblemRun}. */
  problemsOnly?: boolean;
}

/** Rejections of one run plus the run's agency, so the caller can check access (Req 2.6). */
export interface RunRejectionPage extends KeyPage<RunRejectionView> {
  /** Agency of the run; absent for runs without agency. */
  agencyId?: string;
}

export interface ConnectorRunReader {
  /**
   * Runs matching `filter`, newest `startedAt` first. Implementation hint (6.7): with `agencyId`
   * `Query` on GSI `byAgency`, with `connectorId` `Query` on the table, otherwise a `Scan`; the
   * period goes into the key condition (SK `startedAt#runId`). A page may hold fewer than `limit`
   * items although `nextCursor` is set. Throws `InvalidCursorError`.
   */
  query(
    filter: ConnectorRunFilter,
    page: KeyPageRequest,
    signal?: AbortSignal,
  ): Promise<KeyPage<ConnectorRunView>>;
  /**
   * Rejections of `runId` in `seq` order; `null` if the run is unknown (or expired). The run's
   * `agencyId` must be resolvable from `RunRejections` alone (e.g. stored on every item).
   */
  rejections(
    runId: string,
    page: KeyPageRequest,
    signal?: AbortSignal,
  ): Promise<RunRejectionPage | null>;
}

/** Number-indexed cursor of the fake (`{offset}`). */
function offsetOf(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const { offset } = decodeKeyCursor(cursor);
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    throw new InvalidCursorError();
  }
  return offset;
}

function pageOf<T>(items: T[], { limit, cursor }: KeyPageRequest): KeyPage<T> {
  const offset = offsetOf(cursor);
  const end = offset + limit;
  return {
    items: items.slice(offset, end),
    ...(end < items.length && { nextCursor: encodeKeyCursor({ offset: end }) }),
  };
}

export const matchesConnectorRunFilter = (
  run: ConnectorRunView,
  filter: ConnectorRunFilter,
): boolean =>
  (filter.agencyId === undefined || run.agencyId === filter.agencyId) &&
  (filter.connectorId === undefined || run.connectorId === filter.connectorId) &&
  (filter.status === undefined || run.status === filter.status) &&
  Date.parse(run.startedAt) >= Date.parse(filter.from) &&
  Date.parse(run.startedAt) <= Date.parse(filter.to) &&
  (filter.problemsOnly !== true || isProblemRun(run));

/** Fake for tests and local runs; also the write side of the persisting `RunLogger` in tests. */
export class InMemoryConnectorRunStore implements ConnectorRunReader, ConnectorRunWriter {
  private readonly runs = new Map<string, ConnectorRunView>();
  private readonly rejected = new Map<string, RunRejectionView[]>();

  async record(run: ConnectorRunView, rejections: readonly RunRejectionView[]): Promise<void> {
    this.putRun(run);
    this.rejected.set(run.runId, []);
    rejections.forEach((rejection) => this.addRejection(run.runId, rejection));
  }

  /** Stores or replaces the summary of a run. */
  putRun(run: ConnectorRunView): void {
    this.runs.set(run.runId, { ...run });
  }

  /** Appends one rejection to an existing run. */
  addRejection(runId: string, rejection: RunRejectionView): void {
    if (!this.runs.has(runId)) throw new Error(`Unknown run ${runId}`);
    this.rejected.set(runId, [...(this.rejected.get(runId) ?? []), { ...rejection }]);
  }

  async query(
    filter: ConnectorRunFilter,
    page: KeyPageRequest,
  ): Promise<KeyPage<ConnectorRunView>> {
    const matching = [...this.runs.values()]
      .filter((run) => matchesConnectorRunFilter(run, filter))
      .sort(
        (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || (a.runId < b.runId ? -1 : 1),
      );
    return pageOf(matching, page);
  }

  async rejections(runId: string, page: KeyPageRequest): Promise<RunRejectionPage | null> {
    const run = this.runs.get(runId);
    if (run === undefined) return null;
    return {
      ...pageOf(this.rejected.get(runId) ?? [], page),
      ...(run.agencyId !== undefined && { agencyId: run.agencyId }),
    };
  }
}
