import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ListingView,
  LocalizedListing,
  MATCH_REASONS,
  VersionEntry,
  type DuplicateReportView,
  type ListingFlag,
  type Permission,
} from '@open-estate/shared';
import { toListingDetail } from '../src/app/listing/listing-detail-model';
import type { HttpMethod, ManagementRequestOptions } from '../src/app/management/management-client';
import {
  dismissDuplicateReport,
  fetchDuplicateReports,
  getDuplicateDetection,
  setDuplicateDetection,
  startDuplicateSweep,
  type AdminRequester,
} from '../src/app/portal/admin/admin-api';
import {
  disableDuplicateDetectionConfirmation,
  duplicateDetectionSwitched,
  toDuplicateDetectionState,
} from '../src/app/portal/admin/admin-model';
import {
  DEFAULT_REPORT_FILTERS,
  toReportRow,
  validateReportFilters,
} from '../src/app/portal/admin/admin-duplicates-model';
import {
  emptyFormValues,
  fromListingView,
  requestBody,
} from '../src/app/portal/listings/listing-form-model';
import { EMPTY_FILTERS, validateFilters } from '../src/app/portal/listings/listing-table-model';
import {
  activationLines,
  createdAsDuplicate,
  toDuplicateNotice,
} from '../src/app/portal/workspace/duplicate-notice-model';
import { toTimelineItem } from '../src/app/portal/workspace/version-timeline-model';

// Agentur_Portal and Admin_Modus of the Duplikat-Erkennung (duplicate-detection Req 1.7, 8.5,
// 11.7, 13.1–13.5).

const FLAG: ListingFlag = {
  code: 'DUPLICATE',
  updatedAt: '2026-03-01T10:00:00.000Z',
  detectedBy: 'CREATE',
  originalId: 'orig-1',
  matches: [
    { listingId: 'other-2', score: 0.95, reasons: ['SAME_ADDRESS', 'AREA_CLOSE'] },
    { listingId: 'orig-1', score: 0.874, reasons: ['SAME_ADDRESS', 'PRICE_CLOSE'] },
  ],
};

const allowed =
  (...permissions: Permission[]) =>
  (permission: Permission) =>
    permissions.includes(permission);

describe('Duplikat-Hinweis in the workspace (Req 8.5, 13.2)', () => {
  it('names the Original first with value and translated reasons', () => {
    const notice = toDuplicateNotice(
      { flags: [FLAG], status: 'INACTIVE' },
      allowed('listing:status'),
    );
    expect(notice).toEqual({
      originalId: 'orig-1',
      matches: [
        {
          listingId: 'orig-1',
          percent: 87,
          reasonKeys: ['duplicate.reasons.SAME_ADDRESS', 'duplicate.reasons.PRICE_CLOSE'],
        },
        {
          listingId: 'other-2',
          percent: 95,
          reasonKeys: ['duplicate.reasons.SAME_ADDRESS', 'duplicate.reasons.AREA_CLOSE'],
        },
      ],
      detectedBy: 'CREATE',
      updatedAt: '2026-03-01T10:00:00.000Z',
      canActivate: true,
      canDismiss: true,
    });
    // The confirmation lists the Original's reasons (Req 8.5).
    if (notice === undefined) throw new Error('notice missing');
    expect(activationLines(notice)).toEqual([
      { key: 'duplicate.reasons.SAME_ADDRESS', params: {} },
      { key: 'duplicate.reasons.PRICE_CLOSE', params: {} },
    ]);
  });

  it('offers the controls by permission and status', () => {
    const readOnly = toDuplicateNotice({ flags: [FLAG], status: 'INACTIVE' }, allowed());
    expect(readOnly).toMatchObject({ canActivate: false, canDismiss: false });
    // An active listing (flagged by a change or the check) can only be dismissed.
    const active = toDuplicateNotice(
      { flags: [FLAG], status: 'ACTIVE' },
      allowed('listing:status'),
    );
    expect(active).toMatchObject({ canActivate: false, canDismiss: true });
    expect(toDuplicateNotice({ flags: [], status: 'INACTIVE' }, allowed())).toBeUndefined();
  });

  it('recognizes a creation stored as a possible duplicate (Req 13.3)', () => {
    expect(createdAsDuplicate({ flags: [FLAG] })).toBe(true);
    expect(createdAsDuplicate({ flags: [] })).toBe(false);
  });
});

