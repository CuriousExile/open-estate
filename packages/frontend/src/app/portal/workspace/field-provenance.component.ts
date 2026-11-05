import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { ProvenanceRow } from './field-provenance-model';
import { channelKey } from './workspace-model';

/**
 * Feldherkunft of every Inhaltsfeld (design: FieldProvenanceComponent; Req 12.15): channel, actor
 * and version of the last change; fields last overwritten by a Listenimport after a manual change
 * are highlighted with the overwritten Feldherkunft (Req 12.11).
 */
@Component({
  selector: 'oe-field-provenance',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <table>
      <caption class="visually-hidden">
        {{
          'portal.workspace.provenance.caption' | transloco
        }}
      </caption>
      <thead>
        <tr>
          <th scope="col" class="label">{{ 'portal.workspace.provenance.field' | transloco }}</th>
          <th scope="col" class="label">{{ 'portal.workspace.provenance.channel' | transloco }}</th>
          <th scope="col" class="label">{{ 'portal.workspace.provenance.actor' | transloco }}</th>
          <th scope="col" class="label">{{ 'portal.workspace.provenance.version' | transloco }}</th>
        </tr>
      </thead>
      <tbody>
        @for (row of rows(); track row.path) {
          <tr [class.overwritten]="row.overwrittenByImport">
            <th scope="row">
              <code>{{ row.path }}</code>
              @if (row.overwrittenByImport) {
                <span class="badge">{{
                  'portal.workspace.provenance.overwritten' | transloco
                }}</span>
              } @else if (row.overwrittenByImport === undefined) {
                <span class="muted">{{ 'portal.workspace.provenance.checking' | transloco }}</span>
              }
            </th>
            @if (row.source; as source) {
              <td>{{ channelKey(source.channel) | transloco }}</td>
              <td>
                <span class="muted">{{ source.actor.kindKey | transloco }}</span>
                {{ source.actor.name }}
                @if (source.actor.runId) {
                  <span class="muted">
                    {{ 'portal.workspace.run' | transloco: { runId: source.actor.runId } }}
                  </span>
                }
                @if (row.previous; as previous) {
                  @let previousChannel = channelKey(previous.channel) | transloco;
                  <span class="previous">
                    {{
                      'portal.workspace.provenance.previous'
                        | transloco
                          : {
                              channel: previousChannel,
                              actor: previous.actor.name,
                              version: previous.version,
                            }
                    }}
                  </span>
                }
              </td>
              <td>{{ source.version }}</td>
            } @else {
              <td colspan="3" class="muted">
                {{ 'portal.workspace.provenance.unknown' | transloco }}
              </td>
            }
          </tr>
        }
      </tbody>
    </table>
  `,
  styles: `
    :host {
      display: block;
      overflow-x: auto;
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
    tr.overwritten {
      background: color-mix(in srgb, var(--color-accent) 16%, transparent);
    }
    tr.overwritten th[scope='row'] {
      border-left: 3px solid var(--color-accent);
    }
    .badge {
      display: inline-block;
      margin-left: 0.5rem;
      padding: 0.05rem 0.5rem;
      border-radius: var(--radius-pill);
      background: var(--color-accent);
      color: var(--color-on-accent);
      font-size: 0.8rem;
    }
    .muted,
    .previous {
      color: var(--color-text-muted);
    }
    .previous {
      display: block;
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
export class FieldProvenanceComponent {
  readonly rows = input.required<readonly ProvenanceRow[]>();
  protected readonly channelKey = channelKey;
}
