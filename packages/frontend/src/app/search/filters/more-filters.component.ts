import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { SelectComponent, type SelectOption } from '../../ui/select/select.component';
import type { SearchMeta } from '../search-meta';
import type { SearchFormError, SearchFormField, SearchFormValues } from '../validate-search-form';
import {
  clearedFilterValues,
  filterFields,
  pickFilterValues,
  validateFilterDraft,
  type FilterDefinition,
  type FilterValues,
  type SelectFilter,
} from './filter-registry';

/**
 * "More filters" view: a modal `<dialog>` (drawer on wide screens, full-screen sheet on phones)
 * rendering the filter registry. It edits a draft; "Apply" validates the draft with the rest of
 * the form and emits it, "Reset" clears the draft, Escape/close discards it. Loaded lazily
 * (`@defer`) on first use.
 */
@Component({
  selector: 'oe-more-filters',
  imports: [SelectComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      class="more"
      aria-labelledby="more-filters-title"
      (close)="dismiss.emit()"
      (click)="onBackdropClick($event)"
    >
      <form class="sheet" novalidate (submit)="$event.preventDefault(); apply()">
        <header>
          <h2 id="more-filters-title">{{ 'search.more.title' | transloco }}</h2>
          <button type="button" class="close" (click)="dialog.close()">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6 6 18"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
            <span class="visually-hidden">{{ 'search.more.close' | transloco }}</span>
          </button>
        </header>
        <div class="body">
          @for (filter of definitions(); track filter.id) {
            @switch (filter.kind) {
              @case ('toggle') {
                <div class="row toggle-row">
                  <label class="switch" [for]="'more-' + filter.field">
                    <span class="text">
                      <span class="name">{{ filter.labelKey | transloco }}</span>
                      @if (filter.hintKey) {
                        <span class="hint">{{ filter.hintKey | transloco }}</span>
                      }
                    </span>
                    <input
                      type="checkbox"
                      role="switch"
                      class="oe-switch"
                      [id]="'more-' + filter.field"
                      [attr.data-field]="filter.field"
                      [checked]="draft()[filter.field] === true"
                      [attr.aria-invalid]="invalid(filter.field)"
                      [attr.aria-describedby]="describedBy(filter.field)"
                      (change)="set(filter.field, checked($event))"
                    />
                  </label>
                </div>
              }
              @case ('number-range') {
                <fieldset class="row">
                  <legend class="name">{{ filter.labelKey | transloco }}</legend>
                  <div class="pair">
                    @for (field of [filter.min, filter.max]; track field; let first = $first) {
                      <div class="field">
                        <label class="sub" [for]="'more-' + field">{{
                          'search.field.' + field | transloco
                        }}</label>
                        <div class="oe-input-wrap">
                          <input
                            class="oe-input"
                            [id]="'more-' + field"
                            [attr.data-field]="field"
                            inputmode="decimal"
                            autocomplete="off"
                            [placeholder]="
                              (first ? 'search.placeholder.min' : 'search.placeholder.max')
                                | transloco
                            "
                            [value]="text(field)"
                            [attr.aria-invalid]="invalid(field)"
                            [attr.aria-describedby]="describedBy(field)"
                            (input)="set(field, inputText($event))"
                          />
                          @if (filter.unitKey) {
                            <span class="unit" aria-hidden="true">{{
                              filter.unitKey | transloco
                            }}</span>
                          }
                        </div>
                      </div>
                    }
                  </div>
                </fieldset>
              }
              @case ('select') {
                @if (selectOptions(filter); as options) {
                  @if (options.length > 1) {
                    <div class="row">
                      <label class="name" [for]="'more-' + filter.field">{{
                        filter.labelKey | transloco
                      }}</label>
                      <oe-select
                        variant="field"
                        [triggerId]="'more-' + filter.field"
                        [fieldName]="filter.field"
                        [label]="filter.labelKey | transloco"
                        [options]="options"
                        [value]="text(filter.field)"
                        [invalid]="invalid(filter.field)"
                        [describedBy]="describedBy(filter.field)"
                        (valueChange)="set(filter.field, $event)"
                      />
                    </div>
                  }
                }
              }
              @default {
                <div class="row">
                  <label class="name" [for]="'more-' + filter.field">{{
                    filter.labelKey | transloco
                  }}</label>
                  <div class="oe-input-wrap">
                    <input
                      class="oe-input"
                      [id]="'more-' + filter.field"
                      [attr.data-field]="filter.field"
                      [attr.inputmode]="filter.kind === 'number' ? 'decimal' : filter.inputMode"
                      [attr.maxlength]="filter.kind === 'text' ? filter.maxLength : null"
                      [attr.autocomplete]="
                        filter.kind === 'text' ? (filter.autocomplete ?? 'off') : 'off'
                      "
                      [placeholder]="
                        filter.placeholderKey ? (filter.placeholderKey | transloco) : ''
                      "
                      [value]="text(filter.field)"
                      [attr.aria-invalid]="invalid(filter.field)"
                      [attr.aria-describedby]="describedBy(filter.field, filter.hintKey)"
                      (input)="set(filter.field, inputText($event))"
                    />
                    @if (filter.kind === 'number' && filter.unitKey) {
                      <span class="unit" aria-hidden="true">{{ filter.unitKey | transloco }}</span>
                    }
                  </div>
                  @if (filter.hintKey) {
                    <span class="hint" [id]="'more-hint-' + filter.field">{{
                      filter.hintKey | transloco
                    }}</span>
                  }
                </div>
              }
            }
            @for (field of fieldsOf(filter); track field) {
              @if (errorOf(field); as error) {
                <p class="error" [id]="'more-error-' + field">
                  {{ error.messageKey | transloco: messageParams()(error) }}
                </p>
              }
            }
          }
        </div>
        <footer>
          <button type="button" class="oe-button oe-button--ghost" (click)="reset()">
            {{ 'search.more.reset' | transloco }}
          </button>
          <button type="submit" class="oe-button oe-button--primary">
            {{ 'search.more.apply' | transloco }}
          </button>
        </footer>
      </form>
    </dialog>
  `,
  styles: `
    .more {
      width: min(28rem, 100vw);
      max-width: 100vw;
      height: 100dvh;
      max-height: 100dvh;
      margin: 0 0 0 auto;
      padding: 0;
      border: 0;
      border-left: 1px solid var(--color-gold-soft);
      background: var(--color-popover);
      color: var(--color-text);
      box-shadow: var(--shadow-sheet);
      backdrop-filter: blur(var(--blur-glass));
      transition:
        transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1),
        opacity 0.2s ease,
        overlay 0.28s allow-discrete,
        display 0.28s allow-discrete;
      transform: translateX(100%);
      opacity: 0;
    }
    .more[open] {
      transform: none;
      opacity: 1;
      @starting-style {
        transform: translateX(100%);
        opacity: 0;
      }
    }
    .more::backdrop {
      background: var(--color-scrim);
      backdrop-filter: blur(2px);
    }
    .sheet {
      display: grid;
      grid-template-rows: auto 1fr auto;
      height: 100%;
    }
    header,
    footer {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 1.25rem 1.5rem;
    }
    header {
      justify-content: space-between;
      border-bottom: 1px solid var(--color-surface-border);
    }
    h2 {
      margin: 0;
      font-family: var(--font-display);
      font-weight: 500;
      font-size: 1.5rem;
    }
    .close {
      display: grid;
      place-items: center;
      width: 2.5rem;
      height: 2.5rem;
      border: 1px solid var(--color-surface-border);
      border-radius: 50%;
      background: transparent;
      color: inherit;
      cursor: pointer;
    }
    .body {
      display: grid;
      align-content: start;
      gap: 1.5rem;
      padding: 1.5rem;
      overflow-y: auto;
    }
    .row {
      display: grid;
      gap: 0.5rem;
      margin: 0;
      padding: 0;
      border: 0;
      min-width: 0;
    }
    .name {
      padding: 0;
      font-weight: 600;
    }
    .sub,
    .hint {
      font-size: 0.8125rem;
      color: var(--color-text-muted);
    }
    .pair {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
    }
    .field {
      display: grid;
      gap: 0.3rem;
    }
    .switch {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      cursor: pointer;
    }
    .switch .text {
      display: grid;
    }
    .error {
      margin: -0.75rem 0 0;
      color: var(--color-error);
      font-size: 0.875rem;
    }
    footer {
      justify-content: flex-end;
      border-top: 1px solid var(--color-surface-border);
    }
    @media (max-width: 40rem) {
      .more {
        width: 100vw;
        border-left: 0;
        transform: translateY(100%);
      }
      .more[open] {
        @starting-style {
          transform: translateY(100%);
        }
      }
      footer .oe-button {
        flex: 1;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .more {
        transition: none;
      }
    }
  `,
})
export class MoreFiltersComponent {
  private readonly injector = inject(Injector);
  private readonly transloco = inject(TranslocoService);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  readonly open = input(false);
  readonly definitions = input.required<readonly FilterDefinition[]>();
  /** Current form values; the draft starts from them on every opening. */
  readonly values = input.required<SearchFormValues>();
  readonly meta = input<SearchMeta | undefined>(undefined);
  /** Errors of the filters to show on opening (e.g. from a deep link). */
  readonly initialErrors = input<readonly SearchFormError[]>([]);
  /** Bound formatter of error parameters (locale-aware numbers), from the search form. */
  readonly messageParams = input.required<(error: SearchFormError) => Record<string, string>>();

  /** Valid draft to merge into the form and search with. */
  readonly apply$ = output<FilterValues>({ alias: 'apply' });
  /** Closed without applying (Escape, close button, backdrop). */
  readonly dismiss = output();

  protected readonly draft = signal<FilterValues>({});
  protected readonly errors = signal<readonly SearchFormError[]>([]);
  private readonly errorMap = computed(
    () => new Map(this.errors().map((error) => [error.field, error])),
  );

  constructor() {
    effect(() => {
      const open = this.open();
      untracked(() => (open ? this.show() : this.hide()));
    });
  }

  protected fieldsOf(filter: FilterDefinition): SearchFormField[] {
    return filterFields(filter);
  }

  protected text(field: SearchFormField): string {
    const value = this.draft()[field];
    return typeof value === 'string' ? value : '';
  }

  protected set(field: SearchFormField, value: string | boolean): void {
    this.draft.update((draft) => ({ ...draft, [field]: value }));
    if (this.errorMap().has(field)) {
      this.errors.update((errors) => errors.filter((error) => error.field !== field));
    }
  }

  protected selectOptions(filter: SelectFilter): SelectOption[] {
    const meta = this.meta();
    if (meta === undefined) return [];
    return [
      { value: '', label: this.transloco.translate(filter.anyLabelKey) },
      ...filter.choices(meta).map((choice) => ({
        value: choice.value,
        label: this.transloco.translate(choice.labelKey),
      })),
    ];
  }

  protected errorOf(field: SearchFormField): SearchFormError | undefined {
    return this.errorMap().get(field);
  }

  protected invalid(field: SearchFormField): 'true' | null {
    return this.errorMap().has(field) ? 'true' : null;
  }

  protected describedBy(field: SearchFormField, hintKey?: string): string | null {
    const ids = [
      ...(hintKey ? [`more-hint-${field}`] : []),
      ...(this.errorMap().has(field) ? [`more-error-${field}`] : []),
    ];
    return ids.length > 0 ? ids.join(' ') : null;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected inputText(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected reset(): void {
    this.draft.set(clearedFilterValues(this.definitions()));
    this.errors.set([]);
  }

  protected apply(): void {
    const errors = validateFilterDraft(
      this.definitions(),
      this.values(),
      this.draft(),
      this.meta(),
    );
    this.errors.set(errors);
    const first = errors[0];
    if (first !== undefined) {
      afterNextRender(
        () =>
          this.dialog()
            ?.nativeElement.querySelector<HTMLElement>(`[data-field="${first.field}"]`)
            ?.focus(),
        { injector: this.injector },
      );
      return;
    }
    this.apply$.emit(this.draft());
  }

  /** Click on the backdrop (the dialog element itself, outside the sheet) closes. */
  protected onBackdropClick(event: MouseEvent): void {
    const dialog = this.dialog()?.nativeElement;
    if (dialog !== undefined && event.target === dialog) dialog.close();
  }

  private show(): void {
    this.draft.set(pickFilterValues(this.definitions(), this.values()));
    this.errors.set(this.initialErrors());
    afterNextRender(
      () => {
        const dialog = this.dialog()?.nativeElement;
        if (dialog === undefined) return;
        if (!dialog.open) dialog.showModal();
        const first = this.initialErrors()[0];
        if (first !== undefined) {
          dialog.querySelector<HTMLElement>(`[data-field="${first.field}"]`)?.focus();
        }
      },
      { injector: this.injector },
    );
  }

  private hide(): void {
    const dialog = this.dialog()?.nativeElement;
    if (dialog?.open) dialog.close();
  }
}
