import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
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
import { fetchAuditLog, type AuditPageValue } from './admin-api';
import {
  actorText,
  EMPTY_AUDIT_FILTERS,
  validateAuditFilters,
  type AuditFilterValues,
  type AuditQuery,
} from './admin-model';
import { ADMIN_STYLES } from './admin-styles';

const FIELDS = ['actor', 'agencyId', 'action', 'from', 'to'] as const;

/**
 * `/portal/admin/audit` (Req 11.4): the platform-wide Audit_Log, newest first, paged, with
 * filters by actor, agency (initially from `?agencyId=`), action and period.
 */
@Component({
  selector: 'oe-admin-audit',
  imports: [RouterLink, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="glass card" aria-labelledby="admin-audit-title">
      <h1 id="admin-audit-title" class="label">{{ 'portal.admin.audit' | transloco }}</h1>
      <form class="inline" (submit)="apply($event)" novalidate>
        @for (field of fields; track field) {
          <label class="field">
            <span>{{ 'portal.admin.auditLog.filter.' + field | transloco }}</span>
            <input
              [type]="field === 'from' || field === 'to' ? 'date' : 'text'"
              [name]="field"
              [value]="filters()[field]"
              [attr.aria-invalid]="filterError()?.field === field ? 'true' : null"
              [attr.aria-describedby]="filterError()?.field === field ? 'admin-audit-error' : null"
              (input)="setFilter(field, $event)"
            />
          </label>
        }
        <button type="submit" class="pill primary">
          {{ 'portal.listings.filter.apply' | transloco }}
        </button>
        <button type="button" class="pill" (click)="reset()">
          {{ 'portal.listings.filter.reset' | transloco }}
        </button>
      </form>
      <p id="admin-audit-error" class="error" role="alert">
        @if (filterError(); as e) {
          {{ e.messageKey | transloco }}
        }
      </p>
      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
      <div class="scroll" [attr.aria-busy]="loading()">
        <table>
          <caption class="visually-hidden">
            {{
              'portal.admin.audit' | transloco
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col">{{ 'portal.admin.auditLog.time' | transloco }}</th>
              <th scope="col">{{ 'portal.admin.auditLog.filter.actor' | transloco }}</th>
              <th scope="col">{{ 'portal.admin.auditLog.channel' | transloco }}</th>
              <th scope="col">{{ 'portal.admin.auditLog.filter.action' | transloco }}</th>
              <th scope="col">{{ 'portal.admin.auditLog.target' | transloco }}</th>
              <th scope="col">{{ 'portal.admin.auditLog.filter.agencyId' | transloco }}</th>
              <th scope="col">{{ 'portal.admin.auditLog.result' | transloco }}</th>
            </tr>
          </thead>
          <tbody>
            @for (entry of rows(); track entry.id) {
              <tr>
                <td>
                  <time [attr.datetime]="entry.timestamp">{{ entry.time }}</time>
                </td>
                <td>{{ entry.actor.kindKey | transloco }} {{ entry.actor.name }}</td>
                <td>
                  @if (entry.channel) {
                    {{ 'portal.monitoring.channel.' + entry.channel | transloco }}
                  }
                </td>
                <td>
                  <code>{{ entry.action }}</code>
                </td>
                <td>
                  <code>{{ entry.target }}</code>
                </td>
                <td>
                  @if (entry.agencyId) {
                    <a [routerLink]="['/portal/admin/agencies', entry.agencyId]">{{
                      entry.agencyId
                    }}</a>
                  }
                </td>
                <td>{{ entry.result }}</td>
              </tr>
            } @empty {
              @if (!loading() && !error()) {
                <tr>
                  <td colspan="7" class="note">{{ 'portal.admin.auditLog.empty' | transloco }}</td>
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
  `,
  styles: [ADMIN_STYLES],
})
export class AdminAuditComponent implements OnInit {
  private readonly api = inject(ManagementApiClient);
  private readonly locale = inject(LocaleService);
  private readonly route = inject(ActivatedRoute);

  protected readonly fields = FIELDS;
  protected readonly previous = previousPage;

  protected readonly filters = signal<AuditFilterValues>({ ...EMPTY_AUDIT_FILTERS });
  protected readonly filterError = signal<
    { field: keyof AuditFilterValues; messageKey: string } | undefined
  >(undefined);
  private readonly entries = signal<AuditPageValue['items']>([]);
  protected readonly pager = signal<Pager>(FIRST_PAGE);
  protected readonly nextToken = signal<string | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | undefined>(undefined);

  protected readonly rows = computed(() => {
    const locale = this.locale.active();
    return this.entries().map((entry) => ({
      ...entry,
      time: formatTimestamp(entry.timestamp, locale),
      actor: actorText(entry.actor),
    }));
  });

  private query: AuditQuery = {};
  private controller: AbortController | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.controller?.abort());
  }

  ngOnInit(): void {
    const agencyId = this.route.snapshot.queryParamMap.get('agencyId') ?? '';
    if (agencyId !== '') {
      this.filters.update((f) => ({ ...f, agencyId }));
      const result = validateAuditFilters(this.filters());
      if (result.ok) this.query = result.query;
    }
    void this.load(FIRST_PAGE);
  }

  protected setFilter(field: keyof AuditFilterValues, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.filters.update((f) => ({ ...f, [field]: value }));
  }

  protected apply(event: Event): void {
    event.preventDefault();
    const result = validateAuditFilters(this.filters());
    if (!result.ok) {
      this.filterError.set({ field: result.field, messageKey: result.messageKey });
      return;
    }
    this.filterError.set(undefined);
    this.query = result.query;
    void this.load(FIRST_PAGE);
  }

  protected reset(): void {
    this.filters.set({ ...EMPTY_AUDIT_FILTERS });
    this.filterError.set(undefined);
    this.query = {};
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
    const result = await fetchAuditLog(this.api, {
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
    this.entries.set(result.value.items);
    this.nextToken.set(result.value.nextPageToken);
  }
}