describe('version history (Req 13.4)', () => {
  const entry = (statusReason?: { code: 'DUPLICATE'; originalId: string }) =>
    VersionEntry.parse({
      version: 1,
      changeType: 'CREATE',
      channel: 'PORTAL',
      actor: { kind: 'user', userId: 'u', displayName: 'Mia' },
      createdAt: '2026-03-01T10:00:00.000Z',
      status: 'INACTIVE',
      changedPaths: [],
      ...(statusReason !== undefined && { statusReason }),
    });

  it('marks the automatic deactivation with the Original', () => {
    expect(toTimelineItem(entry({ code: 'DUPLICATE', originalId: 'orig-1' }), 1)).toMatchObject({
      autoDeactivated: { originalId: 'orig-1' },
    });
    expect(toTimelineItem(entry(), 1).autoDeactivated).toBeUndefined();
  });

  it('shows the system actor of the duplicate check', () => {
    const item = toTimelineItem(
      VersionEntry.parse({
        ...entry(),
        actor: { kind: 'system', job: 'duplicate-sweep', runId: 'scheduled-1' },
      }),
      1,
    );
    expect(item.actor).toEqual({
      kindKey: 'portal.workspace.actorKind.system',
      name: 'duplicate-sweep',
      runId: 'scheduled-1',
    });
  });
});

describe('listing overview (Req 13.1)', () => {
  it('filters by Markierungscode', () => {
    expect(validateFilters({ ...EMPTY_FILTERS, flag: 'DUPLICATE' })).toEqual({
      ok: true,
      query: { flag: 'DUPLICATE' },
    });
    expect(validateFilters({ ...EMPTY_FILTERS, flag: 'NOPE' })).toEqual({
      ok: false,
      errors: [{ field: 'flag', messageKey: 'portal.listings.error.invalid' }],
    });
  });
});

describe('Objektmerkmale in the portal form and the detail view (Req 1.7, 2.7)', () => {
  // API representation as delivered (amounts and areas as decimal strings).
  const view = {
    id: 'l-1',
    content: {
      originalLocale: 'de',
      title: 'Altbau',
      description: '',
      translations: [],
      offers: [{ offerType: 'SALE', price: '350000.00', currency: 'EUR' }],
      listingType: 'apartment_unit',
      rooms: 3,
      area: '90.00',
      address: { city: 'Berlin', postalCode: '10115', country: 'DE', unit: 'Whg 3' },
      sourceUrl: 'https://portal.example.org/listings/l-1',
      media: [],
      tours: [],
      floor: 2,
      totalFloors: 5,
      yearBuilt: 1910,
      plotArea: '420.50',
    },
    status: 'INACTIVE',
    origin: 'MANUAL',
    version: 1,
    updatedAt: '2026-03-01T10:00:00.000Z',
    fieldSources: {},
    sourceUrlDerived: true,
    source: 'agency:a',
    lastImportedAt: '2026-03-01T10:00:00.000Z',
    lastRunId: 'PORTAL#1',
    createdAt: '2026-03-01T10:00:00.000Z',
    flags: [],
  } satisfies ListingView;

  it('loads stored merkmale into the form and sends them back unchanged', () => {
    expect(ListingView.safeParse(view).success).toBe(true);
    const { values, context } = fromListingView(view);
    expect(values.attributes).toEqual({
      unit: 'Whg 3',
      floor: '2',
      totalFloors: '5',
      yearBuilt: '1910',
      plotArea: '420.50',
      bedrooms: '',
      bathrooms: '',
      parcelId: '',
    });
    const body = requestBody(values, context) as { content: Record<string, unknown> };
    expect(body.content).toMatchObject({
      floor: 2,
      totalFloors: 5,
      yearBuilt: 1910,
      plotArea: '420.50',
      address: { unit: 'Whg 3' },
    });
    expect(body.content).not.toHaveProperty('bedrooms');
    expect(emptyFormValues().attributes.floor).toBe('');
  });

  it('shows every stored merkmal with a translated label in the public detail view', () => {
    const { translations: _unused, ...content } = view.content;
    void _unused;
    const listing: LocalizedListing = {
      ...content,
      id: 'l-1',
      source: 'agency:a',
      lastImportedAt: '2026-03-01T10:00:00.000Z',
      lastRunId: 'PORTAL#1',
      deliveredLocale: 'de',
      bedrooms: 2,
      parcelId: 'Flur 3/17',
    };
    expect(LocalizedListing.safeParse(listing).success).toBe(true);
    const detail = toListingDetail(listing, 'de');
    const rows = detail.sections.flatMap((s) => s.rows);
    expect(rows.find((r) => r.key === 'listing.attributes.unit')?.text).toBe('Whg 3');
    const property = detail.sections.find((s) => s.key === 'detail.property');
    expect(property?.rows.map((r) => r.key)).toEqual([
      'listing.attributes.floor',
      'listing.attributes.totalFloors',
      'listing.attributes.yearBuilt',
      'listing.attributes.plotArea',
      'listing.attributes.bedrooms',
      'listing.attributes.parcelId',
    ]);
    expect(property?.rows.find((r) => r.key === 'listing.attributes.yearBuilt')?.text).toBe('1910');
    expect(property?.rows.find((r) => r.key === 'listing.attributes.plotArea')).toMatchObject({
      textKey: 'detail.areaValue',
      params: { value: '420,5' },
    });
  });
});

