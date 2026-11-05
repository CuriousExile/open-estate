import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { DiffRow } from './version-diff-model';

/**
 * Diff of two versions as a table (Req 7.8, 8.6): one row per changed value, the old value
 * highlighted as removed (`<del>`), the new one as added (`<ins>`), with hidden labels so the
 * highlighting does not rely on colour alone.
 */
@Component({
  selector: 'oe-version-diff',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (rows().length === 0) {
      <p class="muted">{{ emptyKey() | transloco }}</p>
    } @else {
      <table>
        <caption class="visually-hidden">
          {{
            captionKey() | transloco
          }}
        </caption>
        <thead>
          <tr>
            <th scope="col" class="label">{{ 'portal.workspace.diff.field' | transloco }}</th>
            <th scope="col" class="label">{{ 'portal.workspace.diff.old' | transloco }}</th>
            <th scope="col" class="label">{{ 'portal.workspace.diff.new' | transloco }}</th>
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track $index) {
            <tr>
              <th scope="row">
                <code>{{ row.path }}</code>
              </th>
              <td>
                @if (row.oldText !== undefined) {
                  <del>
                    <span class="visually-hidden">{{
                      'portal.workspace.diff.oldValue' | transloco
                    }}</span>
                    {{ row.oldText }}
                  </del>
                } @else {
                  <span class="muted">{{ 'portal.workspace.diff.absent' | transloco }}</span>
                }
              </td>
              <td>
                @if (row.newText !== undefined) {
                  <ins>
                    <span class="visually-hidden">{{
                      'portal.workspace.diff.newValue' | transloco
                    }}</span>
                    {{ row.newText }}
                  </ins>
                } @else {
                  <span class="muted">{{ 'portal.workspace.diff.absent' | transloco }}</span>
                }
              </td>
            </tr>
          }
        </tbody>
      </table>
    }
  `,
  styles: `
    :host {
      display: block;
      overflow-x: auto;
    }
    p {
      margin: 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th,
    td {
      padding: 0.4rem 0.6rem;
      text-align: left;
      vertical-align: top;
      border-bottom: 1px solid var(--color-surface-border);
      overflow-wrap: anywhere;
    }
    th[scope='row'] {
      font-weight: normal;
    }
    del,
    ins {
      display: inline-block;
      padding: 0.1rem 0.35rem;
      border-radius: 0.25rem;
      white-space: pre-wrap;
    }
    del {
      color: var(--color-error-strong);
      background: color-mix(in srgb, var(--color-error) 14%, transparent);
    }
    ins {
      text-decoration: none;
      color: var(--color-text);
      background: color-mix(in srgb, var(--color-accent) 22%, transparent);
    }
    .muted {
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
export class VersionDiffComponent {
  readonly rows = input.required<readonly DiffRow[]>();
  readonly captionKey = input('portal.workspace.diff.caption');
  readonly emptyKey = input('portal.workspace.diff.empty');
}
