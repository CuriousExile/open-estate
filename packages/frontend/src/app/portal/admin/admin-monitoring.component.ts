import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { CHANNELS, LISTING_STATUSES } from '@open-estate/shared';
import { LocaleService } from '../../locale/locale.service';
import { ManagementApiClient } from '../../management/management-api-client.service';
import type { ManagementError, ManagementResult } from '../../management/management-client';
import { formatTimestamp } from '../listings/listing-table-model';
import { toRunRow } from '../monitoring/agency-monitoring-model';
import { MetricChartComponent } from '../shared/metric-chart/metric-chart.component';
import {
  formatMetricValue,
  type MetricResultData,
  type MetricUnit,
} from '../shared/metric-chart/metric-chart-model';
import {
  fetchAgencyActivity,
  fetchAlarms,
  fetchHistorySize,
  fetchPlatform,
  fetchPlatformRuns,
  type AlarmsValue,
  type RunPageValue,
} from './admin-api';
import {
  AGENCY_ACTIVITY_INTERVAL,
  countAlarming,
  DEFAULT_PLATFORM_PERIOD,
  endpointRows,
  historyRows,
  isPlatformPeriodKey,
  NO_AGENCY,
  PLATFORM_PERIOD_KEYS,
  platformMetrics,
  platformPeriod,
  sortAlarms,
  toActivityRow,
  type AgencyActivityRow,
  type AlarmData,
  type EndpointRow,
  type Figure,
  type HistoryRow,
  type PlatformPeriodKey,
} from './admin-model';
import { ADMIN_STYLES } from './admin-styles';

type Loadable<T> =
  { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string };

type AlarmsState = { available: true; alarms: AlarmData[] } | { available: false };

interface RunFilter {
  agencyId: string;
  connectorId: string;
  status: string;
}

interface RunsState {
  items: RunPageValue['items'];
  nextPageToken?: string | undefined;
  loadingMore?: boolean;
  moreError?: string | undefined;
}

const valueOf = <T>(state: Loadable<T>): T | undefined =>
  state.status === 'ready' ? state.value : undefined;

/**
 * `/portal/admin/monitoring` (Req 14.1–14.7): alarms (state `ALARM` highlighted), latency,
 * requests and 4xx/429/5xx responses per endpoint, agency activity, version history size and the
 * cross-agency Connector_Läufe. Every metric whose source did not answer is marked "not
 * available" instead of failing the view.
 */