describe('Admin_Modus „Duplikate“ (Req 11.3, 11.5, 11.7)', () => {
  const report: DuplicateReportView = {
    reportId: 'a'.repeat(64),
    listingA: 'l-1',
    listingB: 'l-2',
    agencyA: 'agy-a',
    score: 0.912,
    reasons: ['SAME_ADDRESS'],
    state: 'OPEN',
    firstSeenAt: '2026-03-01T03:00:00.000Z',
    lastSeenAt: '2026-03-02T03:00:00.000Z',
  };

  it('shows both listings with their agencies, value, reasons and state', () => {
    const row = toReportRow(report, 'en');
    expect(row).toMatchObject({
      reportId: report.reportId,
      listings: [{ listingId: 'l-1', agencyId: 'agy-a' }, { listingId: 'l-2' }],
      percent: 91,
      reasonKeys: ['duplicate.reasons.SAME_ADDRESS'],
      stateKey: 'portal.duplicates.state.OPEN',
      canDismiss: true,
    });
    expect(toReportRow({ ...report, state: 'DISMISSED' }, 'en').canDismiss).toBe(false);
  });

  it('validates the filters with the API schema', () => {
    expect(validateReportFilters(DEFAULT_REPORT_FILTERS)).toEqual({
      ok: true,
      query: { state: 'OPEN' },
    });
    expect(validateReportFilters({ state: 'RESOLVED', agencyId: ' agy-a ' })).toEqual({
      ok: true,
      query: { state: 'RESOLVED', agencyId: 'agy-a' },
    });
    expect(validateReportFilters({ state: 'OPEN', agencyId: 'x'.repeat(300) })).toMatchObject({
      ok: false,
    });
  });

  it('calls the platform routes', async () => {
    const calls: { method: HttpMethod; path: string; query?: unknown }[] = [];
    const api = (body: unknown): AdminRequester => ({
      request<T>(method: HttpMethod, path: string, options?: ManagementRequestOptions<T>) {
        calls.push({ method, path, query: options?.query });
        const value = options?.parse ? options.parse(body) : (body as T);
        return Promise.resolve({ ok: true as const, value });
      },
    });
    const page = await fetchDuplicateReports(api({ items: [report] }), {
      query: { state: 'OPEN', agencyId: 'agy-a' },
      pageToken: 't1',
    });
    expect(page.ok && page.value.items).toEqual([report]);
    await dismissDuplicateReport(api({ ...report, state: 'DISMISSED' }), report.reportId);
    const sweep = await startDuplicateSweep(
      api({ executionName: 'manual-1', alreadyRunning: false }),
    );
    expect(sweep.ok && sweep.value.executionName).toBe('manual-1');
    expect(calls).toEqual([
      {
        method: 'GET',
        path: '/platform/duplicate-reports',
        query: { state: 'OPEN', agencyId: 'agy-a', pageToken: 't1' },
      },
      {
        method: 'POST',
        path: `/platform/duplicate-reports/${report.reportId}/dismiss`,
        query: undefined,
      },
      { method: 'POST', path: '/platform/duplicate-sweeps', query: undefined },
    ]);
  });
});

