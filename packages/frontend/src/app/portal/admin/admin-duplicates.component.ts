import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import type { DuplicateReportView } from '@open-estate/shared';
import { LocaleService } from '../../locale/locale.service';
import { ManagementApiClient } from '../../management/management-api-client.service';
import {
  currentToken,
  FIRST_PAGE,
  nextPage,
  previousPage,
  type Pager,
} from '../listings/listing-table-model';
import { ConfirmDialogComponent } from '../shared/confirm-dialog/confirm-dialog.component';
import {
  dismissDuplicateReport,
  fetchDuplicateReports,
  getDuplicateDetection,
  startDuplicateSweep,
  type DuplicateReportQuery,
} from './admin-api';
import {
  DEFAULT_REPORT_FILTERS,
  REPORT_STATES,
  toReportRow,
  validateReportFilters,
  type ReportFilterValues,
  type ReportRow,
} from './admin-duplicates-model';
import { ADMIN_STYLES } from './admin-styles';

/**
 * `/portal/admin/duplicates` (duplicate-detection Req 10.2, 11.3, 11.5, 11.7): Agenturübergreifende
 * Treffer by descending value with filters by state and agency, links to both listings (the
 * Admin_Modus reads every agency), dismissal after a confirmation, and the manual start of the
 * Duplikat_Abgleich.
 */
