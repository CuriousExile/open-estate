import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { AGENCY_STATES, LISTING_STATUSES } from '@open-estate/shared';
import { LocaleService } from '../../locale/locale.service';
import { ManagementApiClient } from '../../management/management-api-client.service';
import {
  currentToken,
  FIRST_PAGE,
  formatTimestamp,
  nextPage,
  previousPage,
  type Pager,
} from '../listings/listing-table-model';
import { formatMetricValue } from '../shared/metric-chart/metric-chart-model';
import { createAgency, listAgencies } from './admin-api';
import { toAgencyRow, validateAgencyName, type AgencyRow } from './admin-model';
import { ADMIN_STYLES } from './admin-styles';

/**
 * `/portal/admin/agencies` (Req 10.3): every agency with display name, state, members, listings
 * per Listing_Status and last change; state filter, paging and creation of an agency (Req 1.4).
 */
@Component({
  selector: 'oe-admin-agencies',
  imports: [RouterLink, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="glass card" aria-labelledby="admin-agencies-title">
      <div class="head">
        <h1 id="admin-agencies-title" class="label">{{ 'portal.admin.agencies' | transloco }}</h1>
        <label class="field">
          <span>{{ 'portal.admin.agencyView.state' | transloco }}</span>
          <select [value]="stateFilter()" (change)="setState($event)">
            <option value="">{{ 'portal.admin.any' | transloco }}</option>
            @for (state of states; track state) {
              <option [value]="state">{{ 'portal.admin.agencyState.' + state | transloco }}</option>
            }
          </select>
        </label>
      </div>

      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
      <div class="scroll" [attr.aria-busy]="loading()">
        <table>
          <caption class="visually-hidden">
            {{
              'portal.admin.agencies' | transloco
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col">{{ 'portal.admin.agencyView.name' | transloco }}</th>
              <th scope="col">{{ 'portal.admin.agencyView.state' | transloco }}</th>
              <th scope="col" class="num">{{ 'portal.admin.agencyView.members' | transloco }}</th>
              @for (status of statuses; track status) {
                <th scope="col" class="num">
                  {{ 'portal.listings.status.' + status | transloco }}
                </th>
              }
              <th scope="col">{{ 'portal.admin.agencyView.lastChange' | transloco }}</th>
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track row.agencyId) {
              <tr>
                <th scope="row">
                  <a [routerLink]="row.agencyId">{{ row.displayName }}</a>
                </th>
                <td>
                  <span class="badge" [class.suspended]="row.suspended">{{
                    'portal.admin.agencyState.' + row.state | transloco
                  }}</span>
                </td>
                <td class="num">{{ count(row.memberCount) }}</td>
                @for (status of statuses; track status) {
                  <td class="num">{{ count(row.listingCounts[status]) }}</td>
                }
                <td>
                  @if (row.lastChangedAt) {
                    <time [attr.datetime]="row.lastChangedAt">{{
                      timestamp(row.lastChangedAt)
                    }}</time>
                  } @else {
                    {{ 'portal.admin.never' | transloco }}
                  }
                </td>
              </tr>
            } @empty {
              @if (!loading() && !error()) {
                <tr>
                  <td colspan="6" class="note">
                    {{ 'portal.admin.agencyView.empty' | transloco }}
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

    <section class="glass card" aria-labelledby="admin-agency-create">
      <h2 id="admin-agency-create">{{ 'portal.admin.agencyView.create' | transloco }}</h2>
      <form class="inline" (submit)="create($event)" novalidate>
        <label class="field">
          <span>{{ 'portal.admin.agencyView.name' | transloco }}</span>
          <input
            name="displayName"
            [value]="newName()"
            [attr.aria-invalid]="createError() ? 'true' : null"
            aria-describedby="admin-agency-create-error"
            (input)="newName.set(value($event))"
          />
        </label>
        <button type="submit" class="pill primary" [disabled]="creating()">
          {{ 'portal.admin.agencyView.createAction' | transloco }}
        </button>
      </form>
      <p id="admin-agency-create-error" class="error" role="alert">{{ createError() ?? '' }}</p>
    </section>
  `,
  styles: [ADMIN_STYLES],
})
export class AdminAgenciesComponent {
  private readonly api = inject(ManagementApiClient);
  private readonly locale = inject(LocaleService);
  private readonly router = inject(Router);
  private readonly transloco = inject(TranslocoService);

  protected readonly states = AGENCY_STATES;
  protected readonly statuses = LISTING_STATUSES;
  protected readonly previous = previousPage;

  protected readonly stateFilter = signal('');
  protected readonly pager = signal<Pager>(FIRST_PAGE);
  protected readonly nextToken = signal<string | undefined>(undefined);
  protected readonly rows = signal<readonly AgencyRow[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | undefined>(undefined);

  protected readonly newName = signal('');
  protected readonly creating = signal(false);
  protected readonly createError = signal<string | undefined>(undefined);

  private controller: AbortController | undefined;
  private readonly destroyed = new AbortController();

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.controller?.abort();
      this.destroyed.abort();
    });
    void this.load(FIRST_PAGE);
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected count(value: number): string {
    return formatMetricValue(value, 'count', this.locale.active());
  }

  protected timestamp(iso: string): string {
    return formatTimestamp(iso, this.locale.active());
  }

  protected setState(event: Event): void {
    this.stateFilter.set((event.target as HTMLSelectElement).value);
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
    const state = this.stateFilter();
    const result = await listAgencies(this.api, {
      ...(state !== '' && { state }),
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
    this.rows.set(result.value.items.map(toAgencyRow));
    this.nextToken.set(result.value.nextPageToken);
  }

  protected async create(event: Event): Promise<void> {
    event.preventDefault();
    const name = validateAgencyName(this.newName());
    if (!name.ok) {
      this.createError.set(this.transloco.translate(name.messageKey, name.params));
      return;
    }
    this.creating.set(true);
    this.createError.set(undefined);
    const result = await createAgency(this.api, name.value, { signal: this.destroyed.signal });
    this.creating.set(false);
    if (!result.ok) {
      // The name stays in the form (Req 5.9).
      this.createError.set(this.api.errorMessage(result.error));
      return;
    }
    this.newName.set('');
    await this.router.navigate(['/portal/admin/agencies', result.value.agencyId]);
  }
}
