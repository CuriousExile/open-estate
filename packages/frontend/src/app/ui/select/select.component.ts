import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  forwardRef,
  inject,
  Injector,
  input,
  model,
  signal,
  viewChild,
} from '@angular/core';
import { NG_VALUE_ACCESSOR, type ControlValueAccessor } from '@angular/forms';
import {
  CLOSED_SELECT,
  isTypeAheadKey,
  selectKey,
  typeAheadMatch,
  TypeAheadBuffer,
  type SelectState,
} from './select-model';

/** One entry of {@link SelectComponent}. */
export interface SelectOption {
  value: string;
  /** Visible, already translated text. */
  label: string;
  /** Optional short leading badge, e.g. a country code; decorative (`aria-hidden`). */
  icon?: string;
  /** Secondary text on the right, e.g. a count. */
  meta?: string;
  /** `lang` of the label if it differs from the page (language names). */
  lang?: string;
}

/**
 * Look of the trigger: `glass` = outlined pill on dark backgrounds (header), `inline` = bare
 * value with chevron inside the light search bar, `field` = form field in the portal.
 */
export type SelectVariant = 'glass' | 'inline' | 'field';

let nextId = 0;

/**
 * Shared dropdown (WAI-ARIA APG collapsible dropdown listbox): a button with
 * `aria-haspopup="listbox"` opens a themed popover listbox that takes focus and tracks the
 * highlighted option with `aria-activedescendant`. Keyboard: arrows, Home/End, PageUp/PageDown,
 * type-ahead, Enter/Space, Escape and Tab (model: `select-model.ts`); click outside closes; focus
 * returns to the button. Works as a form control (`ControlValueAccessor`) and with signals
 * (`[(value)]`). Styles are global (`.oe-select-*`, `.oe-popover`, `.oe-option` in styles.scss),
 * shared with the city combobox.
 */
@Component({
  selector: 'oe-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => SelectComponent), multi: true },
  ],
  host: {
    class: 'oe-select',
    '[class.oe-select--block]': "variant() !== 'glass'",
    '(document:pointerdown)': 'onDocumentPointerDown($event)',
  },
  template: `
    <span class="visually-hidden" [id]="labelId">{{ label() }}</span>
    <button
      #trigger
      type="button"
      class="oe-select-trigger"
      [class]="'oe-select-trigger--' + variant()"
      [id]="triggerId() ?? defaultTriggerId"
      [attr.data-field]="fieldName()"
      aria-haspopup="listbox"
      [attr.aria-expanded]="state().open"
      [attr.aria-controls]="listId"
      [attr.aria-labelledby]="labelId + ' ' + valueId"
      [attr.aria-invalid]="invalid()"
      [attr.aria-describedby]="describedBy()"
      [disabled]="disabled()"
      (click)="toggle()"
      (keydown)="onTriggerKeydown($event)"
      (blur)="touched()"
    >
      @if (selectedOption()?.icon; as icon) {
        <span class="oe-select-icon" aria-hidden="true">{{ icon }}</span>
      } @else {
        <ng-content select="[oeSelectIcon]" />
      }
      <span class="oe-select-value" [id]="valueId" [attr.lang]="selectedOption()?.lang">{{
        selectedOption()?.label ?? placeholder()
      }}</span>
      <svg class="oe-select-chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          d="m4 6 4 4 4-4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <ul
      #list
      class="oe-popover oe-listbox"
      [class.is-open]="state().open"
      [class.oe-popover--end]="align() === 'end'"
      [class.oe-popover--up]="openUp()"
      role="listbox"
      tabindex="-1"
      [id]="listId"
      [attr.aria-labelledby]="labelId"
      [attr.aria-activedescendant]="activeId()"
      (keydown)="onListKeydown($event)"
      (focusout)="onFocusOut($event)"
    >
      @for (option of options(); track option.value; let i = $index) {
        <li
          class="oe-option"
          role="option"
          [id]="listId + '-' + i"
          [class.is-active]="i === state().active"
          [attr.aria-selected]="option.value === value()"
          [attr.lang]="option.lang"
          (mousedown)="$event.preventDefault()"
          (mousemove)="highlight(i)"
          (click)="choose(i)"
        >
          @if (option.icon) {
            <span class="oe-option-icon" aria-hidden="true">{{ option.icon }}</span>
          }
          <span class="oe-option-label">{{ option.label }}</span>
          @if (option.meta) {
            <span class="oe-option-meta">{{ option.meta }}</span>
          }
          <svg
            class="oe-option-check"
            viewBox="0 0 16 16"
            width="14"
            height="14"
            aria-hidden="true"
          >
            <path
              d="m3.5 8.5 3 3 6-7"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </li>
      }
    </ul>
  `,
})
export class SelectComponent implements ControlValueAccessor {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private readonly list = viewChild.required<ElementRef<HTMLElement>>('list');

  readonly options = input.required<readonly SelectOption[]>();
  /** Selected value; two-way bindable, also set by the form control. */
  readonly value = model('');
  /** Accessible name (translated); combined with the value via `aria-labelledby`. */
  readonly label = input.required<string>();
  /** Text if no option matches `value`. */
  readonly placeholder = input('');
  readonly variant = input<SelectVariant>('glass');
  /** Popover edge aligned with the trigger (`end` for controls at the right edge). */
  readonly align = input<'start' | 'end'>('start');
  /** `id` of the button, for a `<label for>` of the host form. */
  readonly triggerId = input<string | null>(null);
  /** `data-field` of the button (focus target of form validation). */
  readonly fieldName = input<string | null>(null);
  readonly invalid = input<'true' | null>(null);
  readonly describedBy = input<string | null>(null);

