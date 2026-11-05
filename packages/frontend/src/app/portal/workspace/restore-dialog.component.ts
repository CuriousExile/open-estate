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
import type { DiffRow } from './version-diff-model';
import { VersionDiffComponent } from './version-diff.component';

/** Content of the restore confirmation. */
export type RestoreDialogState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly rows: readonly DiffRow[] }
  /** The diff could not be loaded; restoring stays impossible. */
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Confirmation before a restore (Req 8.6): modal dialog with the Diff from the current version to
 * the version to restore and an explicit confirmation. Only the Listing_Inhalt is restored
 * (Req 8.2); status, Custom_Id and agency stay as they are.
 */
@Component({
  selector: 'oe-restore-dialog',
  imports: [TranslocoPipe, VersionDiffComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog aria-labelledby="restore-title" (cancel)="onCancel($event)">
      <h2 id="restore-title" class="label">
        {{ 'portal.workspace.restore.title' | transloco: { version: version() } }}
      </h2>
      <p>
        {{
          'portal.workspace.restore.intro'
            | transloco: { version: version(), current: currentVersion() }
        }}
      </p>
      @let s = state();
      @if (s.kind === 'loading') {
        <p role="status">{{ 'portal.workspace.restore.loading' | transloco }}</p>
      } @else if (s.kind === 'failed') {
        <p role="alert" class="error">{{ s.message }}</p>
      } @else {
        <oe-version-diff
          [rows]="s.rows"
          captionKey="portal.workspace.restore.caption"
          emptyKey="portal.workspace.restore.identical"
        />
        <p class="muted">{{ 'portal.workspace.restore.keeps' | transloco }}</p>
      }
      @if (errorMessage(); as message) {
        <div role="alert" class="error">
          <p>{{ message }}</p>
          @if (fieldErrors().length > 0) {
            <ul>
              @for (field of fieldErrors(); track $index) {
                <li>
                  <code>{{ field }}</code>
                </li>
              }
            </ul>
          }
        </div>
      }
      <div class="actions">
        <button type="button" class="pill" [disabled]="busy()" (click)="cancel.emit()">
          {{ 'portal.workspace.restore.cancel' | transloco }}
        </button>
        <button
          type="button"
          class="pill primary"
          [disabled]="busy() || s.kind !== 'ready' || s.rows.length === 0"
          (click)="confirm.emit()"
        >
          {{ 'portal.workspace.restore.confirm' | transloco: { version: version() } }}
        </button>
      </div>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(52rem, calc(100vw - 2rem));
      max-height: calc(100vh - 2rem);
      padding: 1.25rem 1.5rem;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-card);
      background: var(--color-bg);
      color: var(--color-text);
    }
    dialog::backdrop {
      background: var(--color-scrim);
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
    .muted {
      color: var(--color-text-muted);
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
    .pill.primary {
      border-color: var(--color-accent);
      background: var(--color-accent);
      color: var(--color-on-accent);
    }
    .pill:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }
  `,
})
export class RestoreDialogComponent {
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  /** Version to restore. */
  readonly version = input.required<number>();
  readonly currentVersion = input.required<number>();
  readonly state = input.required<RestoreDialogState>();
  /** The restore request is running. */
  readonly busy = input(false);
  /** Failure of the restore request (e.g. 400 for content invalid under today's rules, Req 8.4). */
  readonly errorMessage = input<string | undefined>(undefined);
  /** Fields named by a 400 answer. */
  readonly fieldErrors = input<readonly string[]>([]);

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