@Component({
  selector: 'oe-admin-monitoring',
  imports: [MetricChartComponent, RouterLink, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="glass card" aria-labelledby="admin-monitoring-title">
      <div class="head">
        <h1 id="admin-monitoring-title" class="label">
          {{ 'portal.admin.monitoring' | transloco }}
        </h1>
        <label class="field">
          <span>{{ 'portal.admin.period.label' | transloco }}</span>
          <!-- [selected] per option: a [value] on the select is applied before the @for options
               exist, so the first option would show instead of the active period. -->
          <select (change)="setPeriod($event)">
            @for (key of periods; track key) {
              <option [value]="key" [selected]="key === period()">
                {{ 'portal.admin.period.' + key | transloco }}
              </option>
            }
          </select>
        </label>
      </div>
    </section>

    <section class="glass card" aria-labelledby="admin-alarms">
      <h2 id="admin-alarms">{{ 'portal.admin.alarms.title' | transloco }}</h2>
      @switch (alarms().status) {
        @case ('loading') {
          <p class="note" role="status">{{ 'portal.admin.loading' | transloco }}</p>
        }
        @case ('error') {
          <p class="error" role="alert">{{ errorOf(alarms()) }}</p>
        }
        @default {
          @if (alarmsValue(); as a) {
            @if (!a.available) {
              <p class="unavailable">{{ 'portal.monitoring.unavailable' | transloco }}</p>
            } @else if (a.alarms.length === 0) {
              <p class="note">{{ 'portal.admin.alarms.none' | transloco }}</p>
            } @else {
              <p [class.error]="alarming() > 0" [class.note]="alarming() === 0" role="status">
                {{ 'portal.admin.alarms.summary' | transloco: { count: alarming() } }}
              </p>
              <div class="scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{{ 'portal.admin.alarms.name' | transloco }}</th>
                      <th scope="col">{{ 'portal.admin.alarms.state' | transloco }}</th>
                      <th scope="col">{{ 'portal.admin.alarms.changed' | transloco }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (alarm of a.alarms; track alarm.name) {
                      <tr [class.alarming]="alarm.state === 'ALARM'">
                        <th scope="row">{{ alarm.name }}</th>
                        <td>
                          <span class="badge" [class.alarm]="alarm.state === 'ALARM'">{{
                            'portal.admin.alarms.stateName.' + alarm.state | transloco
                          }}</span>
                        </td>
                        <td>{{ timestamp(alarm.updatedAt) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          }
        }
      }
    </section>

    <section class="glass card" aria-labelledby="admin-endpoints">
      <h2 id="admin-endpoints">{{ 'portal.admin.endpoints.title' | transloco }}</h2>
      @switch (platform().status) {
        @case ('loading') {
          <p class="note" role="status">{{ 'portal.admin.loading' | transloco }}</p>
        }
        @case ('error') {
          <p class="error" role="alert">{{ errorOf(platform()) }}</p>
        }
        @default {
          @if (platformValue(); as metrics) {
            @if (endpoints().length === 0) {
              <p class="note">{{ 'portal.admin.endpoints.none' | transloco }}</p>
            } @else {
              <div class="scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{{ 'portal.admin.endpoints.interface' | transloco }}</th>
                      <th scope="col">{{ 'portal.admin.endpoints.endpoint' | transloco }}</th>
                      <th scope="col" class="num">
                        {{ 'portal.admin.endpoints.latency' | transloco }}
                      </th>
                      <th scope="col" class="num">
                        {{ 'portal.admin.endpoints.requests' | transloco }}
                      </th>
                      <th scope="col" class="num">
                        {{ 'portal.admin.endpoints.status4xx' | transloco }}
                      </th>
                      <th scope="col" class="num">
                        {{ 'portal.admin.endpoints.status429' | transloco }}
                      </th>
                      <th scope="col" class="num">
                        {{ 'portal.admin.endpoints.status5xx' | transloco }}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of endpoints(); track row.key) {
                      <tr>
                        <td>{{ row.interface }}</td>
                        <th scope="row">{{ row.endpoint }}</th>
                        <td class="num">{{ figure(row.latencyP95, 'milliseconds') }}</td>
                        <td class="num">{{ figure(row.requests) }}</td>
                        <td class="num">{{ figure(row.status4xx) }}</td>
                        <td class="num">{{ figure(row.status429) }}</td>
                        <td class="num" [class.error]="(row.status5xx ?? 0) > 0">
                          {{ figure(row.status5xx) }}
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
            <div class="charts">
              <oe-metric-chart
                [metric]="metrics.latencyP95"
                [heading]="'portal.admin.endpoints.latency' | transloco"
                [otherLabel]="'portal.monitoring.chart.other' | transloco"
              />
              <oe-metric-chart
                [metric]="metrics.requests"
                [heading]="'portal.admin.endpoints.requests' | transloco"
                [otherLabel]="'portal.monitoring.chart.other' | transloco"
              />
              <oe-metric-chart
                [metric]="metrics.responses"
                [heading]="'portal.admin.endpoints.responses' | transloco"
                [otherLabel]="'portal.monitoring.chart.other' | transloco"
              />
            </div>
          }
        }
      }
    </section>

    <section class="glass card" aria-labelledby="admin-activity">
      <h2 id="admin-activity">{{ 'portal.admin.activity.title' | transloco }}</h2>
      <p class="note">{{ 'portal.admin.activity.hint' | transloco }}</p>
      @switch (activity().status) {
        @case ('loading') {
          <p class="note" role="status">{{ 'portal.admin.loading' | transloco }}</p>
        }
        @case ('error') {
          <p class="error" role="alert">{{ errorOf(activity()) }}</p>
        }
        @default {
          @if (activityValue(); as rows) {
            @if (rows.length === 0) {
              <p class="note">{{ 'portal.admin.agencyView.empty' | transloco }}</p>
            } @else {
              <div class="scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{{ 'portal.admin.listingsAgency' | transloco }}</th>
                      @for (status of statuses; track status) {
                        <th scope="col" class="num">
                          {{ 'portal.listings.status.' + status | transloco }}
                        </th>
                      }
                      @for (channel of channels; track channel) {
                        <th scope="col" class="num">
                          {{
                            'portal.admin.activity.changes'
                              | transloco
                                : { channel: ('portal.monitoring.channel.' + channel | transloco) }
                          }}
                        </th>
                      }
                      <th scope="col" class="num">
                        {{ 'portal.monitoring.usage.detailViews' | transloco }}
                      </th>
                      <th scope="col" class="num">
                        {{ 'portal.monitoring.usage.searchImpressions' | transloco }}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of rows; track row.agencyId) {
                      <tr>
                        <th scope="row">
                          <a [routerLink]="['/portal/admin/agencies', row.agencyId]">{{
                            row.agencyId
                          }}</a>
                        </th>
                        @for (status of statuses; track status) {
                          <td class="num">
                            @if (row.overview.listings.available) {
                              {{ figure(row.overview.listings.value.byStatus[status]) }}
                            } @else {
                              <span class="unavailable">{{
                                'portal.monitoring.unavailable' | transloco
                              }}</span>
                            }
                          </td>
                        }
                        @for (channel of channels; track channel) {
                          <td class="num">
                            @if (row.overview.changes.available) {
                              {{ figure(row.overview.changes.value.byChannel[channel]) }}
                            } @else {
                              <span class="unavailable">{{
                                'portal.monitoring.unavailable' | transloco
                              }}</span>
                            }
                          </td>
                        }
                        <td class="num">{{ figure(row.detailViews) }}</td>
                        <td class="num">{{ figure(row.searchImpressions) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          }
        }
      }
    </section>

    <section class="glass card" aria-labelledby="admin-history">
      <h2 id="admin-history">{{ 'portal.admin.history.title' | transloco }}</h2>
      @switch (history().status) {
        @case ('loading') {
          <p class="note" role="status">{{ 'portal.admin.loading' | transloco }}</p>
        }
        @case ('error') {
          <p class="error" role="alert">{{ errorOf(history()) }}</p>
        }
        @default {
          @if (historyValue(); as rows) {
            <div class="scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{{ 'portal.admin.listingsAgency' | transloco }}</th>
                    <th scope="col" class="num">
                      {{ 'portal.admin.history.versions' | transloco }}
                    </th>
                    <th scope="col" class="num">{{ 'portal.admin.history.bytes' | transloco }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of rows; track row.agencyId ?? '') {
                    <tr [class.sum]="row.agencyId === undefined">
                      <th scope="row">
                        @if (row.agencyId === undefined) {
                          {{ 'portal.admin.history.platform' | transloco }}
                        } @else if (row.agencyId === noAgency) {
                          {{ 'portal.admin.noAgency' | transloco }}
                        } @else {
                          <a [routerLink]="['/portal/admin/agencies', row.agencyId]">{{
                            row.agencyId
                          }}</a>
                        }
                      </th>
                      <td class="num">{{ figure(row.versions) }}</td>
                      <td class="num">{{ figure(row.bytes, 'bytes') }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        }
      }
    </section>

    <section class="glass card" aria-labelledby="admin-runs">
      <h2 id="admin-runs">{{ 'portal.monitoring.runs.title' | transloco }}</h2>
      <form class="inline" (submit)="applyRunFilter($event)" novalidate>
        <label class="field">
          <span>{{ 'portal.admin.listingsAgency' | transloco }}</span>
          <input
            name="agencyId"
            [value]="runFilter().agencyId"
            (input)="setRunFilter('agencyId', $event)"
          />
        </label>
        <label class="field">
          <span>{{ 'portal.monitoring.runs.connector' | transloco }}</span>
          <input
            name="connectorId"
            [value]="runFilter().connectorId"
            (input)="setRunFilter('connectorId', $event)"
          />
        </label>
        <label class="field">
          <span>{{ 'portal.monitoring.runs.status.label' | transloco }}</span>
          <select
            name="status"
            [value]="runFilter().status"
            (change)="setRunFilter('status', $event)"
          >
            <option value="">{{ 'portal.admin.any' | transloco }}</option>
            <option value="SUCCESS">
              {{ 'portal.monitoring.runs.status.SUCCESS' | transloco }}
            </option>
            <option value="FAILURE">
              {{ 'portal.monitoring.runs.status.FAILURE' | transloco }}
            </option>
          </select>
        </label>
        <button type="submit" class="pill primary">
          {{ 'portal.monitoring.period.apply' | transloco }}
        </button>
      </form>
      @switch (runs().status) {
        @case ('loading') {
          <p class="note" role="status">{{ 'portal.admin.loading' | transloco }}</p>
        }
        @case ('error') {
          <p class="error" role="alert">{{ errorOf(runs()) }}</p>
        }
        @default {
          @if (runsValue(); as page) {
            @if (runRows().length === 0) {
              <p class="note">{{ 'portal.monitoring.runs.none' | transloco }}</p>
            } @else {
              <div class="scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{{ 'portal.monitoring.runs.connector' | transloco }}</th>
                      <th scope="col">{{ 'portal.admin.listingsAgency' | transloco }}</th>
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
                    </tr>
                  </thead>
                  <tbody>
                    @for (run of runRows(); track run.row.runId) {
                      <tr [class.alarming]="run.row.problem">
                        <th scope="row">{{ run.row.connectorId }}</th>
                        <td>
                          @if (run.agencyId) {
                            <a [routerLink]="['/portal/admin/agencies', run.agencyId]">{{
                              run.agencyId
                            }}</a>
                          } @else {
                            {{ 'portal.admin.noAgency' | transloco }}
                          }
                        </td>
                        <td>{{ run.row.started }}</td>
                        <td>
                          @if (run.row.ended) {
                            {{ run.row.ended }}
                          } @else {
                            {{ 'portal.monitoring.runs.running' | transloco }}
                          }
                        </td>
                        <td [class.error]="run.row.failed">
                          @if (run.row.statusKey) {
                            {{ run.row.statusKey | transloco }}
                          } @else {
                            {{ run.row.status }}
                          }
                        </td>
                        <td class="num">{{ figure(run.row.counts.imported) }}</td>
                        <td class="num">{{ figure(run.row.counts.updated) }}</td>
                        <td class="num">{{ figure(run.row.counts.unchanged) }}</td>
                        <td class="num" [class.error]="run.row.counts.rejected > 0">
                          {{ figure(run.row.counts.rejected) }}
                        </td>
                      </tr>
                    }
                  </tbody>
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
  `,
  styles: [
    ADMIN_STYLES,
    `
      .charts {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
        gap: 1.5rem;
      }
      tr.alarming > th {
        border-left: 3px solid var(--color-error);
      }
      tr.sum {
        font-weight: 600;
      }
    `,
  ],
})
export class AdminMonitoringComponent {
  private readonly api = inject(ManagementApiClient);
  private readonly locale = inject(LocaleService);
  private readonly transloco = inject(TranslocoService);
  private readonly controller = new AbortController();
  private readonly signal = this.controller.signal;

  protected readonly periods = PLATFORM_PERIOD_KEYS;
  protected readonly statuses = LISTING_STATUSES;
  protected readonly channels = CHANNELS;
  protected readonly noAgency = NO_AGENCY;

  protected readonly period = signal<PlatformPeriodKey>(DEFAULT_PLATFORM_PERIOD);
  protected readonly alarms = signal<Loadable<AlarmsState>>({ status: 'loading' });
  protected readonly platform = signal<Loadable<MetricResultData[]>>({ status: 'loading' });
  protected readonly activity = signal<Loadable<AgencyActivityRow[]>>({ status: 'loading' });
  protected readonly history = signal<Loadable<HistoryRow[]>>({ status: 'loading' });
  protected readonly runFilter = signal<RunFilter>({ agencyId: '', connectorId: '', status: '' });
  protected readonly runs = signal<Loadable<RunsState>>({ status: 'loading' });

  private periodGeneration = 0;
  private runsGeneration = 0;
  private appliedRunFilter: RunFilter = this.runFilter();

  protected readonly alarmsValue = computed(() => valueOf(this.alarms()));
  protected readonly alarming = computed(() => {
    const value = this.alarmsValue();
    return value?.available ? countAlarming(value.alarms) : 0;
  });
  protected readonly platformValue = computed(() => {
    const metrics = valueOf(this.platform());
    return metrics && platformMetrics(metrics);
  });
  protected readonly endpoints = computed<EndpointRow[]>(() =>
    endpointRows(valueOf(this.platform()) ?? []),
  );
  protected readonly activityValue = computed(() => valueOf(this.activity()));
  protected readonly historyValue = computed(() => valueOf(this.history()));
  protected readonly runsValue = computed(() => valueOf(this.runs()));
  protected readonly runRows = computed(() => {
    const locale = this.locale.active();
    return (this.runsValue()?.items ?? []).map((run) => ({
      agencyId: run.agencyId,
      row: toRunRow(run, locale),
    }));
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.controller.abort());
    void this.loadAlarms();
    void this.loadHistory();
    void this.loadPeriod();
    void this.loadRuns();
  }

  protected errorOf(state: Loadable<unknown>): string {
    return state.status === 'error' ? state.message : '';
  }

  protected timestamp(iso: string): string {
    return formatTimestamp(iso, this.locale.active());
  }

  /** A figure, or "not available" for a source that did not answer (Req 14.7). */
  protected figure(value: Figure, unit: MetricUnit = 'count'): string {
    const locale = this.locale.active();
    return value === undefined
      ? this.transloco.translate('portal.monitoring.unavailable')
      : formatMetricValue(value, unit, locale);
  }

  protected setPeriod(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (!isPlatformPeriodKey(value)) return;
    this.period.set(value);
    void this.loadPeriod();
  }

  private message(error: ManagementError): string {
    return this.api.errorMessage(error) ?? '';
  }

  private settle<T, R>(
    result: ManagementResult<T>,
    target: { set(value: Loadable<R>): void },
    map: (value: T) => R,
  ): void {
    if (result.ok) target.set({ status: 'ready', value: map(result.value) });
    else if (result.error.kind !== 'aborted') {
      target.set({ status: 'error', message: this.message(result.error) });
    }
  }

  private async loadAlarms(): Promise<void> {
    const result = await fetchAlarms(this.api, { signal: this.signal });
    this.settle(result, this.alarms, (value: AlarmsValue): AlarmsState =>
      value.available ? { available: true, alarms: sortAlarms(value.alarms) } : value,
    );
  }

  private async loadHistory(): Promise<void> {
    const result = await fetchHistorySize(this.api, { signal: this.signal });
    this.settle(result, this.history, historyRows);
  }

  private async loadPeriod(): Promise<void> {
    const generation = ++this.periodGeneration;
    const query = platformPeriod(this.period(), new Date());
    this.platform.set({ status: 'loading' });
    this.activity.set({ status: 'loading' });
    const [platform, activity] = await Promise.all([
      fetchPlatform(this.api, { ...query, signal: this.signal }),
      fetchAgencyActivity(this.api, {
        ...query,
        interval: AGENCY_ACTIVITY_INTERVAL,
        signal: this.signal,
      }),
    ]);
    if (generation !== this.periodGeneration) return;
    this.settle(platform, this.platform, (metrics) => metrics);
    this.settle(activity, this.activity, (agencies) => agencies.map(toActivityRow));
  }

  protected setRunFilter(field: keyof RunFilter, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
    this.runFilter.update((filter) => ({ ...filter, [field]: value }));
  }

  protected applyRunFilter(event: Event): void {
    event.preventDefault();
    this.appliedRunFilter = this.runFilter();
    void this.loadRuns();
  }

  private runQuery(pageToken?: string) {
    const filter = this.appliedRunFilter;
    const pick = (value: string) => (value.trim() === '' ? undefined : value.trim());
    const query: { agencyId?: string; connectorId?: string; status?: string; pageToken?: string } =
      {};
    const agencyId = pick(filter.agencyId);
    const connectorId = pick(filter.connectorId);
    const status = pick(filter.status);
    if (agencyId !== undefined) query.agencyId = agencyId;
    if (connectorId !== undefined) query.connectorId = connectorId;
    if (status !== undefined) query.status = status;
    if (pageToken !== undefined) query.pageToken = pageToken;
    return query;
  }

  private async loadRuns(): Promise<void> {
    const generation = ++this.runsGeneration;
    this.runs.set({ status: 'loading' });
    const result = await fetchPlatformRuns(this.api, { ...this.runQuery(), signal: this.signal });
    if (generation !== this.runsGeneration) return;
    this.settle(result, this.runs, (page) => ({
      items: page.items,
      nextPageToken: page.nextPageToken,
    }));
  }

  protected async loadMoreRuns(): Promise<void> {
    const current = this.runsValue();
    if (!current?.nextPageToken || current.loadingMore) return;
    const generation = this.runsGeneration;
    this.runs.set({
      status: 'ready',
      value: { ...current, loadingMore: true, moreError: undefined },
    });
    const result = await fetchPlatformRuns(this.api, {
      ...this.runQuery(current.nextPageToken),
      signal: this.signal,
    });
    if (generation !== this.runsGeneration) return;
    if (result.ok) {
      this.runs.set({
        status: 'ready',
        value: {
          items: [...current.items, ...result.value.items],
          nextPageToken: result.value.nextPageToken,
        },
      });
    } else if (result.error.kind !== 'aborted') {
      this.runs.set({
        status: 'ready',
        value: { ...current, loadingMore: false, moreError: this.message(result.error) },
      });
    }
  }
}
