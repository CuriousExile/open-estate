import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { CHANNELS, LISTING_STATUSES } from '@open-estate/shared';
import { PortalSession } from '../../auth/portal-session.service';
import { LocaleService } from '../../locale/locale.service';
import { ManagementApiClient } from '../../management/management-api-client.service';
import type { ManagementError, ManagementResult } from '../../management/management-client';
import { MetricChartComponent } from '../shared/metric-chart/metric-chart.component';
import {
  formatMetricValue,
  type MetricResultData,
} from '../shared/metric-chart/metric-chart-model';
import {
  defaultPeriod,
  genericMetrics,
  periodErrorKey,
  preferredInterval,
  resolvePeriod,
  summarizeOverview,
  toRejectionRow,
  toRunRow,
  totalOf,
  USAGE_MAX_DAYS,
  usageListingRows,
  usageTotals,
  type ConnectorRunData,
  type DayPeriod,
  type OverviewSummary,
  type RejectionRow,
  type UsageListingRow,
  type UsageTotals,
} from './agency-monitoring-model';
import {
  fetchCatalog,
  fetchConnectorRuns,
  fetchMetric,
  fetchOverview,
  fetchRejections,
  fetchUsage,
  type MetricDefinitionValue,
} from './monitoring-api';

type Loadable<T> =
  { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string };

interface Paged<T> {
  items: T[];
  nextPageToken?: string | undefined;
  /** A further page is being loaded. */
  loadingMore?: boolean | undefined;
  /** Message of a failed further page; the loaded items stay. */
  moreError?: string | undefined;
}

interface UsageState {
  totals: UsageTotals;
  rows: Paged<UsageListingRow>;
}

/**
 * `/portal/monitoring` (design: `AgencyMonitoringComponent`, Req 13.6, 15.5): overview of the
 * last 30 days, Connector_Läufe with errors or rejections (optionally all), usage figures of a
 * period of 1–90 days, and every further catalog metric of the agency as a generic time series.
 */
