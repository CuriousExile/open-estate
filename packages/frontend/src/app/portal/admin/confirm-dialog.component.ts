import {
  ChangeDetectionStrategy,
  Component,
  effect,
  type ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { Confirmation } from './admin-model';

/**
 * Modal confirmation of a destructive operation with the affected counts from the `dryRun`
 * preview (Req 10.8). Native `<dialog>`: focus stays inside, Escape cancels.
 */
@Component({
  selector: 'oe-admin-confirm-dialog',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      class="glass"
      aria-labelledby="admin-confirm-title"
      aria-describedby="admin-confirm-body"
      (cancel)="$event.preventDefault(); cancelled.emit()"
    >
      @if (confirmation(); as c) {
        <h2 id="admin-confirm-title">{{ c.title.key | transloco: c.title.params ?? {} }}</h2>
        <div id="admin-confirm-body">
          @for (line of c.lines; track line.key) {
            <p>{{ line.key | transloco: line.params ?? {} }}</p>
          }
        </div>
        <div class="actions">
          <button type="button" class="pill" (click)="cancelled.emit()">
            {{ 'portal.admin.confirm.cancel' | transloco }}
          </button>
          <button type="button" class="pill danger" [disabled]="busy()" (click)="confirmed.emit()">
            {{ c.confirmKey | transloco }}
          </button>
        </div>
      }
    </dialog>
  `,
  styles: `
    dialog {
      max-width: 32rem;
      padding: 1.25rem 1.5rem;
      border: 1px solid var(--color-surface-border);
      color: inherit;
      background: var(--color-surface);
    }
    dialog::backdrop {
      background: var(--color-scrim);
    }
    h2 {
      margin: 0 0 0.75rem;
      font-size: 1.1rem;
    }
    p {
      margin: 0 0 0.5rem;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.75rem;
      margin-top: 1rem;
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
    .pill.danger {
      border-color: var(--color-error);
      color: var(--color-error);
    }
    .pill:disabled {
      opacity: 0.5;
      cursor: default;
    }
  `,
})
export class ConfirmDialogComponent {
  /** Open while set. */
  readonly confirmation = input<Confirmation | undefined>(undefined);
  readonly busy = input(false);
  readonly confirmed = output();
  readonly cancelled = output();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    effect(() => {
      const element = this.dialog().nativeElement;
      if (this.confirmation() !== undefined) {
        if (!element.open) element.showModal();
      } else if (element.open) {
        element.close();
      }
    });
  }
}
