import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { LocaleService } from '../../../locale/locale.service';
import {
  buildChartModel,
  formatMetricValue,
  formatPointTime,
  isAvailable,
  type MetricResultData,
} from './metric-chart-model';

let nextId = 0;

/**
 * Generic time series of any Monitoring_Kennzahl (design: `MetricChartComponent`, Req 15.5): plain
 * SVG, no chart library. The SVG carries `title`/`desc`; a table with all values is the accessible
 * fallback. A metric whose source did not answer shows "not available" (Req 14.7). Used by the
 * agency monitoring and the platform monitoring of the Admin_Modus.
 */
@Component({
  selector: 'oe-metric-chart',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <figure class="chart" [attr.aria-labelledby]="ids.caption">
      <figcaption [id]="ids.caption">
        <span class="heading">{{ heading() }}</span>
        @if (description()) {
          <span class="description">{{ description() }}</span>
        }
      </figcaption>
      @if (view(); as v) {
        @if (v.model.empty) {
          <p class="note">{{ 'portal.monitoring.chart.empty' | transloco }}</p>
        } @else {
          <svg
            role="img"
            [attr.viewBox]="'0 0 ' + v.model.width + ' ' + v.model.height"
            [attr.aria-labelledby]="ids.title + ' ' + ids.desc"
            preserveAspectRatio="xMidYMid meet"
          >
            <title [attr.id]="ids.title">{{ heading() }}</title>
            <desc [attr.id]="ids.desc">
              {{
                'portal.monitoring.chart.summary'
                  | transloco
                    : {
                        series: v.model.lines.length,
                        points: v.model.pointCount,
                        max: v.maxLabel,
                        from: v.fromLabel,
                        to: v.toLabel,
                      }
              }}
            </desc>
            <g class="grid" aria-hidden="true">
              @for (tick of v.yTicks; track tick.position) {
                <line
                  [attr.x1]="v.model.plot.left"
                  [attr.x2]="v.model.plot.right"
                  [attr.y1]="tick.position"
                  [attr.y2]="tick.position"
                />
                <text
                  class="tick"
                  text-anchor="end"
                  [attr.x]="v.model.plot.left - 6"
                  [attr.y]="tick.position + 4"
                >
                  {{ tick.label }}
                </text>
              }
              @for (tick of v.xTicks; track tick.position) {
                <text
                  class="tick"
                  text-anchor="middle"
                  [attr.x]="tick.position"
                  [attr.y]="v.model.height - 8"
                >
                  {{ tick.label }}
                </text>
              }
            </g>
            <g aria-hidden="true">
              @for (line of v.model.lines; track line.key) {
                <path [class]="'line series-' + line.color" [attr.d]="line.path" />
                @for (marker of line.markers; track marker.t) {
                  <circle
                    [class]="'marker series-' + line.color"
                    [attr.cx]="marker.x"
                    [attr.cy]="marker.y"
                    r="2.5"
                  />
                }
              }
            </g>
          </svg>
          @if (v.model.lines.length > 1 || v.model.lines[0]?.label) {
            <ul class="legend">
              @for (line of v.model.lines; track line.key) {
                <li>
                  <span [class]="'swatch series-' + line.color" aria-hidden="true"></span>
                  {{ line.label }}
                </li>
              }
            </ul>
          }
          <details class="table">
            <summary>{{ 'portal.monitoring.chart.showTable' | transloco }}</summary>
            <table>
              <caption>
                {{
                  heading()
                }}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{{ 'portal.monitoring.chart.time' | transloco }}</th>
                  @for (column of v.model.table.columns; track column.key) {
                    <th scope="col">
                      @if (column.label) {
                        {{ column.label }}
                      } @else {
                        {{ 'portal.monitoring.chart.value' | transloco }}
                      }
                    </th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (row of v.rows; track row.t) {
                  <tr>
                    <th scope="row">{{ row.label }}</th>
                    @for (value of row.values; track $index) {
                      <td>{{ value }}</td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </details>
        }
      } @else {
        <p class="note unavailable">{{ 'portal.monitoring.unavailable' | transloco }}</p>
      }
    </figure>
  `,
  styles: `
    .chart {
      display: grid;
      gap: 0.5rem;
      margin: 0;
    }
    figcaption {
      display: grid;
      gap: 0.15rem;
    }
    .heading {
      font-weight: 600;
    }
    .description,
    .note {
      color: var(--color-text-muted);
      font-size: 0.9rem;
      margin: 0;
    }
    .unavailable {
      font-style: italic;
    }
    svg {
      width: 100%;
      height: auto;
      max-height: 16rem;
    }
    .grid line {
      stroke: var(--color-surface-border);
      stroke-width: 1;
    }
    .tick {
      fill: var(--color-text-muted);
      font-size: 10px;
    }
    .line {
      fill: none;
      stroke-width: 2;
      stroke-linejoin: round;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 1rem;
      margin: 0;
      padding: 0;
      list-style: none;
      font-size: 0.85rem;
    }
    .swatch {
      display: inline-block;
      width: 0.75rem;
      height: 0.75rem;
      margin-right: 0.35rem;
      border-radius: 50%;
      vertical-align: middle;
    }
    .series-0 {
      --series: var(--color-accent);
    }
    .series-1 {
      --series: var(--chart-1);
    }
    .series-2 {
      --series: var(--chart-2);
    }
    .series-3 {
      --series: var(--chart-3);
    }
    .series-4 {
      --series: var(--chart-4);
    }
    .series-5 {
      --series: var(--chart-5);
    }
    .line {
      stroke: var(--series);
    }
    .marker,
    .swatch {
      fill: var(--series);
      background: var(--series);
    }
    table {
      border-collapse: collapse;
      font-size: 0.85rem;
      margin-top: 0.5rem;
    }
    caption {
      text-align: left;
      color: var(--color-text-muted);
    }
    th,
    td {
      padding: 0.2rem 0.6rem;
      text-align: right;
      border-bottom: 1px solid var(--color-surface-border);
    }
    th[scope='row'],
    thead th:first-child {
      text-align: left;
    }
    summary {
      cursor: pointer;
      color: var(--color-accent);
    }
  `,
})
export class MetricChartComponent {
  private readonly locale = inject(LocaleService);

  readonly metric = input.required<MetricResultData>();
  /** Visible, already translated heading (e.g. the metric code or a translated label). */
  readonly heading = input.required<string>();
  readonly description = input<string>('');
  /** Legend label of the series summed beyond the shown lines. */
  readonly otherLabel = input<string>('…');

  protected readonly ids = (() => {
    const id = `oe-metric-chart-${nextId++}`;
    return { caption: `${id}-caption`, title: `${id}-title`, desc: `${id}-desc` };
  })();

  /** `undefined` while the metric is not available. */
  protected readonly view = computed(() => {
    const metric = this.metric();
    if (!isAvailable(metric)) return undefined;
    const locale = this.locale.active();
    const model = buildChartModel(metric, { otherLabel: this.otherLabel() });
    const value = (v: number) => formatMetricValue(v, metric.unit, locale);
    const time = (t: string) => formatPointTime(t, metric.interval, locale);
    const rows = model.table.rows;
    return {
      model,
      maxLabel: value(Math.max(0, ...model.lines.flatMap((l) => l.markers.map((m) => m.value)))),
      fromLabel: rows[0] ? time(rows[0].t) : '',
      toLabel: rows.length > 0 ? time((rows[rows.length - 1] as { t: string }).t) : '',
      yTicks: model.yTicks.map((tick) => ({ ...tick, label: value(tick.value) })),
      xTicks: model.xTicks.map((tick) => ({ ...tick, label: time(tick.t) })),
      rows: rows.map((row) => ({
        t: row.t,
        label: time(row.t),
        values: row.values.map((v) => (v === undefined ? '–' : value(v))),
      })),
    };
  });
}
