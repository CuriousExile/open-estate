import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { ImpactLine } from '../management-caller';

/** Preview shown in the dialog, usually the counts of a `?dryRun=true` call (Req 10.8). */
export type ConfirmDialogState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly impact: readonly ImpactLine[] }
  /** The preview failed (e.g. 409 for the last agency admin); confirming stays impossible. */
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Modal confirmation of a destructive action. All texts come from the caller as translation keys,
 * so the dialog carries no strings of its own.
 */
@Component({
  selector: 'oe-confirm-dialog',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog aria-labelledby="confirm-title" (cancel)="onCancel($event)">
      <h2 id="confirm-title" class="label">{{ titleKey() | transloco: params() }}</h2>
      <p>{{ introKey() | transloco: params() }}</p>
      @let s = state();
      @if (s.kind === 'loading') {
        <p role="status">{{ loadingKey() | transloco }}</p>
      } @else if (s.kind === 'failed') {
        <p role="alert" class="error">{{ s.message }}</p>
      } @else if (s.impact.length > 0) {
        <ul class="impact">
          @for (line of s.impact; track line.key) {
            <li>{{ line.key | transloco: line.params }}</li>
          }
        </ul>
      }
      @if (errorMessage(); as message) {
        <p role="alert" class="error">{{ message }}</p>
      }
      <div class="actions">
        <button type="button" class="pill" [disabled]="busy()" (click)="cancel.emit()">
          {{ cancelKey() | transloco }}
        </button>
        <button
          type="button"
          class="pill danger"
          [disabled]="busy() || s.kind !== 'ready'"
          (click)="confirm.emit()"
        >
          {{ confirmKey() | transloco: params() }}
        </button>
      </div>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(36rem, calc(100vw - 2rem));
      padding: 1.25rem 1.5rem;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-card);
      background: var(--color-bg);
      color: var(--color-text);
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 50%);
    }
    dialog[open] {
      display: grid;
      gap: 0.9rem;
    }
    h2,
    p,
    ul {
      margin: 0;
    }
    .impact {
      padding-left: 1.25rem;
    }
    .error {
      color: var(--color-error-strong);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
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
    .pill.danger {
      border-color: var(--color-error);
      background: var(--color-error);
      color: var(--color-on-accent);
    }
    .pill:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }
  `,
})
export class ConfirmDialogComponent {
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly titleKey = input.required<string>();
  readonly introKey = input.required<string>();
  readonly confirmKey = input.required<string>();
  readonly cancelKey = input.required<string>();
  readonly loadingKey = input.required<string>();
  /** Parameters of title, intro and confirm text (e.g. the member's name). */
  readonly params = input<Readonly<Record<string, string | number>>>({});
  readonly state = input.required<ConfirmDialogState>();
  /** The confirmed request is running. */
  readonly busy = input(false);
  /** Failure of the confirmed request. */
  readonly errorMessage = input<string | undefined>(undefined);

  readonly confirm = output();
  readonly cancel = output();

  constructor() {
    // Rendered only while open: show it modally once, so focus moves into the dialog.
    afterRenderEffect(() => {
      const dialog = this.dialog().nativeElement;
      if (!dialog.open) dialog.showModal();
    });
  }

  /** Escape closes via the parent, so the state stays in one place. */
  protected onCancel(event: Event): void {
    event.preventDefault();
    if (!this.busy()) this.cancel.emit();
  }
}
