import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
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
import {
  actorDisplay,
  channelKey,
  EMPTY_AUDIT_FILTERS,
  fetchAuditLog,
  isFailureResult,
  validateAuditFilters,
  type AuditFilterError,
  type AuditFilterField,
  type AuditQuery,
  type AuditRecord,
} from './audit-model';

/**
 * `/portal/audit` (Req 11.4, 11.5): the agency's Audit_Log, newest first, with filters by actor,
 * action and period (UTC days) and token paging. Read-only — entries cannot be changed (Req 11.3).
 */
@Component({
  selector: 'oe-audit-log',
  imports: [ReactiveFormsModule, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="glass panel" aria-labelledby="audit-title">
      <h1 id="audit-title" class="label">{{ 'portal.audit.title' | transloco }}</h1>
      <p class="muted">{{ 'portal.audit.hint' | transloco }}</p>

      <form
        class="filters"
        [formGroup]="filters"
        (ngSubmit)="applyFilters()"
        novalidate
        [attr.aria-label]="'portal.audit.filter.label' | transloco"
      >
        <div class="field">
          <label for="audit-actor">{{ 'portal.audit.filter.actor' | transloco }}</label>
          <input
            id="audit-actor"
            formControlName="actor"
            [attr.aria-invalid]="invalid('actor')"
            [attr.aria-describedby]="describedBy('actor')"
          />
        </div>
        <div class="field">
          <label for="audit-action">{{ 'portal.audit.filter.action' | transloco }}</label>
          <input
            id="audit-action"
            formControlName="action"
            [attr.aria-invalid]="invalid('action')"
            [attr.aria-describedby]="describedBy('action')"
          />
        </div>
        <div class="field">
          <label for="audit-from">{{ 'portal.audit.filter.from' | transloco }}</label>
          <input
            id="audit-from"
            type="date"
            formControlName="from"
            [attr.aria-invalid]="invalid('from')"
            [attr.aria-describedby]="describedBy('from')"
          />
        </div>
        <div class="field">
          <label for="audit-to">{{ 'portal.audit.filter.to' | transloco }}</label>
          <input
            id="audit-to"
            type="date"
            formControlName="to"
            [attr.aria-invalid]="invalid('to')"
            [attr.aria-describedby]="describedBy('to')"
          />
        </div>
        <div class="actions">
          <button type="submit" class="pill primary">
            {{ 'portal.audit.filter.apply' | transloco }}
          </button>
          <button type="button" class="pill" (click)="resetFilters()">
            {{ 'portal.audit.filter.reset' | transloco }}
          </button>
        </div>
        @if (filterErrors().length > 0) {
          <ul class="errors" role="alert">
            @for (error of filterErrors(); track error.field) {
              <li [id]="'audit-error-' + error.field">
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
            {{ 'portal.audit.retry' | transloco }}
          </button>
        </div>
      }

      <div class="table-wrap" [attr.aria-busy]="loading()">
        <table>
          <caption class="visually-hidden">
            {{
              'portal.audit.caption' | transloco
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col">{{ 'portal.audit.column.timestamp' | transloco }}</th>
              <th scope="col">{{ 'portal.audit.column.actor' | transloco }}</th>
              <th scope="col">{{ 'portal.audit.column.channel' | transloco }}</th>
              <th scope="col">{{ 'portal.audit.column.action' | transloco }}</th>
              <th scope="col">{{ 'portal.audit.column.target' | transloco }}</th>
              <th scope="col">{{ 'portal.audit.column.result' | transloco }}</th>
            </tr>
          </thead>
          <tbody>
            @for (entry of entries(); track entry.id) {
              <tr>
                <td>
                  <time [attr.datetime]="entry.timestamp">{{ timestamp(entry.timestamp) }}</time>
                </td>
                <td>
                  @if (actor(entry); as a) {
                    <span class="muted">{{ a.kindKey | transloco }}</span>
                    {{ a.name }}
                    @if (a.id !== undefined) {
                      <code class="id">{{ a.id }}</code>
                    }
                  } @else {
                    <span class="muted">{{ 'portal.audit.unknownActor' | transloco }}</span>
                  }
                </td>
                <td>
                  @if (entry.channel; as channel) {
                    {{ channelKey(channel) | transloco }}
                  }
                </td>
                <td>
                  <code>{{ entry.action }}</code>
                </td>
                <td>
                  <code>{{ entry.target }}</code>
                </td>
                <td>
                  <span class="badge" [class.failure]="failure(entry.result)">{{
                    entry.result
                  }}</span>
                </td>
              </tr>
            } @empty {
              @if (!loading() && errorText() === undefined) {
                <tr>
                  <td colspan="6" class="muted">{{ 'portal.audit.empty' | transloco }}</td>
                </tr>
              }
            }
          </tbody>
        </table>
        @if (loading()) {
          <p class="muted" role="status">{{ 'portal.audit.loading' | transloco }}</p>
        }
      </div>

      <nav class="pager" [attr.aria-label]="'portal.audit.pagination' | transloco">
        <button
          type="button"
          class="pill"
          [disabled]="pager().index === 0 || loading()"
          (click)="goTo(previous(pager()))"
        >
          {{ 'portal.audit.previous' | transloco }}
        </button>
        <span>{{ 'portal.audit.page' | transloco: { page: pager().index + 1 } }}</span>
        <button
          type="button"
          class="pill"
          [disabled]="nextToken() === undefined || loading()"
          (click)="goNext()"
        >
          {{ 'portal.audit.next' | transloco }}
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
    h1,
    p {
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
    label,
    .muted {
      color: var(--color-text-muted);
    }
    input {
      padding: 0.45rem 0.75rem;
      border: 1px solid var(--color-surface-border);
      border-radius: 0.75rem;
      background: var(--color-surface);
      color: inherit;
      font: inherit;
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
    .errors {
      flex-basis: 100%;
      margin: 0;
      padding-left: 1.25rem;
    }
    .errors,
    .notice.error {
      color: var(--color-error);
    }
    .notice {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 1rem;
    }
    .pill {
      display: inline-block;
      padding: 0.4rem 1.1rem;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-pill);
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    .pill.primary {
      border-color: transparent;
      background: var(--brand-secondary);
      color: var(--color-on-accent);
    }
    .pill:disabled {
      opacity: 0.5;
      cursor: default;
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
      vertical-align: top;
    }
    thead th {
      color: var(--color-text-muted);
      font-weight: 600;
    }
    code {
      font-size: 0.8rem;
      word-break: break-all;
    }
    .id {
      display: block;
      color: var(--color-text-muted);
    }
    .badge {
      padding: 0.15rem 0.6rem;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-pill);
      white-space: nowrap;
    }
    .badge.failure {
      border-color: var(--color-error);
      color: var(--color-error);
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
export class AuditLogComponent {
  private readonly api = inject(ManagementApiClient);
  private readonly locale = inject(LocaleService);

  protected readonly previous = previousPage;
  protected readonly actor = (entry: AuditRecord) => actorDisplay(entry.actor);
  protected readonly channelKey = channelKey;
  protected readonly failure = isFailureResult;

  protected readonly filters = inject(NonNullableFormBuilder).group({ ...EMPTY_AUDIT_FILTERS });
  protected readonly filterErrors = signal<readonly AuditFilterError[]>([]);
  private readonly errorFields = computed(() => new Set(this.filterErrors().map((e) => e.field)));

  protected readonly entries = signal<readonly AuditRecord[]>([]);
  protected readonly nextToken = signal<string | undefined>(undefined);
  protected readonly pager = signal<Pager>(FIRST_PAGE);
  protected readonly loading = signal(false);
  protected readonly errorText = signal<string | undefined>(undefined);

  /** Filters of the shown entries; changed only by a valid submit or reset. */
  private query: AuditQuery = {};
  private controller: AbortController | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.controller?.abort());
    void this.load(FIRST_PAGE);
  }

  protected applyFilters(): void {
    const result = validateAuditFilters(this.filters.getRawValue());
    if (!result.ok) {
      this.filterErrors.set(result.errors);
      return;
    }
    this.filterErrors.set([]);
    this.query = result.query;
    void this.load(FIRST_PAGE);
  }

  protected resetFilters(): void {
    this.filters.reset({ ...EMPTY_AUDIT_FILTERS });
    this.filterErrors.set([]);
    this.query = {};
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

  protected invalid(field: AuditFilterField): 'true' | null {
    return this.errorFields().has(field) ? 'true' : null;
  }

  protected describedBy(field: AuditFilterField): string | null {
    return this.errorFields().has(field) ? `audit-error-${field}` : null;
  }

  private async load(pager: Pager): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.loading.set(true);
    this.errorText.set(undefined);
    const token = currentToken(pager);
    const result = await fetchAuditLog(this.api, this.query, {
      ...(token !== undefined && { pageToken: token }),
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    this.loading.set(false);
    if (!result.ok) {
      this.errorText.set(this.api.errorMessage(result.error));
      return;
    }
    this.pager.set(pager);
    this.entries.set(result.value.items);
    this.nextToken.set(result.value.nextPageToken);
  }
}
