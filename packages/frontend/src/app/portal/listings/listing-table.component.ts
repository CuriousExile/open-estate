import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  signal,
  type OnInit,
} from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  LISTING_STATUSES,
  ListingPage,
  OFFER_TYPES,
  ORIGINS,
  type ListingSummary,
} from '@open-estate/shared';
import { PortalSession } from '../../auth/portal-session.service';
import { CodeLabelPipe } from '../../locale/code-label.pipe';
import { LocaleService } from '../../locale/locale.service';
import { ManagementApiClient } from '../../management/management-api-client.service';
import { StartupState } from '../../startup/startup-state';
import { CodeOptionsPipe } from '../../ui/select/code-options.pipe';
import { SelectComponent } from '../../ui/select/select.component';
import {
  currentToken,
  EMPTY_FILTERS,
  FIRST_PAGE,
  formatTimestamp,
  nextPage,
  previousPage,
  validateAgencyFilter,
  validateFilters,
  type FilterError,
  type ListingFilterField,
  type ListingQuery,
  type Pager,
} from './listing-table-model';

/**
 * `/portal/listings`: the agency's listings with title, status, origin, Custom_Id, offer types,
 * listing type and last change, filters of Req 4.14 and paging (Req 5.2). Create/edit controls
 * only with `listing:write` (Req 5.6).
 */
