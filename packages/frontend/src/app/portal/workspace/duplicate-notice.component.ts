import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { formatDateTime } from '../../listing/listing-detail-model';
import { ConfirmDialogComponent } from '../shared/confirm-dialog/confirm-dialog.component';
import { activationLines, type DuplicateNotice } from './duplicate-notice-model';

/**
 * Duplikat-Hinweis of the listing workspace (duplicate-detection design: DuplicateNoticeComponent;
 * Req 8.5, 13.2): the Original as link, the Übereinstimmungswert and the translated reasons of
 * every Treffer; „Trotzdem aktivieren“ (after a confirmation naming Original and reasons) and
 * „Markierung verwerfen“ as far as the user may change the status.
 */
@Component({
  selector: 'oe-duplicate-notice',
  imports: [ConfirmDialogComponent, RouterLink, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let n = notice();
    <section class="glass notice duplicate" role="status" aria-labelledby="duplicate-title">
      <h2 id="duplicate-title" class="label">{{ 'portal.duplicates.notice.title' | transloco }}</h2>
      <p>
        {{ 'portal.duplicates.notice.original' | transloco }}
        <a [routerLink]="['/portal/listings', n.originalId]" data-original>{{ n.originalId }}</a>
      </p>
      <ul class="matches">
        @for (match of n.matches; track match.listingId) {
          <li>
            <a [routerLink]="['/portal/listings', match.listingId]">{{ match.listingId }}</a>
            <span class="score">
              {{ 'portal.duplicates.notice.score' | transloco: { percent: match.percent } }}
            </span>
            <span class="reasons">
              @for (key of match.reasonKeys; track key; let last = $last) {
                {{ key | transloco }}{{ last ? '' : ', ' }}
              }
            </span>
          </li>
        }
      </ul>
      <p class="muted">
        {{
          'portal.duplicates.notice.detected.' + n.detectedBy
            | transloco: { at: formatDateTime(n.updatedAt, locale()) }
        }}
      </p>
      @if (errorMessage(); as message) {
        <p role="alert" class="error">{{ message }}</p>
      }
      @if (n.canActivate || n.canDismiss) {
        <div class="actions">
          @if (n.canActivate) {
            <button
              type="button"
              class="pill primary"
              [disabled]="busy()"
              (click)="confirming.set(true)"
            >
              {{ 'portal.duplicates.notice.activate' | transloco }}
            </button>
          }
          @if (n.canDismiss) {
            <button type="button" class="pill" [disabled]="busy()" (click)="dismiss.emit()">
              {{ 'portal.duplicates.notice.dismiss' | transloco }}
            </button>
          }
        </div>
      }
    </section>
    @if (confirming()) {
      <oe-confirm-dialog
        titleKey="portal.duplicates.activate.title"
        introKey="portal.duplicates.activate.intro"
        confirmKey="portal.duplicates.activate.confirm"
        cancelKey="portal.duplicates.activate.cancel"
        loadingKey="portal.duplicates.activate.loading"
        [params]="{ original: n.originalId }"
        [state]="{ kind: 'ready', impact: activationLines(n) }"
        [busy]="busy()"
        [errorMessage]="errorMessage()"
        (confirm)="confirming.set(false); activate.emit()"
        (cancel)="confirming.set(false)"
      />
    }
  `,
  styles: `
    .notice {
      display: grid;
      gap: 0.6rem;
      justify-items: start;
      padding: 1.25rem 1.5rem;
      border-color: var(--color-gold);
    }
    h2,
    p,
    ul {
      margin: 0;
    }
    .matches {
      display: grid;
      gap: 0.35rem;
      padding-left: 1.25rem;
    }
    .score {
      margin: 0 0.5rem;
      color: var(--color-gold);
    }
    .muted,
    .reasons {
      color: var(--color-text-muted);
    }
    .error {
      color: var(--color-error-strong);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
    }
    .pill {
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
      background: var(--color-accent);
      color: var(--color-on-accent);
    }
    .pill:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }
    a {
      color: var(--color-accent);
    }
  `,
})
export class DuplicateNoticeComponent {
  readonly notice = input.required<DuplicateNotice>();
  readonly locale = input('');
  /** An activation or dismissal is running. */
  readonly busy = input(false);
  readonly errorMessage = input<string | undefined>(undefined);

  /** Confirmed „Trotzdem aktivieren“. */
  readonly activate = output();
  readonly dismiss = output();

  protected readonly confirming = signal(false);
  protected readonly activationLines = activationLines;
  protected readonly formatDateTime = formatDateTime;
}
