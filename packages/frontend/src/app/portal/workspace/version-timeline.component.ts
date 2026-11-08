import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { formatDateTime } from '../../listing/listing-detail-model';
import { canRestore, type TimelineItem } from './version-timeline-model';
import { changeTypeKey, channelKey, statusKey } from './workspace-model';

/**
 * Version history as a timeline (design: VersionTimelineComponent; Req 7.5, 7.8): newest first,
 * Listenimport versions marked with connector and Connector_Lauf, two versions selectable for
 * the diff, restore of a former version if the user may restore (Req 5.6, 8.6).
 */
@Component({
  selector: 'oe-version-timeline',
  imports: [RouterLink, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ol class="timeline">
      @for (item of items(); track item.version) {
        <li [class.import]="item.isImport" [class.current]="item.current">
          <div class="head">
            <label class="compare">
              <input
                type="checkbox"
                [checked]="selected().includes(item.version)"
                (change)="toggleCompare.emit(item.version)"
              />
              <span class="label">
                {{ 'portal.workspace.history.version' | transloco: { version: item.version } }}
              </span>
              <span class="visually-hidden">{{
                'portal.workspace.history.compare' | transloco
              }}</span>
            </label>
            <span class="type">{{ changeTypeKey(item.changeType) | transloco }}</span>
            @if (item.isImport) {
              <span class="badge">{{ 'portal.workspace.history.import' | transloco }}</span>
            }
            @if (item.current) {
              <span class="badge current-badge">
                {{ 'portal.workspace.history.current' | transloco }}
              </span>
            }
            <time class="muted" [attr.datetime]="item.createdAt">
              {{ formatDateTime(item.createdAt, locale()) }}
            </time>
          </div>
          <p>
            <!-- One span: whitespace between two elements is dropped ("Portal ·User"). -->
            <span class="muted"
              >{{ channelKey(item.channel) | transloco }} ·
              {{ item.actor.kindKey | transloco }}</span
            >
            {{ item.actor.name }}
            · {{ statusKey(item.status) | transloco }}
          </p>
          @if (item.connector; as connector) {
            <p class="import-info">
              {{
                'portal.workspace.history.importInfo'
                  | transloco: { connector: connector.connectorId, runId: connector.runId }
              }}
            </p>
          }
          @if (item.autoDeactivated; as reason) {
            <p class="auto-deactivated" data-status-reason="DUPLICATE">
              {{ 'portal.workspace.history.autoDeactivated' | transloco }}
              <a [routerLink]="['/portal/listings', reason.originalId]">{{ reason.originalId }}</a>
            </p>
          }
          @if (item.restoredFrom !== undefined) {
            <p class="muted">
              {{
                'portal.workspace.history.restoredFrom' | transloco: { version: item.restoredFrom }
              }}
            </p>
          }
          @if (item.changedPaths.length > 0) {
            <p class="paths">
              <span class="muted">{{ 'portal.workspace.history.changed' | transloco }}</span>
              @for (path of item.changedPaths; track path) {
                <code [class.overwritten]="item.overwrittenPaths.includes(path)">{{ path }}</code>
              }
            </p>
          }
          @if (item.overwrittenPaths.length > 0) {
            <p class="overwritten-note">
              {{
                'portal.workspace.history.overwritten'
                  | transloco: { count: item.overwrittenPaths.length }
              }}
            </p>
          }
          @if (canRestore(item, mayRestore())) {
            <button type="button" class="pill" (click)="restore.emit(item.version)">
              {{ 'portal.workspace.history.restore' | transloco: { version: item.version } }}
            </button>
          }
        </li>
      }
    </ol>
    @if (hasMore()) {
      <button type="button" class="pill" [disabled]="loadingMore()" (click)="loadMore.emit()">
        {{ 'portal.workspace.history.more' | transloco }}
      </button>
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: 1rem;
      justify-items: start;
    }
    .timeline {
      display: grid;
      gap: 0.75rem;
      width: 100%;
      margin: 0;
      padding: 0 0 0 1rem;
      list-style: none;
      border-left: 2px solid var(--color-surface-border);
    }
    li {
      position: relative;
      display: grid;
      gap: 0.35rem;
      padding: 0.6rem 0.9rem;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-card);
    }
    li::before {
      content: '';
      position: absolute;
      left: calc(-1rem - 6px);
      top: 1rem;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--color-surface-border);
    }
    li.import::before {
      background: var(--color-accent);
    }
    li.current {
      border-color: var(--color-accent);
    }
    p {
      margin: 0;
    }
    .head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 0.9rem;
    }
    .compare {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      cursor: pointer;
    }
    .badge {
      padding: 0.05rem 0.5rem;
      border-radius: var(--radius-pill);
      background: var(--color-accent);
      color: var(--color-on-accent);
      font-size: 0.8rem;
    }
    .current-badge {
      background: var(--color-accent);
    }
    .muted {
      color: var(--color-text-muted);
    }
    .paths {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 0.5rem;
    }
    code.overwritten {
      padding: 0 0.3rem;
      border-radius: 0.25rem;
      background: color-mix(in srgb, var(--color-accent) 22%, transparent);
    }
    .overwritten-note {
      font-size: 0.9rem;
    }
    .auto-deactivated {
      color: var(--color-gold);
    }
    .auto-deactivated a {
      color: var(--color-accent);
    }
    .pill {
      justify-self: start;
      padding: 0.35rem 1rem;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-pill);
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    .pill:disabled {
      cursor: progress;
      opacity: 0.6;
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
export class VersionTimelineComponent {
  readonly items = input.required<readonly TimelineItem[]>();
  /** Versions selected for comparison. */
  readonly selected = input<readonly number[]>([]);
  readonly mayRestore = input(false);
  readonly hasMore = input(false);
  readonly loadingMore = input(false);
  readonly locale = input('');

  readonly toggleCompare = output<number>();
  readonly restore = output<number>();
  readonly loadMore = output();

  protected readonly canRestore = canRestore;
  protected readonly formatDateTime = formatDateTime;
  protected readonly changeTypeKey = changeTypeKey;
  protected readonly channelKey = channelKey;
  protected readonly statusKey = statusKey;
}