describe('Ein/Aus of the Duplikat-Erkennung in the operations view', () => {
  it('shows the state and offers the opposite change', () => {
    expect(toDuplicateDetectionState({ enabled: true })).toEqual({
      enabled: true,
      statusKey: 'portal.admin.ops.duplicates.on',
      actionKey: 'portal.admin.ops.duplicates.disable',
    });
    expect(toDuplicateDetectionState({ enabled: false })).toMatchObject({
      statusKey: 'portal.admin.ops.duplicates.off',
      actionKey: 'portal.admin.ops.duplicates.enable',
    });
  });

  it('reports the started duplicate check after switching on', () => {
    expect(
      duplicateDetectionSwitched({
        enabled: true,
        sweep: { executionName: 'manual-1', alreadyRunning: false },
      }),
    ).toEqual({ key: 'portal.admin.ops.duplicates.switchedOn', params: { name: 'manual-1' } });
    expect(duplicateDetectionSwitched({ enabled: true }).key).toBe(
      'portal.admin.ops.duplicates.switchedOnNoSweep',
    );
    expect(duplicateDetectionSwitched({ enabled: false }).key).toBe(
      'portal.admin.ops.duplicates.switchedOff',
    );
  });

  it('asks before switching off and says what stays', () => {
    const c = disableDuplicateDetectionConfirmation();
    expect(c.action).toBe('disableDuplicateDetection');
    expect(c.lines.map((line) => line.key)).toEqual([
      'portal.admin.ops.duplicates.offEffect',
      'portal.admin.ops.duplicates.offKeeps',
    ]);
  });

  it('reads and sets the switch through the platform route', async () => {
    const calls: { method: HttpMethod; path: string; body?: unknown }[] = [];
    const api = (answer: unknown): AdminRequester => ({
      request<T>(method: HttpMethod, path: string, options?: ManagementRequestOptions<T>) {
        calls.push({ method, path, body: options?.body });
        const value = options?.parse ? options.parse(answer) : (answer as T);
        return Promise.resolve({ ok: true as const, value });
      },
    });
    const read = await getDuplicateDetection(api({ enabled: false }));
    expect(read.ok && read.value).toEqual({ enabled: false });
    const set = await setDuplicateDetection(
      api({ enabled: true, sweep: { executionName: 'manual-2', alreadyRunning: true } }),
      true,
    );
    expect(set.ok && set.value.sweep?.alreadyRunning).toBe(true);
    expect(calls).toEqual([
      { method: 'GET', path: '/platform/duplicate-detection', body: undefined },
      { method: 'PUT', path: '/platform/duplicate-detection', body: { enabled: true } },
    ]);
  });
});

describe('translations (Req 13.5)', () => {
  const texts = (locale: string) =>
    JSON.parse(readFileSync(join(__dirname, `../public/i18n/${locale}.json`), 'utf8')) as Record<
      string,
      string
    >;

  it.each(['de', 'en'])('%s names every Übereinstimmungsgrund and Objektmerkmal', (locale) => {
    const t = texts(locale);
    for (const reason of MATCH_REASONS) expect(t[`duplicate.reasons.${reason}`]).toBeTruthy();
    for (const field of [
      'unit',
      'floor',
      'totalFloors',
      'yearBuilt',
      'plotArea',
      'bedrooms',
      'bathrooms',
      'parcelId',
    ]) {
      expect(t[`listing.attributes.${field}`]).toBeTruthy();
    }
    for (const detected of ['CREATE', 'UPDATE', 'SWEEP']) {
      expect(t[`portal.duplicates.notice.detected.${detected}`]).toBeTruthy();
    }
    for (const state of ['OPEN', 'DISMISSED', 'RESOLVED']) {
      expect(t[`portal.duplicates.state.${state}`]).toBeTruthy();
    }
  });

  it.each(['de', 'en'])('%s has every text of the Ein/Aus switch', (locale) => {
    const t = texts(locale);
    const state = [true, false].map((enabled) => toDuplicateDetectionState({ enabled }));
    const confirm = disableDuplicateDetectionConfirmation();
    for (const key of [
      'portal.admin.ops.duplicates.title',
      'portal.admin.ops.duplicates.hint',
      'portal.admin.ops.duplicates.offNote',
      ...state.flatMap((s) => [s.statusKey, s.actionKey]),
      ...[{ enabled: false }, { enabled: true }].map((v) => duplicateDetectionSwitched(v).key),
      duplicateDetectionSwitched({
        enabled: true,
        sweep: { executionName: 'x', alreadyRunning: false },
      }).key,
      confirm.title.key,
      confirm.confirmKey,
      ...confirm.lines.map((line) => line.key),
      'portal.duplicates.admin.disabled',
      'portal.duplicates.admin.disabledLink',
      'portal.error.code.DUPLICATE_DETECTION_DISABLED',
    ]) {
      expect([key, t[key]]).toEqual([key, expect.any(String)]);
    }
  });
});
