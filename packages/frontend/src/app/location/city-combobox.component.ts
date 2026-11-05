import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  forwardRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { NG_VALUE_ACCESSOR, type ControlValueAccessor } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { LocaleService } from '../locale/locale.service';
import {
  CLOSED_COMBOBOX,
  citySuggestions,
  comboboxKey,
  type CitySuggestion,
  type ComboboxState,
} from './location-model';
import { LocationService } from './location.service';

/** Delay between the last keystroke and updating the suggestions. */
export const CITY_SUGGESTION_DEBOUNCE_MS = 150;

let nextId = 0;

/**
 * City input with autocomplete (WAI-ARIA combobox + listbox): suggests cities that have public
 * listings, in the country chosen in the header, matching the typed prefix case- and
 * diacritic-insensitively. Free text stays allowed; the value is the typed or chosen city name.
 */
@Component({
  selector: 'oe-city-combobox',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => CityComboboxComponent),
      multi: true,
    },
  ],
  template: `
    <input
      class="oe-combobox-input"
      [id]="inputId()"
      data-field="city"
      type="text"
      role="combobox"
      autocomplete="off"
      aria-autocomplete="list"
      [attr.aria-expanded]="expanded()"
      [attr.aria-controls]="listId"
      [attr.aria-activedescendant]="activeId()"
      [attr.aria-invalid]="invalid()"
      [attr.aria-describedby]="describedBy()"
      [placeholder]="'search.placeholder.city' | transloco"
      [value]="value()"
      [disabled]="disabled()"
      (input)="onInput($event)"
      (keydown)="onKeydown($event)"
      (focus)="onFocus()"
      (blur)="onBlur()"
    />
    <ul
      class="oe-listbox"
      role="listbox"
      [id]="listId"
      [hidden]="!expanded()"
      [attr.aria-label]="'search.city.suggestions' | transloco"
    >
      @for (city of suggestions(); track city.country + city.name; let i = $index) {
        <li
          class="oe-option"
          role="option"
          [id]="listId + '-' + i"
          [attr.aria-selected]="i === state().active"
          (mousedown)="$event.preventDefault()"
          (mouseenter)="highlight(i)"
          (click)="choose(i)"
        >
          <span>{{ city.name }}</span>
          <span class="oe-option-meta">{{
            'search.city.suggestion' | transloco: { country: city.countryLabel, count: city.count }
          }}</span>
        </li>
      }
    </ul>
    <span class="visually-hidden" aria-live="polite">
      @if (expanded()) {
        {{ 'search.city.count' | transloco: { count: suggestions().length } }}
      }
    </span>
  `,
  styles: `
    :host {
      position: relative;
      display: block;
    }
    input {
      width: 100%;
      min-width: 0;
      padding: 0.2rem 0;
      border: 0;
      background: transparent;
      font: inherit;
      color: inherit;
    }
    input[aria-invalid='true'] {
      box-shadow: inset 0 -2px var(--color-error-strong);
    }
  `,
})
export class CityComboboxComponent implements ControlValueAccessor {
  private readonly locations = inject(LocationService);
  private readonly locale = inject(LocaleService);

  /** `id` of the input, for the `<label for>` of the host form. */
  readonly inputId = input('search-city');
  readonly invalid = input<'true' | null>(null);
  readonly describedBy = input<string | null>(null);

  protected readonly listId = `oe-city-listbox-${nextId++}`;
  protected readonly value = signal('');
  protected readonly disabled = signal(false);
  protected readonly state = signal<ComboboxState>(CLOSED_COMBOBOX);
  /** Debounced copy of `value` the suggestions are computed from. */
  private readonly query = signal('');
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected readonly suggestions = computed<CitySuggestion[]>(() =>
    citySuggestions(
      this.locations.locations(),
      this.query(),
      this.locations.country(),
      this.locale.active(),
    ),
  );
  protected readonly expanded = computed(() => this.state().open && this.suggestions().length > 0);
  protected readonly activeId = computed(() => {
    const { active } = this.state();
    return this.expanded() && active >= 0 ? `${this.listId}-${active}` : null;
  });

  private onChange: (value: string) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  writeValue(value: unknown): void {
    this.value.set(typeof value === 'string' ? value : '');
    this.query.set('');
    this.state.set(CLOSED_COMBOBOX);
  }

  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(disabled: boolean): void {
    this.disabled.set(disabled);
  }

  protected onInput(event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.value.set(text);
    this.onChange(text);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.query.set(text);
      this.state.set({ open: true, active: -1 });
    }, CITY_SUGGESTION_DEBOUNCE_MS);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const { state, action } = comboboxKey(
      this.expanded() ? this.state() : CLOSED_COMBOBOX,
      event.key,
      this.suggestions().length,
    );
    this.state.set(state);
    if (action.type === 'none') return;
    event.preventDefault();
    if (action.type === 'select') this.choose(action.index);
  }

  protected onFocus(): void {
    void this.locations.load();
  }

  protected onBlur(): void {
    clearTimeout(this.timer);
    this.state.set(CLOSED_COMBOBOX);
    this.onTouched();
  }

  protected highlight(index: number): void {
    this.state.set({ open: true, active: index });
  }

  protected choose(index: number): void {
    const city = this.suggestions()[index];
    if (city === undefined) return;
    this.value.set(city.name);
    this.query.set(city.name);
    this.onChange(city.name);
    this.state.set(CLOSED_COMBOBOX);
  }
}
