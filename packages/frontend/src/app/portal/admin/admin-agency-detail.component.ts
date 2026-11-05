import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { CHANNELS, LISTING_STATUSES } from '@open-estate/shared';
import { LocaleService } from '../../locale/locale.service';
import { ManagementApiClient } from '../../management/management-api-client.service';
import { formatTimestamp } from '../listings/listing-table-model';
import { summarizeOverview, type OverviewSummary } from '../monitoring/agency-monitoring-model';
import { formatMetricValue } from '../shared/metric-chart/metric-chart-model';
import {
  fetchAgencyOverview,
  getAgency,
  previewSuspension,
  updateAgency,
  type AgencyValue,
} from './admin-api';
import { confirmation, validateAgencyName, type Confirmation } from './admin-model';
import { ADMIN_STYLES } from './admin-styles';
import { ConfirmDialogComponent } from './confirm-dialog.component';

type Loadable<T> =
  { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string };

/**
 * `/portal/admin/agencies/:id` (Req 1.8, 1.9, 10.2, 10.8): agency details and figures, rename,
 * suspend (after a confirmation with the affected listings and users from `dryRun`) and
 * reactivate, plus links to the agency's listings and audit entries.
 */
@Component({
  selector: 'oe-admin-agency-detail',
  imports: [ConfirmDialogComponent, RouterLink, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p>
      <a routerLink="/portal/admin/agencies">{{ 'portal.admin.agencyView.back' | transloco }}</a>
    </p>
    @switch (agency().status) {
      @case ('loading') {
        <p class="note" role="status">{{ 'portal.admin.loading' | transloco }}</p>
      }
      @case ('error') {
        <p class="error" role="alert">{{ errorOf(agency()) }}</p>
      }
      @default {
        @if (agencyValue(); as a) {
          <section class="glass card" aria-labelledby="admin-agency-title">
            <div class="head">
              <h1 id="admin-agency-title" class="label">{{ a.displayName }}</h1>
              <span class="badge" [class.suspended]="a.state === 'SUSPENDED'">{{
                'portal.admin.agencyState.' + a.state | transloco
              }}</span>
            </div>
            <dl class="facts">
              <div>
                <dt>{{ 'portal.admin.agencyView.id' | transloco }}</dt>
                <dd>
                  <code>{{ a.agencyId }}</code>
                </dd>
              </div>
              <div>
                <dt>{{ 'portal.admin.agencyView.created' | transloco }}</dt>
                <dd>{{ timestamp(a.createdAt) }}</dd>
              </div>
            </dl>
            <ul class="subnav">
              <li>
                <a routerLink="/portal/admin/listings" [queryParams]="{ agencyId: a.agencyId }">{{
                  'portal.admin.agencyView.toListings' | transloco
                }}</a>
              </li>
              <li>
                <a routerLink="/portal/admin/audit" [queryParams]="{ agencyId: a.agencyId }">{{
                  'portal.admin.agencyView.toAudit' | transloco
                }}</a>
              </li>
            </ul>
          </section>

          <section class="glass card" aria-labelledby="admin-agency-figures">
            <h2 id="admin-agency-figures">{{ 'portal.admin.agencyView.figures' | transloco }}</h2>
            @switch (overview().status) {
              @case ('loading') {
                <p class="note" role="status">{{ 'portal.admin.loading' | transloco }}</p>
              }
              @case ('error') {
                <p class="error" role="alert">{{ errorOf(overview()) }}</p>
              }
              @default {
                @if (overviewValue(); as o) {
                  <div class="figures">
                    <div>
                      <h3>{{ 'portal.monitoring.overview.listings' | transloco }}</h3>
                      @if (o.listings.available) {
                        <dl>
                          @for (status of statuses; track status) {
                            <div>
                              <dt>{{ 'portal.listings.status.' + status | transloco }}</dt>
                              <dd>{{ count(o.listings.value.byStatus[status]) }}</dd>
                            </div>
                          }
                        </dl>
                      } @else {
                        <p class="unavailable">{{ 'portal.monitoring.unavailable' | transloco }}</p>
                      }
                    </div>
                    <div>
                      <h3>{{ 'portal.monitoring.overview.changes' | transloco }}</h3>
                      @if (o.changes.available) {
                        <dl>
                          @for (channel of channels; track channel) {
                            <div>
                              <dt>{{ 'portal.monitoring.channel.' + channel | transloco }}</dt>
                              <dd>{{ count(o.changes.value.byChannel[channel]) }}</dd>
                            </div>
                          }
                        </dl>
                      } @else {
                        <p class="unavailable">{{ 'portal.monitoring.unavailable' | transloco }}</p>
                      }
                    </div>
                  </div>
                }
              }
            }
          </section>

          <section class="glass card" aria-labelledby="admin-agency-manage">
            <h2 id="admin-agency-manage">{{ 'portal.admin.agencyView.manage' | transloco }}</h2>
            <form class="inline" (submit)="rename($event)" novalidate>
              <label class="field">
                <span>{{ 'portal.admin.agencyView.name' | transloco }}</span>
                <input
                  name="displayName"
                  [value]="name()"
                  [attr.aria-invalid]="renameError() ? 'true' : null"
                  aria-describedby="admin-agency-rename-error"
                  (input)="name.set(value($event))"
                />
              </label>
              <button type="submit" class="pill primary" [disabled]="busy()">
                {{ 'portal.admin.agencyView.rename' | transloco }}
              </button>
            </form>
            <p id="admin-agency-rename-error" class="error" role="alert">
              {{ renameError() ?? '' }}
            </p>
            <div class="head">
              @if (a.state === 'ACTIVE') {
                <button
                  type="button"
                  class="pill danger"
                  [disabled]="busy()"
                  (click)="askSuspend(a)"
                >
                  {{ 'portal.admin.agencyView.suspend' | transloco }}
                </button>
              } @else {
                <button type="button" class="pill" [disabled]="busy()" (click)="reactivate(a)">
                  {{ 'portal.admin.agencyView.reactivate' | transloco }}
                </button>
              }
            </div>
            <p class="error" role="alert">{{ stateError() ?? '' }}</p>
            @if (notice(); as key) {
              <p class="success" role="status">{{ key | transloco }}</p>
            }
          </section>
        }
      }
    }
    <oe-admin-confirm-dialog
      [confirmation]="pending()"
      [busy]="busy()"
      (confirmed)="suspend()"
      (cancelled)="pending.set(undefined)"
    />
  `,
  styles: [
    ADMIN_STYLES,
    `
      .facts,
      dl {
        display: grid;
        gap: 0.25rem;
        margin: 0;
      }
      dl > div {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        border-bottom: 1px solid var(--color-surface-border);
      }
      dd {
        margin: 0;
        font-variant-numeric: tabular-nums;
      }
      .figures {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
        gap: 1rem 2rem;
      }
    `,
  ],
})
export class AdminAgencyDetailComponent {
  private readonly api = inject(ManagementApiClient);
  private readonly locale = inject(LocaleService);
  private readonly transloco = inject(TranslocoService);

  /** Route parameter `:id`. */
  readonly id = input.required<string>();

  protected readonly statuses = LISTING_STATUSES;
  protected readonly channels = CHANNELS;

  protected readonly agency = signal<Loadable<AgencyValue>>({ status: 'loading' });
  protected readonly overview = signal<Loadable<OverviewSummary>>({ status: 'loading' });
  protected readonly name = signal('');
  protected readonly busy = signal(false);
  protected readonly renameError = signal<string | undefined>(undefined);
  protected readonly stateError = signal<string | undefined>(undefined);
  protected readonly notice = signal<string | undefined>(undefined);
  protected readonly pending = signal<Confirmation | undefined>(undefined);

  private controller = new AbortController();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.controller.abort());
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  protected agencyValue(): AgencyValue | undefined {
    const state = this.agency();
    return state.status === 'ready' ? state.value : undefined;
  }

  protected overviewValue(): OverviewSummary | undefined {
    const state = this.overview();
    return state.status === 'ready' ? state.value : undefined;
  }

  protected errorOf(state: Loadable<unknown>): string {
    return state.status === 'error' ? state.message : '';
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

  private message(error: Parameters<ManagementApiClient['errorMessage']>[0]): string {
    return this.api.errorMessage(error) ?? '';
  }

  private async load(id: string): Promise<void> {
    this.controller.abort();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.agency.set({ status: 'loading' });
    this.overview.set({ status: 'loading' });
    const [agency, overview] = await Promise.all([
      getAgency(this.api, id, { signal }),
      fetchAgencyOverview(this.api, id, { signal }),
    ]);
    if (signal.aborted) return;
    if (agency.ok) {
      this.agency.set({ status: 'ready', value: agency.value });
      this.name.set(agency.value.displayName);
    } else {
      this.agency.set({ status: 'error', message: this.message(agency.error) });
    }
    this.overview.set(
      overview.ok
        ? { status: 'ready', value: summarizeOverview(overview.value) }
        : { status: 'error', message: this.message(overview.error) },
    );
  }

  protected async rename(event: Event): Promise<void> {
    event.preventDefault();
    const current = this.agencyValue();
    if (!current) return;
    const name = validateAgencyName(this.name());
    if (!name.ok) {
      this.renameError.set(this.transloco.translate(name.messageKey, name.params));
      return;
    }
    await this.change(current.agencyId, { displayName: name.value }, this.renameError, 'renamed');
  }

  /** Suspension first fetches the affected counts (`dryRun`), then asks (Req 10.8). */
  protected async askSuspend(agency: AgencyValue): Promise<void> {
    this.busy.set(true);
    this.stateError.set(undefined);
    this.notice.set(undefined);
    const preview = await previewSuspension(this.api, agency.agencyId, {
      signal: this.controller.signal,
    });
    this.busy.set(false);
    if (!preview.ok) {
      this.stateError.set(this.message(preview.error));
      return;
    }
    this.pending.set(confirmation('suspendAgency', agency.displayName, preview.value));
  }

  protected async suspend(): Promise<void> {
    const current = this.agencyValue();
    if (!current) return;
    await this.change(current.agencyId, { state: 'SUSPENDED' }, this.stateError, 'suspended');
    this.pending.set(undefined);
  }

  protected async reactivate(agency: AgencyValue): Promise<void> {
    await this.change(agency.agencyId, { state: 'ACTIVE' }, this.stateError, 'reactivated');
  }

  private async change(
    agencyId: string,
    body: { displayName?: string; state?: string },
    error: typeof this.stateError,
    done: string,
  ): Promise<void> {
    this.busy.set(true);
    error.set(undefined);
    this.notice.set(undefined);
    const result = await updateAgency(this.api, agencyId, body, { signal: this.controller.signal });
    this.busy.set(false);
    if (!result.ok) {
      error.set(this.message(result.error));
      return;
    }
    this.agency.set({ status: 'ready', value: result.value });
    this.name.set(result.value.displayName);
    this.notice.set(`portal.admin.agencyView.done.${done}`);
  }
}