@Component({
  selector: 'oe-listing-table',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    TranslocoPipe,
    CodeLabelPipe,
    CodeOptionsPipe,
    SelectComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="glass panel" aria-labelledby="listings-title">
      <header class="head">
        <h1 id="listings-title" class="label">{{ 'portal.listings.title' | transloco }}</h1>
        @if (session.can('listing:write')) {
          <a class="pill primary" routerLink="/portal/listings/new">{{
            'portal.listings.new' | transloco
          }}</a>
        }
      </header>

      <form
        class="filters"
        [formGroup]="filters"
        (ngSubmit)="applyFilters()"
        novalidate
        [attr.aria-label]="'portal.listings.filter.label' | transloco"
      >
        @if (agencyFilter()) {
          <div class="field">
            <label for="filter-agencyId">{{ 'portal.admin.listingsAgency' | transloco }}</label>
            <input
              id="filter-agencyId"
              [value]="agencyInput()"
              [attr.aria-invalid]="agencyError() ? 'true' : null"
              [attr.aria-describedby]="agencyError() ? 'filter-error-agencyId' : null"
              (input)="agencyInput.set(inputValue($event))"
            />
          </div>
        }
        <div class="field wide">
          <label for="filter-q">{{ 'portal.listings.filter.q' | transloco }}</label>
          <input
            id="filter-q"
            type="search"
            formControlName="q"
            [attr.aria-invalid]="invalid('q')"
            [attr.aria-describedby]="describedBy('q')"
          />
        </div>
        <div class="field">
          <label for="filter-status">{{ 'portal.field.status' | transloco }}</label>
          <oe-select
            variant="field"
            triggerId="filter-status"
            formControlName="status"
            [label]="'portal.field.status' | transloco"
            [options]="
              statuses
                | codeOptions
                  : 'portal.listings.status.'
                  : activeLocale()
                  : 'portal.listings.filter.any'
            "
          />
        </div>
        <div class="field">
          <label for="filter-origin">{{ 'portal.listings.column.origin' | transloco }}</label>
          <oe-select
            variant="field"
            triggerId="filter-origin"
            formControlName="origin"
            [label]="'portal.listings.column.origin' | transloco"
            [options]="
              origins
                | codeOptions
                  : 'portal.listings.origin.'
                  : activeLocale()
                  : 'portal.listings.filter.any'
            "
          />
        </div>
        <div class="field">
          <label for="filter-offerType">{{ 'portal.field.offerType' | transloco }}</label>
          <oe-select
            variant="field"
            triggerId="filter-offerType"
            formControlName="offerType"
            [label]="'portal.field.offerType' | transloco"
            [options]="
              offerTypes | codeOptions: 'offerType.' : activeLocale() : 'portal.listings.filter.any'
            "
          />
        </div>
        <div class="field">
          <label for="filter-listingType">{{ 'portal.field.listingType' | transloco }}</label>
          @if (taxonomy; as taxonomy) {
            <select id="filter-listingType" formControlName="listingType">
              <option value="">{{ 'portal.listings.filter.any' | transloco }}</option>
              @for (group of taxonomy.groups; track group.code) {
                <optgroup [label]="group.code | codeLabel: 'taxonomy.group' | transloco">
                  @for (type of group.types; track type) {
                    <option [value]="type">
                      {{ type | codeLabel: 'taxonomy.type' | transloco }}
                    </option>
                  }
                </optgroup>
              }
            </select>
          } @else {
            <input
              id="filter-listingType"
              formControlName="listingType"
              [attr.aria-invalid]="invalid('listingType')"
              [attr.aria-describedby]="describedBy('listingType')"
            />
          }
        </div>
        <div class="field">
          <label for="filter-customId">{{ 'portal.field.customId' | transloco }}</label>
          <input
            id="filter-customId"
            formControlName="customId"
            [attr.aria-invalid]="invalid('customId')"
            [attr.aria-describedby]="describedBy('customId')"
          />
        </div>
        <div class="actions">
          <button type="submit" class="pill primary">
            {{ 'portal.listings.filter.apply' | transloco }}
          </button>
          <button type="button" class="pill" (click)="resetFilters()">
            {{ 'portal.listings.filter.reset' | transloco }}
          </button>
        </div>
        @if (filterErrors().length > 0 || agencyError()) {
          <ul class="errors" role="alert">
            @if (agencyError(); as key) {
              <li id="filter-error-agencyId">{{ key | transloco }}</li>
            }
            @for (error of filterErrors(); track error.field) {
              <li [id]="'filter-error-' + error.field">
                {{ error.messageKey | transloco: error.params ?? {} }}
              </li>
            }
          </ul>
        }
      </form>

      @if (errorText(); as message) {
        <div class="notice error" role="alert">
          <p>{{ message }}</p>
          <button type="button" class="pill" (click)="reload()">
            {{ 'portal.listings.retry' | transloco }}
          </button>
        </div>
      }

      <div class="table-wrap" [attr.aria-busy]="loading()">
        <table>
          <caption class="visually-hidden">
            {{
              'portal.listings.caption' | transloco
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col">{{ 'portal.field.title' | transloco }}</th>
              @if (agencyFilter()) {
                <th scope="col">{{ 'portal.admin.listingsAgency' | transloco }}</th>
              }
              <th scope="col">{{ 'portal.field.status' | transloco }}</th>
              <th scope="col">{{ 'portal.listings.column.origin' | transloco }}</th>
              <th scope="col">{{ 'portal.field.customId' | transloco }}</th>
              <th scope="col">{{ 'portal.field.offers' | transloco }}</th>
              <th scope="col">{{ 'portal.field.listingType' | transloco }}</th>
              <th scope="col">{{ 'portal.listings.column.updatedAt' | transloco }}</th>
              @if (session.can('listing:write')) {
                <th scope="col">
                  <span class="visually-hidden">{{
                    'portal.listings.column.actions' | transloco
                  }}</span>
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track row.id) {
              <tr>
                <th scope="row">
                  <a [routerLink]="['/portal/listings', row.id]">{{ row.title }}</a>
                </th>
                @if (agencyFilter()) {
                  <td>
                    @if (row.agencyId) {
                      <a [routerLink]="['/portal/admin/agencies', row.agencyId]">{{
                        row.agencyId
                      }}</a>
                    } @else {
                      {{ 'portal.admin.noAgency' | transloco }}
                    }
                  </td>
                }
                <td>
                  <span class="badge" [class.active]="row.status === 'ACTIVE'">
                    {{ 'portal.listings.status.' + row.status | transloco }}
                  </span>
                </td>
                <td>{{ 'portal.listings.origin.' + row.origin | transloco }}</td>
                <td>{{ row.customId ?? '' }}</td>
                <td>
                  @for (type of row.offerTypes; track type; let last = $last) {
                    {{ type | codeLabel: 'offerType' | transloco }}{{ last ? '' : ', ' }}
                  }
                </td>
                <td>{{ row.listingType | codeLabel: 'taxonomy.type' | transloco }}</td>
                <td>
                  <time [attr.datetime]="row.updatedAt">{{ timestamp(row.updatedAt) }}</time>
                </td>
                @if (session.can('listing:write')) {
                  <td>
                    <a
                      [routerLink]="['/portal/listings', row.id, 'edit']"
                      [attr.aria-label]="
                        'portal.listings.editNamed' | transloco: { title: row.title }
                      "
                      >{{ 'portal.listings.editAction' | transloco }}</a
                    >
                  </td>
                }
              </tr>
            } @empty {
              @if (!loading() && errorText() === undefined) {
                <tr>
                  <td [attr.colspan]="agencyFilter() ? 9 : 8" class="empty">
                    {{ 'portal.listings.empty' | transloco }}
                  </td>
                </tr>
              }
            }
          </tbody>
        </table>
        @if (loading()) {
          <p class="status" role="status">{{ 'portal.listings.loading' | transloco }}</p>
        }
      </div>

      <nav class="pager" [attr.aria-label]="'portal.listings.pagination' | transloco">
        <button
          type="button"
          class="pill"
          [disabled]="pager().index === 0 || loading()"
          (click)="goTo(previous(pager()))"
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
  `,
  styles: `
    .panel {
      display: grid;
      gap: 1.25rem;
      padding: 1.25rem 1.5rem;
    }
    .head {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
    }
    h1 {
      margin: 0;
    }
    .filters {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 0.75rem 1rem;
    }
    .field {
      display: grid;
      gap: 0.25rem;
      flex: 1 1 10rem;
      font-size: 0.875rem;
    }
    .field.wide {
      flex-basis: 16rem;
    }
    label {
      color: var(--color-text-muted);
    }
    input,
    select {
      padding: 0.45rem 0.75rem;
      border: 1px solid var(--color-surface-border);
      border-radius: 0.75rem;
      background: var(--color-surface);
      color: inherit;
      font: inherit;
    }
    option,
    optgroup {
      color: var(--color-on-accent);
    }
    [aria-invalid='true'] {
      border-color: var(--color-error);
    }
    .actions,
    .pager {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .pager {
      justify-content: flex-end;
    }
    .pill {
      display: inline-block;
      padding: 0.4rem 1.1rem;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-pill);
      background: transparent;
      color: inherit;
      font: inherit;
      text-decoration: none;
      cursor: pointer;
    }
    .pill.primary {
      border-color: transparent;
      background: var(--color-accent);
      color: var(--color-on-accent);
    }
    .pill:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .errors,
    .notice.error {
      color: var(--color-error);
    }
    .errors {
      flex-basis: 100%;
      margin: 0;
      padding-left: 1.25rem;
    }
    .notice {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 1rem;
    }
    .notice p {
      margin: 0;
    }
    .table-wrap {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }
    th,
    td {
      padding: 0.6rem 0.75rem;
      border-bottom: 1px solid var(--color-surface-border);
      text-align: left;
    }
    thead th {
      color: var(--color-text-muted);
      font-weight: 600;
    }
    tbody th {
      font-weight: 500;
    }
    a {
      color: var(--color-accent);
    }
    .badge {
      padding: 0.15rem 0.6rem;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-pill);
      color: var(--color-text-muted);
    }
    .badge.active {
      border-color: transparent;
      background: var(--color-accent);
      color: var(--color-on-accent);
    }
    .empty,
    .status {
      color: var(--color-text-muted);
    }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `,
})
export class ListingTableComponent implements OnInit {
  /**
   * Admin_Modus (route data, Req 10.4): cross-agency overview with an agency filter (initially
   * from `?agencyId=`) and an agency column.
   */
  readonly agencyFilter = input(false);
  private readonly route = inject(ActivatedRoute);
  protected readonly agencyInput = signal('');
  protected readonly agencyError = signal<string | undefined>(undefined);

  private readonly api = inject(ManagementApiClient);
  private readonly locale = inject(LocaleService);
  protected readonly session = inject(PortalSession);

  protected readonly taxonomy = inject(StartupState).meta().taxonomy;
  protected readonly statuses = LISTING_STATUSES;
  protected readonly origins = ORIGINS;
  protected readonly offerTypes = OFFER_TYPES;
  protected readonly activeLocale = this.locale.active;
  protected readonly previous = previousPage;

  protected readonly filters = inject(NonNullableFormBuilder).group({ ...EMPTY_FILTERS });
  protected readonly filterErrors = signal<readonly FilterError[]>([]);
  private readonly errorFields = computed(() => new Set(this.filterErrors().map((e) => e.field)));

  protected readonly rows = signal<readonly ListingSummary[]>([]);
  protected readonly nextToken = signal<string | undefined>(undefined);
  protected readonly pager = signal<Pager>(FIRST_PAGE);
  protected readonly loading = signal(false);
  protected readonly errorText = signal<string | undefined>(undefined);

  /** Filters of the shown list; changed only by a valid submit or reset. */
  private query: ListingQuery = {};
  /** Agency filter of the shown list (Admin_Modus only). */
  private agencyId: string | undefined;
  private controller: AbortController | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.controller?.abort());
  }

  /** First load after the inputs are bound, so the Admin_Modus starts with its agency filter. */
  ngOnInit(): void {
    if (this.agencyFilter()) {
      const agency = validateAgencyFilter(this.route.snapshot.queryParamMap.get('agencyId') ?? '');
      if (agency.ok && agency.agencyId !== undefined) {
        this.agencyInput.set(agency.agencyId);
        this.agencyId = agency.agencyId;
      }
    }
    void this.load(FIRST_PAGE);
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected applyFilters(): void {
    const result = validateFilters(this.filters.getRawValue());
    const agency = this.agencyFilter()
      ? validateAgencyFilter(this.agencyInput())
      : ({ ok: true, agencyId: undefined } as const);
    this.agencyError.set(agency.ok ? undefined : agency.messageKey);
    if (!result.ok) {
      this.filterErrors.set(result.errors);
      return;
    }
    this.filterErrors.set([]);
    if (!agency.ok) return;
    this.query = result.query;
    this.agencyId = agency.agencyId;
    void this.load(FIRST_PAGE);
  }

  protected resetFilters(): void {
    this.filters.reset({ ...EMPTY_FILTERS });
    this.filterErrors.set([]);
    this.agencyInput.set('');
    this.agencyError.set(undefined);
    this.query = {};
    this.agencyId = undefined;
    void this.load(FIRST_PAGE);
  }

  protected goNext(): void {
    const token = this.nextToken();
    if (token !== undefined) void this.load(nextPage(this.pager(), token));
  }

  protected goTo(pager: Pager): void {
    void this.load(pager);
  }

  protected reload(): void {
    void this.load(this.pager());
  }

  protected timestamp(iso: string): string {
    return formatTimestamp(iso, this.locale.active());
  }

  protected invalid(field: ListingFilterField): 'true' | null {
    return this.errorFields().has(field) ? 'true' : null;
  }

  protected describedBy(field: ListingFilterField): string | null {
    return this.errorFields().has(field) ? `filter-error-${field}` : null;
  }

  private async load(pager: Pager): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.loading.set(true);
    this.errorText.set(undefined);
    const token = currentToken(pager);
    const result = await this.api.get('/listings', {
      query: {
        ...this.query,
        ...(this.agencyId !== undefined && { agencyId: this.agencyId }),
        ...(token !== undefined && { pageToken: token }),
      },
      signal: controller.signal,
      parse: (value) => ListingPage.parse(value),
    });
    if (controller.signal.aborted) return;
    this.loading.set(false);
    if (!result.ok) {
      // Rows and filters stay as they were (Req 5.9).
      this.errorText.set(this.api.errorMessage(result.error));
      return;
    }
    this.pager.set(pager);
    this.rows.set(result.value.items);
    this.nextToken.set(result.value.nextPageToken);
  }
}
