import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { DiffResponse } from '@open-estate/shared';
import { toDiffRows } from './diff-view-model';

/**
 * Field-by-field Diff of two versions with highlighted old and new values (Req 5.5, 7.8, 8.6).
 * Shared by the listing form (version conflict) and the listing workspace (history, restore).
 */
@Component({
  selector: 'oe-diff-view',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (rows().length === 0) {
      <p class="empty">{{ 'portal.diff.empty' | transloco }}</p>
    } @else {
      <table class="diff">
        <caption>
          @if (diff(); as d) {
            {{ 'portal.diff.caption' | transloco: { from: d.from, to: d.to } }}
          }
        </caption>
        <thead>
          <tr>
            <th scope="col">{{ 'portal.diff.field' | transloco }}</th>
            <th scope="col">{{ 'portal.diff.before' | transloco }}</th>
            <th scope="col">{{ 'portal.diff.after' | transloco }}</th>
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track row.key) {
            <tr [class]="row.op">
              <th scope="row">
                @for (segment of row.segments; track $index; let last = $last) {
                  @if (segment.kind === 'item') {
                    <span>{{
                      'portal.diff.item' | transloco: { position: segment.position }
                    }}</span>
                  } @else if (segment.known) {
                    <span>{{ 'portal.field.' + segment.name | transloco }}</span>
                  } @else {
                    <span>{{ segment.name }}</span>
                  }
                  @if (!last) {
                    <span aria-hidden="true"> › </span>
                  }
                }
                <span class="op">{{ 'portal.diff.op.' + row.op | transloco }}</span>
              </th>
              <td>
                @if (row.oldValue !== undefined) {
                  <del>{{ row.oldValue }}</del>
                }
              </td>
              <td>
                @if (row.newValue !== undefined) {
                  <ins>{{ row.newValue }}</ins>
                }
              </td>
            </tr>
          }
        </tbody>
      </table>
    }
  `,
  styles: `
    .diff {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }
    caption {
      text-align: left;
      padding-bottom: 0.5rem;
      color: var(--color-text-muted);
    }
    th,
    td {
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid var(--color-surface-border);
      text-align: left;
      vertical-align: top;
      overflow-wrap: anywhere;
    }
    thead th {
      font-weight: 600;
      color: var(--color-text-muted);
    }
    .op {
      display: block;
      font-weight: 400;
      font-size: 0.75rem;
      color: var(--color-text-muted);
    }
    del,
    ins {
      padding: 0.1rem 0.3rem;
      border-radius: 0.3rem;
      text-decoration: none;
    }
    del {
      background: color-mix(in srgb, var(--color-error) 22%, transparent);
      text-decoration: line-through;
    }
    ins {
      background: color-mix(in srgb, var(--brand-secondary) 28%, transparent);
    }
    .empty {
      margin: 0;
      color: var(--color-text-muted);
    }
  `,
})
export class DiffViewComponent {
  /** `GET /listings/{id}/diff` response. */
  readonly diff = input.required<DiffResponse>();

  protected readonly rows = computed(() => toDiffRows(this.diff().entries));
}