  private readonly id = nextId++;
  protected readonly defaultTriggerId = `oe-select-${this.id}`;
  protected readonly labelId = `oe-select-${this.id}-label`;
  protected readonly valueId = `oe-select-${this.id}-value`;
  protected readonly listId = `oe-select-${this.id}-list`;

  protected readonly state = signal<SelectState>(CLOSED_SELECT);
  protected readonly disabled = signal(false);
  protected readonly openUp = signal(false);
  private readonly typeAhead = new TypeAheadBuffer();

  private readonly selectedIndex = computed(() =>
    this.options().findIndex((option) => option.value === this.value()),
  );
  protected readonly selectedOption = computed(() => this.options()[this.selectedIndex()]);
  protected readonly activeId = computed(() => {
    const { open, active } = this.state();
    return open && active >= 0 ? `${this.listId}-${active}` : null;
  });

  private onChange: (value: string) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  writeValue(value: unknown): void {
    this.value.set(typeof value === 'string' ? value : value == null ? '' : String(value));
  }

  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(disabled: boolean): void {
    this.disabled.set(disabled);
    if (disabled) this.state.set(CLOSED_SELECT);
  }

  /** Focuses the button (e.g. the first invalid field after a submit). */
  focus(): void {
    this.trigger().nativeElement.focus();
  }

  protected toggle(): void {
    if (this.state().open) {
      this.close(true);
      return;
    }
    const selected = this.selectedIndex();
    this.open(selected >= 0 ? selected : 0);
  }

  protected onTriggerKeydown(event: KeyboardEvent): void {
    if (this.typeAheadKey(event)) return;
    const { state, action } = selectKey(this.state(), event.key, this.context());
    if (action.type === 'none') return;
    event.preventDefault();
    if (action.type === 'open') this.open(state.active);
  }

  protected onListKeydown(event: KeyboardEvent): void {
    if (this.typeAheadKey(event)) return;
    const { state, action } = selectKey(this.state(), event.key, this.context());
    if (action.type === 'none') return;
    if (action.type !== 'close' || action.restoreFocus) event.preventDefault();
    switch (action.type) {
      case 'move':
        this.state.set(state);
        this.scrollActiveIntoView();
        return;
      case 'select':
        this.choose(action.index);
        return;
      case 'close':
        this.close(action.restoreFocus);
        return;
    }
  }

  /** Focus left the component via keyboard (not to the button or an option). */
  protected onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (next instanceof Node && !this.host.nativeElement.contains(next)) this.close(false);
  }

  protected onDocumentPointerDown(event: Event): void {
    if (!this.state().open) return;
    if (event.target instanceof Node && this.host.nativeElement.contains(event.target)) return;
    this.close(false);
  }

  protected highlight(index: number): void {
    if (this.state().active !== index) this.state.set({ open: true, active: index });
  }

  protected choose(index: number): void {
    const option = this.options()[index];
    if (option === undefined) return;
    if (option.value !== this.value()) {
      this.value.set(option.value);
      this.onChange(option.value);
    }
    this.close(true);
  }

  protected touched(): void {
    if (!this.state().open) this.onTouched();
  }

  private context() {
    return { count: this.options().length, selected: this.selectedIndex() };
  }

  /** Printable key: opens if needed and highlights the next option starting with the typed text. */
  private typeAheadKey(event: KeyboardEvent): boolean {
    if (!isTypeAheadKey(event.key, event.ctrlKey || event.metaKey || event.altKey)) return false;
    event.preventDefault();
    const query = this.typeAhead.push(event.key, event.timeStamp || Date.now());
    const { open, active } = this.state();
    const from = open ? active : this.selectedIndex();
    const match = typeAheadMatch(
      this.options().map((option) => option.label),
      query,
      Math.max(from, 0),
    );
    if (!open) {
      this.open(match >= 0 ? match : Math.max(this.selectedIndex(), 0));
    } else if (match >= 0) {
      this.state.set({ open: true, active: match });
      this.scrollActiveIntoView();
    }
    return true;
  }

  private open(active: number): void {
    if (this.disabled() || this.options().length === 0) return;
    this.openUp.set(this.lacksRoomBelow());
    this.typeAhead.reset();
    this.state.set({ open: true, active });
    afterNextRender(
      () => {
        this.list().nativeElement.focus({ preventScroll: true });
        this.scrollActive();
      },
      { injector: this.injector },
    );
  }

  private close(restoreFocus: boolean): void {
    this.state.set(CLOSED_SELECT);
    this.typeAhead.reset();
    if (restoreFocus) this.trigger().nativeElement.focus();
    else this.onTouched();
  }

  /** Opens upwards if less than ~18rem fit below the button. */
  private lacksRoomBelow(): boolean {
    const view = this.host.nativeElement.ownerDocument.defaultView;
    if (!view) return false;
    const rect = this.trigger().nativeElement.getBoundingClientRect();
    return rect.bottom + 300 > view.innerHeight && rect.top > 300;
  }

  private scrollActiveIntoView(): void {
    afterNextRender(() => this.scrollActive(), { injector: this.injector });
  }

  private scrollActive(): void {
    const id = this.activeId();
    if (id === null) return;
    this.list()
      .nativeElement.querySelector(`#${CSS.escape(id)}`)
      ?.scrollIntoView({ block: 'nearest' });
  }
}