@Component({
  selector: 'oe-agency-monitoring',
  imports: [MetricChartComponent, RouterLink, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="monitoring">
      <h1 class="label">{{ 'portal.monitoring.title' | transloco }}</h1>

      <section class="glass card" aria-labelledby="monitoring-overview">
        <h2 id="monitoring-overview">{{ 'portal.monitoring.overview.title' | transloco }}</h2>
        @switch (overview().status) {
          @case ('loading') {
            <p class="note" role="status">{{ 'portal.monitoring.loading' | transloco }}</p>
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
                          <dt>{{ 'portal.monitoring.listingStatus.' + status | transloco }}</dt>
                          <dd>{{ count(o.listings.value.byStatus[status]) }}</dd>
                        </div>
                      }
                      <div class="sum">
                        <dt>{{ 'portal.monitoring.total' | transloco }}</dt>
                        <dd>{{ count(o.listings.value.total) }}</dd>
                      </div>
                    </dl>
                  } @else {
                    <p class="note unavailable">
                      {{ 'portal.monitoring.unavailable' | transloco }}
                    </p>
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
                      <div class="sum">
                        <dt>{{ 'portal.monitoring.total' | transloco }}</dt>
                        <dd>{{ count(o.changes.value.total) }}</dd>
                      </div>
                    </dl>
                  } @else {
                    <p class="note unavailable">
                      {{ 'portal.monitoring.unavailable' | transloco }}
                    </p>
                  }
                </div>
              </div>
            }
          }
        }
      </section>

      <section class="glass card" aria-labelledby="monitoring-runs">
        <div class="section-head">
          <h2 id="monitoring-runs">{{ 'portal.monitoring.runs.title' | transloco }}</h2>
          <label class="toggle">
            <input type="checkbox" [checked]="problemsOnly()" (change)="toggleProblemsOnly()" />
            {{ 'portal.monitoring.runs.problemsOnly' | transloco }}
          </label>
        </div>
        <p class="note">{{ 'portal.monitoring.runs.hint' | transloco }}</p>
        @switch (runs().status) {
          @case ('loading') {
            <p class="note" role="status">{{ 'portal.monitoring.loading' | transloco }}</p>
          }
          @case ('error') {
            <p class="error" role="alert">{{ errorOf(runs()) }}</p>
          }
          @default {
            @if (runsValue(); as page) {
              @if (runRows().length === 0) {
                <p class="note">
                  {{
                    (problemsOnly()
                      ? 'portal.monitoring.runs.noProblems'
                      : 'portal.monitoring.runs.none'
                    ) | transloco
                  }}
                </p>
              } @else {
                <div class="scroll">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">{{ 'portal.monitoring.runs.connector' | transloco }}</th>
                        <th scope="col">{{ 'portal.monitoring.runs.started' | transloco }}</th>
                        <th scope="col">{{ 'portal.monitoring.runs.ended' | transloco }}</th>
                        <th scope="col">{{ 'portal.monitoring.runs.status.label' | transloco }}</th>
                        <th scope="col" class="num">
                          {{ 'portal.monitoring.runs.imported' | transloco }}
                        </th>
                        <th scope="col" class="num">
                          {{ 'portal.monitoring.runs.updated' | transloco }}
                        </th>
                        <th scope="col" class="num">
                          {{ 'portal.monitoring.runs.unchanged' | transloco }}
                        </th>
                        <th scope="col" class="num">
                          {{ 'portal.monitoring.runs.rejected' | transloco }}
                        </th>
                        <th scope="col">
                          <span class="visually-hidden">{{
                            'portal.monitoring.runs.actions' | transloco
                          }}</span>
                        </th>
                      </tr>
                    </thead>
                    @for (run of runRows(); track run.runId) {
                      <tbody [class.problem]="run.problem">
                        <tr>
                          <th scope="row">{{ run.connectorId }}</th>
                          <td>{{ run.started }}</td>
                          <td>
                            @if (run.ended) {
                              {{ run.ended }}
                            } @else {
                              {{ 'portal.monitoring.runs.running' | transloco }}
                            }
                          </td>
                          <td [class.failed]="run.failed">
                            @if (run.statusKey) {
                              {{ run.statusKey | transloco }}
                            } @else {
                              {{ run.status }}
                            }
                          </td>
                          <td class="num">{{ count(run.counts.imported) }}</td>
                          <td class="num">{{ count(run.counts.updated) }}</td>
                          <td class="num">{{ count(run.counts.unchanged) }}</td>
                          <td class="num" [class.failed]="run.counts.rejected > 0">
                            {{ count(run.counts.rejected) }}
                          </td>
                          <td>
                            @if (run.counts.rejected > 0) {
                              <button
                                type="button"
                                class="link"
                                [attr.aria-expanded]="isExpanded(run.runId)"
                                [attr.aria-controls]="'rejections-' + $index"
                                (click)="toggleRejections(run.runId)"
                              >
                                {{
                                  (isExpanded(run.runId)
                                    ? 'portal.monitoring.rejections.hide'
                                    : 'portal.monitoring.rejections.show'
                                  ) | transloco
                                }}
                              </button>
                            }
                          </td>
                        </tr>
                        @if (isExpanded(run.runId)) {
                          <tr>
                            <td colspan="9" [id]="'rejections-' + $index">
                              @let r = rejectionsOf(run.runId);
                              @if (r?.status === 'loading') {
                                <p class="note" role="status">
                                  {{ 'portal.monitoring.loading' | transloco }}
                                </p>
                              } @else if (r?.status === 'error') {
                                <p class="error" role="alert">{{ errorOf(r) }}</p>
                              } @else if (rejectionPage(run.runId); as rp) {
                                <table class="nested">
                                  <caption>
                                    {{
                                      'portal.monitoring.rejections.title'
                                        | transloco
                                          : { connector: run.connectorId, started: run.started }
                                    }}
                                  </caption>
                                  <thead>
                                    <tr>
                                      <th scope="col">
                                        {{ 'portal.monitoring.rejections.identifier' | transloco }}
                                      </th>
                                      <th scope="col">
                                        {{ 'portal.monitoring.rejections.fields' | transloco }}
                                      </th>
                                      <th scope="col">
                                        {{ 'portal.monitoring.rejections.reason' | transloco }}
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    @for (rejection of rp.items; track $index) {
                                      <tr>
                                        <td>
                                          @if (rejection.identifier) {
                                            {{ rejection.identifier }}
                                          } @else {
                                            {{
                                              'portal.monitoring.rejections.noIdentifier'
                                                | transloco
                                            }}
                                          }
                                        </td>
                                        <td>{{ rejection.fields }}</td>
                                        <td>{{ rejection.reason }}</td>
                                      </tr>
                                    } @empty {
                                      <tr>
                                        <td colspan="3">
                                          {{ 'portal.monitoring.rejections.none' | transloco }}
                                        </td>
                                      </tr>
                                    }
                                  </tbody>
                                </table>
                                @if (rp.moreError) {
                                  <p class="error" role="alert">{{ rp.moreError }}</p>
                                }
                                @if (rp.nextPageToken) {
                                  <button
                                    type="button"
                                    class="pill"
                                    [disabled]="rp.loadingMore"
                                    (click)="loadMoreRejections(run.runId)"
                                  >
                                    {{ 'portal.monitoring.loadMore' | transloco }}
                                  </button>
                                }
                              }
                            </td>
                          </tr>
                        }
                      </tbody>
                    }
                  </table>
                </div>
              }
              @if (page.moreError) {
                <p class="error" role="alert">{{ page.moreError }}</p>
              }
              @if (page.nextPageToken) {
                <button
                  type="button"
                  class="pill"
                  [disabled]="page.loadingMore"
                  (click)="loadMoreRuns()"
                >
                  {{ 'portal.monitoring.loadMore' | transloco }}
                </button>
              }
            }
          }
        }
      </section>

      <section class="glass card" aria-labelledby="monitoring-usage">
        <h2 id="monitoring-usage">{{ 'portal.monitoring.usage.title' | transloco }}</h2>
        <form class="period" (submit)="applyPeriod($event)" novalidate>
          <label>
            {{ 'portal.monitoring.period.from' | transloco }}
            <input
              type="date"
              name="from"
              [value]="periodInput().from"
              [attr.aria-invalid]="periodError() ? 'true' : null"
              aria-describedby="monitoring-period-error"
              (input)="setPeriodInput('from', $event)"
            />
          </label>
          <label>
            {{ 'portal.monitoring.period.to' | transloco }}
            <input
              type="date"
              name="to"
              [value]="periodInput().to"
              [attr.aria-invalid]="periodError() ? 'true' : null"
              aria-describedby="monitoring-period-error"
              (input)="setPeriodInput('to', $event)"
            />
          </label>
          <button type="submit" class="pill">
            {{ 'portal.monitoring.period.apply' | transloco }}
          </button>
          <p id="monitoring-period-error" class="error" role="alert">
            @if (periodError(); as key) {
              {{ key | transloco: { max: maxDays } }}
            }
          </p>
        </form>
        <p class="note">{{ 'portal.monitoring.usage.hint' | transloco }}</p>
        @switch (usage().status) {
          @case ('loading') {
            <p class="note" role="status">{{ 'portal.monitoring.loading' | transloco }}</p>
          }
          @case ('error') {
            <p class="error" role="alert">{{ errorOf(usage()) }}</p>
          }
          @default {
            @if (usageValue(); as u) {
              <div class="charts">
                <oe-metric-chart
                  [metric]="u.totals.detailViews"
                  [heading]="'portal.monitoring.usage.detailViews' | transloco"
                  [description]="
                    totalText(u.totals.detailViews)
                      ? ('portal.monitoring.usage.periodTotal'
                        | transloco: { total: totalText(u.totals.detailViews) })
                      : ''
                  "
                />
                <oe-metric-chart
                  [metric]="u.totals.searchImpressions"
                  [heading]="'portal.monitoring.usage.searchImpressions' | transloco"
                  [description]="
                    totalText(u.totals.searchImpressions)
                      ? ('portal.monitoring.usage.periodTotal'
                        | transloco: { total: totalText(u.totals.searchImpressions) })
                      : ''
                  "
                />
              </div>
              <h3>{{ 'portal.monitoring.usage.perListing' | transloco }}</h3>
              @if (u.rows.items.length === 0) {
                <p class="note">{{ 'portal.monitoring.usage.noListings' | transloco }}</p>
              } @else {
                <div class="scroll">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">{{ 'portal.monitoring.usage.listing' | transloco }}</th>
                        <th scope="col" class="num">
                          {{ 'portal.monitoring.usage.detailViews' | transloco }}
                        </th>
                        <th scope="col" class="num">
                          {{ 'portal.monitoring.usage.searchImpressions' | transloco }}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of u.rows.items; track row.listingId) {
                        <tr>
                          <th scope="row">
                            @if (session.can('listing:read')) {
                              <a [routerLink]="['/portal/listings', row.listingId]">{{
                                row.listingId
                              }}</a>
                            } @else {
                              {{ row.listingId }}
                            }
                          </th>
                          <td class="num">
                            @if (row.detailViews === undefined) {
                              {{ 'portal.monitoring.unavailable' | transloco }}
                            } @else {
                              {{ count(row.detailViews) }}
                            }
                          </td>
                          <td class="num">
                            @if (row.searchImpressions === undefined) {
                              {{ 'portal.monitoring.unavailable' | transloco }}
                            } @else {
                              {{ count(row.searchImpressions) }}
                            }
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
                @if (u.rows.moreError) {
                  <p class="error" role="alert">{{ u.rows.moreError }}</p>
                }
                @if (u.rows.nextPageToken) {
                  <button
                    type="button"
                    class="pill"
                    [disabled]="u.rows.loadingMore"
                    (click)="loadMoreUsage()"
                  >
                    {{ 'portal.monitoring.loadMore' | transloco }}
                  </button>
                }
              }
            }
          }
        }
      </section>

      @if (genericDefinitions().length > 0 || catalog().status === 'error') {
        <section class="glass card" aria-labelledby="monitoring-more">
          <h2 id="monitoring-more">{{ 'portal.monitoring.more.title' | transloco }}</h2>
          <p class="note">{{ 'portal.monitoring.more.hint' | transloco }}</p>
          @if (catalog().status === 'error') {
            <p class="error" role="alert">{{ errorOf(catalog()) }}</p>
          }
          <div class="charts">
            @for (definition of genericDefinitions(); track definition.code) {
              @if (metricValue(definition.code); as metric) {
                <oe-metric-chart
                  [metric]="metric"
                  [heading]="definition.code"
                  [description]="definition.description"
                  [otherLabel]="'portal.monitoring.chart.other' | transloco"
                />
              } @else {
                @let m = metricState(definition.code);
                <div>
                  <p class="heading">{{ definition.code }}</p>
                  @if (m?.status === 'error') {
                    <p class="error" role="alert">{{ errorOf(m) }}</p>
                  } @else {
                    <p class="note" role="status">{{ 'portal.monitoring.loading' | transloco }}</p>
                  }
                </div>
              }
            }
          </div>
        </section>
      }
    </div>
  `,
  styles: `
    .monitoring {
      display: grid;
      gap: 1.25rem;
    }
    h1,
    h2,
    h3 {
      margin: 0;
    }
    h2 {
      font-size: 1.15rem;
    }
    h3 {
      font-size: 1rem;
      margin-bottom: 0.4rem;
    }
    .card {
      display: grid;
      gap: 0.75rem;
      padding: 1.25rem 1.5rem;
      min-width: 0;
    }
    .section-head {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem 1.5rem;
      align-items: center;
      justify-content: space-between;
    }
    .note,
    .error {
      margin: 0;
      font-size: 0.9rem;
    }
    .note {
      color: var(--color-text-muted);
    }
    .error {
      color: var(--color-error);
    }
    .error:empty {
      display: none;
    }
    .unavailable {
      font-style: italic;
    }
    .figures {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
      gap: 1rem 2rem;
    }
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
    dl > .sum {
      font-weight: 600;
      border-bottom: none;
    }
    dd {
      margin: 0;
      font-variant-numeric: tabular-nums;
    }
    .scroll {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }
    th,
    td {
      padding: 0.35rem 0.6rem;
      text-align: left;
      border-bottom: 1px solid var(--color-surface-border);
      vertical-align: top;
    }
    .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    tbody.problem > tr:first-child > th {
      border-left: 3px solid var(--color-error);
    }
    .failed {
      color: var(--color-error);
      font-weight: 600;
    }
    .nested {
      margin: 0.25rem 0 0.5rem;
    }
    caption {
      text-align: left;
      color: var(--color-text-muted);
      padding-bottom: 0.25rem;
    }
    .period {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem 1rem;
      align-items: end;
    }
    .period label {
      display: grid;
      gap: 0.2rem;
      font-size: 0.85rem;
    }
    .period .error {
      flex-basis: 100%;
    }
    input[type='date'] {
      padding: 0.3rem 0.5rem;
      border: 1px solid var(--color-surface-border);
      border-radius: 0.5rem;
      background: transparent;
      color: inherit;
      font: inherit;
      color-scheme: dark;
    }
    .charts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
      gap: 1.5rem;
    }
    .heading {
      margin: 0;
      font-weight: 600;
    }
    .pill {
      justify-self: start;
      padding: 0.4rem 1.1rem;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-pill);
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    .pill:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .link {
      padding: 0;
      border: none;
      background: none;
      color: var(--brand-secondary);
      font: inherit;
      text-decoration: underline;
      cursor: pointer;
    }
    a {
      color: var(--brand-secondary);
    }
    .toggle {
      display: flex;
      gap: 0.4rem;
      align-items: center;
      font-size: 0.9rem;
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
export class AgencyMonitoringComponent {
  private readonly api = inject(ManagementApiClient);
  private readonly locale = inject(LocaleService);
  /** Listing ids link to the workspace only with `listing:read`. */
  protected readonly session = inject(PortalSession);
  private readonly controller = new AbortController();
  private readonly signal = this.controller.signal;

  protected readonly statuses = LISTING_STATUSES;
  protected readonly channels = CHANNELS;
  protected readonly maxDays = USAGE_MAX_DAYS;

  protected readonly overview = signal<Loadable<OverviewSummary>>({ status: 'loading' });
  protected readonly problemsOnly = signal(true);
  protected readonly runs = signal<Loadable<Paged<ConnectorRunData>>>({ status: 'loading' });
  private readonly expanded = signal<ReadonlySet<string>>(new Set());
  private readonly rejections = signal<ReadonlyMap<string, Loadable<Paged<RejectionRow>>>>(
    new Map(),
  );

  protected readonly periodInput = signal<DayPeriod>(defaultPeriod(new Date()));
  protected readonly periodError = signal<string | undefined>(undefined);
  private readonly period = signal<{ from: string; to: string } | undefined>(undefined);
  protected readonly usage = signal<Loadable<UsageState>>({ status: 'loading' });

  protected readonly catalog = signal<Loadable<MetricDefinitionValue[]>>({ status: 'loading' });
  private readonly metrics = signal<ReadonlyMap<string, Loadable<MetricResultData>>>(new Map());

  private runsGeneration = 0;
  private usageGeneration = 0;
  private metricsGeneration = 0;

  protected readonly overviewValue = computed(() => valueOf(this.overview()));
  protected readonly runsValue = computed(() => valueOf(this.runs()));
  protected readonly usageValue = computed(() => valueOf(this.usage()));
  protected readonly runRows = computed(() => {
    const locale = this.locale.active();
    return (this.runsValue()?.items ?? []).map((run) => toRunRow(run, locale));
  });
  protected readonly genericDefinitions = computed(() =>
    genericMetrics(valueOf(this.catalog()) ?? []),
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => this.controller.abort());
    void this.loadOverview();
    void this.loadRuns();
    void this.loadCatalog();
    this.applyPeriodValue(this.periodInput());
  }

  protected count(value: number): string {
    return formatMetricValue(value, 'count', this.locale.active());
  }

  protected totalText(metric: MetricResultData): string {
    const total = totalOf(metric);
    return total === undefined ? '' : this.count(total);
  }

  protected errorOf(state: Loadable<unknown> | undefined): string {
    return state?.status === 'error' ? state.message : '';
  }

  // --- overview ------------------------------------------------------------------------------

  private async loadOverview(): Promise<void> {
    const result = await fetchOverview(this.api, { signal: this.signal });
    this.settle(
      result,
      (metrics) => this.overview.set(ready(summarizeOverview(metrics))),
      (m) => this.overview.set({ status: 'error', message: m }),
    );
  }

  // --- connector runs ------------------------------------------------------------------------

  protected toggleProblemsOnly(): void {
    this.problemsOnly.update((value) => !value);
    this.expanded.set(new Set());
    void this.loadRuns();
  }

  private async loadRuns(): Promise<void> {
    const generation = ++this.runsGeneration;
    this.runs.set({ status: 'loading' });
    const result = await fetchConnectorRuns(this.api, {
      problemsOnly: this.problemsOnly(),
      signal: this.signal,
    });
    if (generation !== this.runsGeneration) return;
    this.settle(
      result,
      (page) => this.runs.set(ready({ items: page.items, nextPageToken: page.nextPageToken })),
      (message) => this.runs.set({ status: 'error', message }),
    );
  }

  protected async loadMoreRuns(): Promise<void> {
    const current = this.runsValue();
    if (!current?.nextPageToken || current.loadingMore) return;
    const generation = this.runsGeneration;
    this.runs.set(ready({ ...current, loadingMore: true, moreError: undefined }));
    const result = await fetchConnectorRuns(this.api, {
      problemsOnly: this.problemsOnly(),
      pageToken: current.nextPageToken,
      signal: this.signal,
    });
    if (generation !== this.runsGeneration) return;
    const latest = this.runsValue() ?? current;
    this.settle(
      result,
      (page) =>
        this.runs.set(
          ready({ items: [...latest.items, ...page.items], nextPageToken: page.nextPageToken }),
        ),
      (moreError) => this.runs.set(ready({ ...latest, loadingMore: false, moreError })),
    );
  }

  protected isExpanded(runId: string): boolean {
    return this.expanded().has(runId);
  }

  protected rejectionsOf(runId: string): Loadable<Paged<RejectionRow>> | undefined {
    return this.rejections().get(runId);
  }

  protected rejectionPage(runId: string): Paged<RejectionRow> | undefined {
    const state = this.rejections().get(runId);
    return state && valueOf(state);
  }

  protected toggleRejections(runId: string): void {
    const next = new Set(this.expanded());
    if (next.delete(runId)) {
      this.expanded.set(next);
      return;
    }
    next.add(runId);
    this.expanded.set(next);
    const state = this.rejections().get(runId);
    if (state === undefined || state.status === 'error') void this.loadRejections(runId);
  }

  private setRejections(runId: string, state: Loadable<Paged<RejectionRow>>): void {
    this.rejections.update((map) => new Map(map).set(runId, state));
  }

  private async loadRejections(runId: string): Promise<void> {
    this.setRejections(runId, { status: 'loading' });
    const result = await fetchRejections(this.api, runId, { signal: this.signal });
    this.settle(
      result,
      (page) =>
        this.setRejections(
          runId,
          ready({ items: page.items.map(toRejectionRow), nextPageToken: page.nextPageToken }),
        ),
      (message) => this.setRejections(runId, { status: 'error', message }),
    );
  }

  protected async loadMoreRejections(runId: string): Promise<void> {
    const current = this.rejectionPage(runId);
    if (!current?.nextPageToken || current.loadingMore) return;
    this.setRejections(runId, ready({ ...current, loadingMore: true, moreError: undefined }));
    const result = await fetchRejections(this.api, runId, {
      pageToken: current.nextPageToken,
      signal: this.signal,
    });
    this.settle(
      result,
      (page) =>
        this.setRejections(
          runId,
          ready({
            items: [...current.items, ...page.items.map(toRejectionRow)],
            nextPageToken: page.nextPageToken,
          }),
        ),
      (moreError) =>
        this.setRejections(runId, ready({ ...current, loadingMore: false, moreError })),
    );
  }

  // --- period, usage and generic metrics -----------------------------------------------------

  protected setPeriodInput(field: keyof DayPeriod, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.periodInput.update((period) => ({ ...period, [field]: value }));
  }

  protected applyPeriod(event: Event): void {
    event.preventDefault();
    this.applyPeriodValue(this.periodInput());
  }

  private applyPeriodValue(input: DayPeriod): void {
    const resolved = resolvePeriod(input);
    if (!resolved.ok) {
      this.periodError.set(periodErrorKey(resolved.error));
      return;
    }
    this.periodError.set(undefined);
    this.period.set({ from: resolved.from, to: resolved.to });
    void this.loadUsage();
    void this.loadGenericMetrics();
  }

  private async loadUsage(): Promise<void> {
    const period = this.period();
    if (!period) return;
    const generation = ++this.usageGeneration;
    this.usage.set({ status: 'loading' });
    const result = await fetchUsage(this.api, { ...period, signal: this.signal });
    if (generation !== this.usageGeneration) return;
    this.settle(
      result,
      (view) =>
        this.usage.set(
          ready({
            totals: usageTotals(view),
            rows: { items: usageListingRows(view), nextPageToken: view.nextPageToken },
          }),
        ),
      (message) => this.usage.set({ status: 'error', message }),
    );
  }

  protected async loadMoreUsage(): Promise<void> {
    const period = this.period();
    const current = this.usageValue();
    if (!period || !current?.rows.nextPageToken || current.rows.loadingMore) return;
    const generation = this.usageGeneration;
    const withRows = (rows: Paged<UsageListingRow>) => ready({ ...current, rows });
    this.usage.set(withRows({ ...current.rows, loadingMore: true, moreError: undefined }));
    const result = await fetchUsage(this.api, {
      ...period,
      pageToken: current.rows.nextPageToken,
      signal: this.signal,
    });
    if (generation !== this.usageGeneration) return;
    this.settle(
      result,
      (view) =>
        this.usage.set(
          withRows({
            items: [...current.rows.items, ...usageListingRows(view)],
            nextPageToken: view.nextPageToken,
          }),
        ),
      (moreError) => this.usage.set(withRows({ ...current.rows, loadingMore: false, moreError })),
    );
  }

  private async loadCatalog(): Promise<void> {
    const result = await fetchCatalog(this.api, { signal: this.signal });
    this.settle(
      result,
      (metrics) => {
        this.catalog.set(ready(metrics));
        void this.loadGenericMetrics();
      },
      (message) => this.catalog.set({ status: 'error', message }),
    );
  }

  protected metricState(code: string): Loadable<MetricResultData> | undefined {
    return this.metrics().get(code);
  }

  protected metricValue(code: string): MetricResultData | undefined {
    const state = this.metrics().get(code);
    return state && valueOf(state);
  }

  /** One `GET /metrics/{code}` per generic catalog metric for the applied period (Req 15.5). */
  private async loadGenericMetrics(): Promise<void> {
    const period = this.period();
    const definitions = this.genericDefinitions();
    if (!period || definitions.length === 0) return;
    const generation = ++this.metricsGeneration;
    this.metrics.set(new Map(definitions.map((d) => [d.code, { status: 'loading' } as const])));
    await Promise.all(
      definitions.map(async (definition) => {
        const result = await fetchMetric(this.api, definition.code, {
          ...period,
          interval: preferredInterval(definition),
          signal: this.signal,
        });
        if (generation !== this.metricsGeneration) return;
        const set = (state: Loadable<MetricResultData>) =>
          this.metrics.update((map) => new Map(map).set(definition.code, state));
        this.settle(
          result,
          (metric) => set(ready(metric)),
          (message) => set({ status: 'error', message }),
        );
      }),
    );
  }

  /** Dispatches a result; a call aborted on destroy is ignored. */
  private settle<T>(
    result: ManagementResult<T>,
    onValue: (value: T) => void,
    onError: (message: string) => void,
  ): void {
    if (result.ok) {
      onValue(result.value);
      return;
    }
    const message = this.message(result.error);
    if (message !== undefined) onError(message);
  }

  private message(error: ManagementError): string | undefined {
    return this.api.errorMessage(error);
  }
}

const ready = <T>(value: T): Loadable<T> => ({ status: 'ready', value });

const valueOf = <T>(state: Loadable<T>): T | undefined =>
  state.status === 'ready' ? state.value : undefined;
