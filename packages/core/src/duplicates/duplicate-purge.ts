import type { MetricCounterStore } from '../management/metric-counter-store';
import type { Transactor } from '../management/transaction';
import type { DuplicateIndexStore } from './duplicate-index-store';
import type { DuplicateReportStore } from './duplicate-report-store';
import { purgeListingReports } from './duplicate-sweep';
import type { IdempotencyStore } from './idempotency-store';

// Deletion of the Duplikat-Erkennung's data of one listing (duplicate-detection Req 12.3): its
// Agenturübergreifende_Treffer, the Duplikat_Index entries and the Idempotenzschlüssel records.
// Run by the deletion workflow next to the removal of the version history; the request counts as
// executed only when all are complete. Markierungen and Verwerfungen of *other* listings that name
// the deleted id are renewed by the Duplikat_Abgleich (Req 12.4).

export interface DuplicateDataPurge {
  /** Idempotent; `complete` = nothing of the listing is left. */
  purge(listingId: string): Promise<{ complete: boolean }>;
}

export interface DuplicateDataPurgeDeps<Op> {
  index: Pick<DuplicateIndexStore<Op>, 'purgeListing' | 'reportRefs' | 'deleteReportRef'>;
  idempotency: Pick<IdempotencyStore<Op>, 'purgeListing'>;
  /** Treffer with the `duplicate.cross_agency_open` counter, removed in one transaction each. */
  reports: Pick<DuplicateReportStore<Op>, 'get' | 'deleteOp'>;
  counters: Pick<MetricCounterStore<Op>, 'addOp'>;
  transactor: Transactor<Op>;
}

export function duplicateDataPurge<Op>(deps: DuplicateDataPurgeDeps<Op>): DuplicateDataPurge {
  return {
    async purge(listingId) {
      // Treffer first: their Verweise live in the listing's index partition.
      const reports = await purgeListingReports(deps, listingId);
      const [index, idempotency] = await Promise.all([
        reports.complete ? deps.index.purgeListing(listingId) : { complete: false },
        deps.idempotency.purgeListing(listingId),
      ]);
      return { complete: reports.complete && index.complete && idempotency.complete };
    },
  };
}