@Component({
  selector: 'oe-admin-duplicates',
  imports: [ConfirmDialogComponent, RouterLink, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="glass card" aria-labelledby="admin-duplicates-title">
      <div class="head">
        <h1 id="admin-duplicates-title" class="label">
          {{ 'portal.admin.duplicates' | transloco }}
        </h1>
        <button
          type="button"
          class="pill"
          [disabled]="sweepBusy() || detectionEnabled() === false"
          (click)="startSweep()"
        >
          {{ 'portal.duplicates.sweep.start' | transloco }}
        </button>
      </div>
      <p class="note">{{ 'portal.duplicates.admin.intro' | transloco }}</p>
      @if (detectionEnabled() === false) {
        <p class="error" role="status">
          {{ 'portal.duplicates.admin.disabled' | transloco }}
          <a routerLink="/portal/admin/operations">{{
            'portal.duplicates.admin.disabledLink' | transloco
          }}</a>
        </p>
      }
      @if (sweepMessage(); as m) {
        <p class="success" role="status">{{ m.key | transloco: { name: m.name } }}</p>
      }
      <form class="inline" (submit)="apply($event)" novalidate>
        <label class="field">
          <span>{{ 'portal.duplicates.filter.state' | transloco }}</span>
          <select name="state" [value]="filters().state" (change)="setState($event)">
            @for (state of states; track state) {
              <option [value]="state" [selected]="filters().state === state">
                {{ 'portal.duplicates.state.' + state | transloco }}
              </option>
            }
          </select>
        </label>
        <label class="field">
          <span>{{ 'portal.duplicates.filter.agency' | transloco }}</span>
          <input
            name="agencyId"
            [value]="filters().agencyId"
            [attr.aria-invalid]="filterError() ? 'true' : null"
            [attr.aria-describedby]="filterError() ? 'admin-duplicates-error' : null"
            (input)="setAgency($event)"
          />
        </label>
        <button type="submit" class="pill primary">
          {{ 'portal.listings.filter.apply' | transloco }}
        </button>
        <button type="button" class="pill" (click)="reset()">
          {{ 'portal.listings.filter.reset' | transloco }}
        </button>
      </form>
      <p id="admin-duplicates-error" class="error" role="alert">
        @if (filterError(); as key) {
          {{ key | transloco }}
        }
      </p>
      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
      <div class="scroll" [attr.aria-busy]="loading()">
        <table>
          <caption class="visually-hidden">
            {{
              'portal.admin.duplicates' | transloco
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col">{{ 'portal.duplicates.column.listings' | transloco }}</th>
              <th scope="col">{{ 'portal.duplicates.column.score' | transloco }}</th>
              <th scope="col">{{ 'portal.duplicates.column.reasons' | transloco }}</th>
              <th scope="col">{{ 'portal.duplicates.column.state' | transloco }}</th>
              <th scope="col">{{ 'portal.duplicates.column.seen' | transloco }}</th>
              <th scope="col">
                <span class="visually-hidden">{{
                  'portal.listings.column.actions' | transloco
                }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track row.reportId) {
              <tr>
                <td>
                  <ul class="pair">
                    @for (side of row.listings; track side.listingId) {
                      <li>
                        <a [routerLink]="['/portal/listings', side.listingId]">{{
                          side.listingId
                        }}</a>
                        @if (side.agencyId) {
                          <a
                            class="agency"
                            [routerLink]="['/portal/admin/agencies', side.agencyId]"
                            >{{ side.agencyId }}</a
                          >
                        } @else {
                          <span class="note">{{ 'portal.admin.noAgency' | transloco }}</span>
                        }
                      </li>
                    }
                  </ul>
                </td>
                <td>
                  {{ 'portal.duplicates.notice.score' | transloco: { percent: row.percent } }}
                </td>
                <td>
                  @for (key of row.reasonKeys; track key; let last = $last) {
                    {{ key | transloco }}{{ last ? '' : ', ' }}
                  }
                </td>
                <td>{{ row.stateKey | transloco }}</td>
                <td>
                  <time [attr.datetime]="row.lastSeenAt">{{ row.lastSeen }}</time>
                  <span class="note">
                    {{ 'portal.duplicates.firstSeen' | transloco: { time: row.firstSeen } }}
                  </span>
                </td>
                <td>
                  @if (row.canDismiss) {
                    <button type="button" class="pill" (click)="dismissing.set(row)">
                      {{ 'portal.duplicates.admin.dismiss' | transloco }}
                    </button>
                  }
                </td>
              </tr>
            } @empty {
              @if (!loading() && !error()) {
                <tr>
                  <td colspan="6" class="note">
                    {{ 'portal.duplicates.admin.empty' | transloco }}
                  </td>
                </tr>
              }
            }
          </tbody>
        </table>
        @if (loading()) {
          <p class="note" role="status">{{ 'portal.admin.loading' | transloco }}</p>
        }
      </div>
      <nav class="pager" [attr.aria-label]="'portal.listings.pagination' | transloco">
        <button
          type="button"
          class="pill"
          [disabled]="pager().index === 0 || loading()"
          (click)="load(previous(pager()))"
        >
          {{ 'portal.listings.previous' | transloco }}
        </button>
        <span>{{ 'portal.listings.page' | transloco: { page: pager().index + 1 } }}</span>
        <button
          type="button"
          class="pill"
          [disabled]="nextToken() === undefined || loading()"
          (click)="goNext()"
        >
          {{ 'portal.listings.next' | transloco }}
        </button>
      </nav>
    </section>
    @if (dismissing(); as row) {
      <oe-confirm-dialog
        titleKey="portal.duplicates.admin.dismissTitle"
        introKey="portal.duplicates.admin.dismissIntro"
        confirmKey="portal.duplicates.admin.dismiss"
        cancelKey="portal.duplicates.activate.cancel"
        loadingKey="portal.admin.loading"
        [params]="{ a: row.listings[0]?.listingId ?? '', b: row.listings[1]?.listingId ?? '' }"
        [state]="{ kind: 'ready', impact: [] }"
        [busy]="dismissBusy()"
        [errorMessage]="dismissError()"
        (confirm)="confirmDismiss()"
        (cancel)="dismissing.set(undefined)"
      />
    }
  `,
  styles: [
    ADMIN_STYLES,
    `
      .pair {
        display: grid;
        gap: 0.25rem;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .agency {
        margin-left: 0.5rem;
        font-size: 0.9rem;
      }
    `,
  ],
})
export class AdminDuplicatesComponent implements OnInit {
  private readonly api = inject(ManagementApiClient);
  private readonly locale = inject(LocaleService);

  protected readonly states = REPORT_STATES;
  protected readonly previous = previousPage;

  protected readonly filters = signal<ReportFilterValues>({ ...DEFAULT_REPORT_FILTERS });
  protected readonly filterError = signal<string | undefined>(undefined);
  private readonly reports = signal<readonly DuplicateReportView[]>([]);
  protected readonly pager = signal<Pager>(FIRST_PAGE);
  protected readonly nextToken = signal<string | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | undefined>(undefined);

  protected readonly dismissing = signal<ReportRow | undefined>(undefined);
  protected readonly dismissBusy = signal(false);
  protected readonly dismissError = signal<string | undefined>(undefined);

  protected readonly sweepBusy = signal(false);
  /** Ein/Aus of the Duplikat-Erkennung; `undefined` until known (or unreadable). */
  protected readonly detectionEnabled = signal<boolean | undefined>(undefined);
  protected readonly sweepMessage = signal<{ key: string; name: string } | undefined>(undefined);

  protected readonly rows = computed(() => {
    const locale = this.locale.active();
    return this.reports().map((report) => toReportRow(report, locale));
  });

  private query: DuplicateReportQuery = { state: DEFAULT_REPORT_FILTERS.state };
  private controller: AbortController | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.controller?.abort());
  }

  ngOnInit(): void {
    void this.load(FIRST_PAGE);
    void this.loadDetection();
  }

  /** Switched off, no check runs and the Treffer are not updated (design: "Ein- und Ausschalten"). */
  private async loadDetection(): Promise<void> {
    const result = await getDuplicateDetection(this.api);
    if (result.ok) this.detectionEnabled.set(result.value.enabled);
  }

  protected setState(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    const state = REPORT_STATES.find((s) => s === value) ?? DEFAULT_REPORT_FILTERS.state;
    this.filters.update((f) => ({ ...f, state }));
  }

  protected setAgency(event: Event): void {
    const agencyId = (event.target as HTMLInputElement).value;
    this.filters.update((f) => ({ ...f, agencyId }));
  }

  protected apply(event: Event): void {
    event.preventDefault();
    const result = validateReportFilters(this.filters());
    if (!result.ok) {
      this.filterError.set(result.messageKey);
      return;
    }
    this.filterError.set(undefined);
    this.query = result.query;
    void this.load(FIRST_PAGE);
  }

  protected reset(): void {
    this.filters.set({ ...DEFAULT_REPORT_FILTERS });
    this.filterError.set(undefined);
    this.query = { state: DEFAULT_REPORT_FILTERS.state };
    void this.load(FIRST_PAGE);
  }

  protected goNext(): void {
    const token = this.nextToken();
    if (token !== undefined) void this.load(nextPage(this.pager(), token));
  }

  protected async load(pager: Pager): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.loading.set(true);
    this.error.set(undefined);
    const token = currentToken(pager);
    const result = await fetchDuplicateReports(this.api, {
      query: this.query,
      ...(token !== undefined && { pageToken: token }),
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    this.loading.set(false);
    if (!result.ok) {
      this.error.set(this.api.errorMessage(result.error));
      return;
    }
    this.pager.set(pager);
    this.reports.set(result.value.items);
    this.nextToken.set(result.value.nextPageToken);
  }

  /** Dismisses the Treffer (Req 11.5); the list shows the current page again. */
  protected async confirmDismiss(): Promise<void> {
    const row = this.dismissing();
    if (!row || this.dismissBusy()) return;
    this.dismissBusy.set(true);
    this.dismissError.set(undefined);
    const result = await dismissDuplicateReport(this.api, row.reportId);
    this.dismissBusy.set(false);
    if (!result.ok) {
      this.dismissError.set(this.api.errorMessage(result.error));
      return;
    }
    this.dismissing.set(undefined);
    void this.load(this.pager());
  }

  /** `POST /platform/duplicate-sweeps` (Req 10.2): started, or the running one. */
  protected async startSweep(): Promise<void> {
    this.sweepBusy.set(true);
    this.sweepMessage.set(undefined);
    const result = await startDuplicateSweep(this.api);
    this.sweepBusy.set(false);
    if (!result.ok) {
      this.error.set(this.api.errorMessage(result.error));
      return;
    }
    this.sweepMessage.set({
      key: result.value.alreadyRunning
        ? 'portal.duplicates.sweep.running'
        : 'portal.duplicates.sweep.started',
      name: result.value.executionName,
    });
  }
}
