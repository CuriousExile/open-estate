// Framework-free model of the Admin_Modus view of Agenturübergreifender_Treffer (duplicate-detection
// design: AdminDuplicatesComponent; Req 11.3, 11.5, 11.7). Kept free of Angular imports so it can
// be unit-tested with plain Jest.
import {
  DUPLICATE_REPORT_STATES,
  DuplicateReportsQuery,
  type DuplicateReportState,
  type DuplicateReportView,
} from '@open-estate/shared';
import { formatTimestamp } from '../listings/listing-table-model';
import { reasonKey, scorePercent } from '../workspace/duplicate-notice-model';
import type { DuplicateReportQuery } from './admin-api';

export const REPORT_STATES = DUPLICATE_REPORT_STATES;

/** Filter inputs as typed. */
export interface ReportFilterValues {
  state: DuplicateReportState;
  agencyId: string;
}

/** The view opens with the open Treffer of all agencies. */
export const DEFAULT_REPORT_FILTERS: ReportFilterValues = { state: 'OPEN', agencyId: '' };

/** Validates the filters with the API's query schema. */
export function validateReportFilters(
  values: ReportFilterValues,
):
  { ok: true; query: DuplicateReportQuery } | { ok: false; field: 'agencyId'; messageKey: string } {
  const agencyId = values.agencyId.trim();
  const query: DuplicateReportQuery = {
    state: values.state,
    ...(agencyId !== '' && { agencyId }),
  };
  return DuplicateReportsQuery.safeParse(query).success
    ? { ok: true, query }
    : { ok: false, field: 'agencyId', messageKey: 'portal.admin.error.invalid' };
}

/** One row: both listings with their agencies, value, reasons, times and state. */
export interface ReportRow {
  readonly reportId: string;
  readonly listings: readonly { readonly listingId: string; readonly agencyId?: string }[];
  readonly percent: number;
  readonly reasonKeys: readonly string[];
  readonly stateKey: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly lastSeenAt: string;
  /** Every Treffer not yet dismissed can be dismissed (Req 11.5). */
  readonly canDismiss: boolean;
}

export function toReportRow(report: DuplicateReportView, locale: string): ReportRow {
  const side = (listingId: string, agencyId: string | undefined) => ({
    listingId,
    ...(agencyId !== undefined && { agencyId }),
  });
  return {
    reportId: report.reportId,
    listings: [side(report.listingA, report.agencyA), side(report.listingB, report.agencyB)],
    percent: scorePercent(report.score),
    reasonKeys: report.reasons.map(reasonKey),
    stateKey: `portal.duplicates.state.${report.state}`,
    firstSeen: formatTimestamp(report.firstSeenAt, locale),
    lastSeen: formatTimestamp(report.lastSeenAt, locale),
    lastSeenAt: report.lastSeenAt,
    canDismiss: report.state !== 'DISMISSED',
  };
}
