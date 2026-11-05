import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  output,
  signal,
} from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { LISTING_BOUNDS, OFFER_TYPES, type OfferType } from '@open-estate/shared';
import type { SearchParams } from '../api/api-client';
import { CodeLabelPipe } from '../locale/code-label.pipe';
import { LocaleService } from '../locale/locale.service';
import { CityComboboxComponent } from '../location/city-combobox.component';
import { StartupState } from '../startup/startup-state';
import type { SearchMeta } from './search-meta';
import {
  INITIAL_SEARCH_FORM_VALUES,
  ROOM_FIELDS,
  SEARCH_FORM_ROOMS_MIN,
  validateSearchForm,
  type SearchFormError,
  type SearchFormField,
  type SearchFormValues,
} from './validate-search-form';

/** Amount ranges of the search bar (Req 7.1); rooms have their own segment. */
const RANGES = [
  { name: 'price', min: 'priceMin', max: 'priceMax' },
  { name: 'area', min: 'areaMin', max: 'areaMax' },
] as const;

/** Keys a number field accepts besides navigation/editing keys and shortcuts. */
const NUMBER_KEY = /^[0-9.,]$/;

/**
 * Search form (design: SearchFormComponent; Req 4.7, 7.1, 7.2, 12.10). Validates with the shared
 * `SearchQuery` schema; on errors nothing is emitted, the invalid fields are named and focused and
 * all inputs stay as typed. On success `search` emits the API parameters — the caller sends them
 * (together with the country chosen in the header).
 */
@Component({
  selector: 'oe-search-form',
  imports: [CityComboboxComponent, CodeLabelPipe, ReactiveFormsModule, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form
      [formGroup]="form"
      (ngSubmit)="submit()"
      novalidate
      [attr.aria-label]="'search.form' | transloco"
    >
      <fieldset class="toggle" [attr.aria-describedby]="describedBy('offerType')">
        <legend class="visually-hidden">{{ 'search.field.offerType' | transloco }}</legend>
        @for (type of offerTypes; track type) {
          <input
            type="radio"
            [id]="'search-offerType-' + type"
            data-field="offerType"
            formControlName="offerType"
            [value]="type"
            [attr.aria-invalid]="invalid('offerType')"
          />
          <label [for]="'search-offerType-' + type">{{
            type | codeLabel: 'offerType' | transloco
          }}</label>
        }
      </fieldset>

      <div class="bar">
        <div class="segment city">
          <label class="label" for="search-city">{{ 'search.field.city' | transloco }}</label>
          <oe-city-combobox
            formControlName="city"
            inputId="search-city"
            [invalid]="invalid('city')"
            [describedBy]="describedBy('city')"
          />
        </div>
        <fieldset class="segment">
          <legend class="label">{{ 'search.field.price' | transloco }}</legend>
          <div class="pair">
            @for (field of [ranges[0].min, ranges[0].max]; track field; let first = $first) {
              <label class="visually-hidden" [for]="'search-' + field">{{
                'search.field.' + field | transloco
              }}</label>
              <input
                [id]="'search-' + field"
                [attr.data-field]="field"
                [formControlName]="field"
                inputmode="decimal"
                autocomplete="off"
                [placeholder]="
                  (first ? 'search.placeholder.min' : 'search.placeholder.max') | transloco
                "
                [attr.aria-invalid]="invalid(field)"
                [attr.aria-describedby]="describedBy(field)"
              />
            }
          </div>
        </fieldset>
        <fieldset class="segment rooms" [attr.aria-describedby]="'search-rooms-unit'">
          <legend class="label">{{ 'search.field.rooms' | transloco }}</legend>
          <div class="pair">
            @for (field of roomFields; track field; let first = $first) {
              @if (!first) {
                <span class="dash" aria-hidden="true">–</span>
              }
              <label class="visually-hidden" [for]="'search-' + field">{{
                'search.field.' + field | transloco
              }}</label>
              <input
                [id]="'search-' + field"
                [attr.data-field]="field"
                [formControlName]="field"
                type="number"
                inputmode="decimal"
                autocomplete="off"
                [min]="roomsMin"
                [max]="roomsMax"
                [step]="roomsStep"
                [placeholder]="
                  (first ? 'search.placeholder.from' : 'search.placeholder.to') | transloco
                "
                [attr.aria-invalid]="invalid(field)"
                [attr.aria-describedby]="describedBy(field)"
                (keydown)="onlyNumberKeys($event)"
              />
            }
            <span class="unit" id="search-rooms-unit">{{ 'search.unit.rooms' | transloco }}</span>
          </div>
        </fieldset>
        <fieldset class="segment">
          <legend class="label">{{ 'search.field.area' | transloco }}</legend>
          <div class="pair">
            @for (field of [ranges[1].min, ranges[1].max]; track field; let first = $first) {
              <label class="visually-hidden" [for]="'search-' + field">{{
                'search.field.' + field | transloco
              }}</label>
              <input
                [id]="'search-' + field"
                [attr.data-field]="field"
                [formControlName]="field"
                inputmode="decimal"
                autocomplete="off"
                [placeholder]="
                  (first ? 'search.placeholder.min' : 'search.placeholder.max') | transloco
                "
                [attr.aria-invalid]="invalid(field)"
                [attr.aria-describedby]="describedBy(field)"
              />
            }
          </div>
        </fieldset>
        @if (meta.taxonomy; as taxonomy) {
          <div class="segment">
            <label class="label" for="search-group">{{ 'search.field.group' | transloco }}</label>
            <select
              id="search-group"
              class="oe-select oe-select--inline"
              data-field="group"
              formControlName="group"
              [attr.aria-invalid]="invalid('group')"
              [attr.aria-describedby]="describedBy('group')"
            >
              <option value="">{{ 'search.group.any' | transloco }}</option>
              @for (group of taxonomy.groups; track group.code) {
                <option [value]="group.code">
                  {{ group.code | codeLabel: 'taxonomy.group' | transloco }}
                </option>
              }
            </select>
          </div>
        }
        <button class="submit" type="submit">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2" />
            <path d="m20 20-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
          <span class="visually-hidden">{{ 'search.submit' | transloco }}</span>
        </button>
      </div>

      <div class="extras">
        <label class="tour" for="search-hasTour">
          <input
            id="search-hasTour"
            type="checkbox"
            data-field="hasTour"
            formControlName="hasTour"
            [attr.aria-invalid]="invalid('hasTour')"
            [attr.aria-describedby]="describedBy('hasTour')"
          />
          {{ 'search.field.hasTour' | transloco }}
        </label>
      </div>

      @if (errors().length > 0) {
        <ul class="errors" role="alert">
          @for (error of errors(); track error.field) {
            <li [id]="'search-error-' + error.field">
              <strong>{{ 'search.field.' + error.field | transloco }}:</strong>
              {{ error.messageKey | transloco: messageParams(error) }}
            </li>
          }
        </ul>
      }
    </form>
  `,
  styles: `
    form {
      display: grid;
      gap: 1rem;
    }
    fieldset {
      margin: 0;
      padding: 0;
      border: 0;
      min-width: 0;
    }
    input {
      font: inherit;
      color: inherit;
    }
    .toggle {
      display: inline-flex;
      justify-self: start;
      padding: 0.25rem;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-pill);
    }
    .toggle input {
      position: absolute;
      opacity: 0;
    }
    .toggle label {
      padding: 0.4rem 1.1rem;
      border-radius: var(--radius-pill);
      font-size: 0.875rem;
      cursor: pointer;
    }
    .toggle input:checked + label {
      background: var(--brand-secondary);
      color: var(--color-on-accent);
    }
    .toggle input:focus-visible + label {
      outline: 2px solid var(--brand-secondary);
      outline-offset: 2px;
    }
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem;
      padding: 0.5rem;
      border-radius: var(--radius-pill);
      background: var(--color-text);
      color: var(--color-on-accent);
    }
    .segment {
      flex: 1 1 9rem;
      display: flex;
      flex-direction: column;
      padding: 0.35rem 1.1rem;
    }
    .segment + .segment {
      border-left: 1px solid color-mix(in srgb, currentcolor 15%, transparent);
    }
    .bar .label {
      color: color-mix(in srgb, currentcolor 65%, transparent);
    }
    .bar input {
      width: 100%;
      min-width: 0;
      padding: 0.2rem 0;
      border: 0;
      background: transparent;
    }
    .pair {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    /* Rooms: a count, not an amount — whole/half numbers in a tinted field with a unit chip. */
    .rooms .pair {
      gap: 0.35rem;
    }
    .rooms input {
      padding: 0.15rem 0.5rem;
      border-radius: 0.6rem;
      background: color-mix(in srgb, var(--brand-secondary) 35%, transparent);
      text-align: center;
      appearance: textfield;
    }
    .rooms input::-webkit-inner-spin-button,
    .rooms input::-webkit-outer-spin-button {
      appearance: none;
      margin: 0;
    }
    .dash {
      opacity: 0.6;
    }
    .unit {
      flex: none;
      padding: 0.1rem 0.5rem;
      border-radius: var(--radius-pill);
      background: var(--brand-primary);
      color: var(--brand-secondary);
      font-size: 0.75rem;
      font-weight: 600;
    }
    .bar [aria-invalid='true'] {
      box-shadow: inset 0 -2px var(--color-error-strong);
    }
    .submit {
      display: grid;
      place-items: center;
      flex: none;
      width: 3.25rem;
      height: 3.25rem;
      margin-left: auto;
      border: 0;
      border-radius: 50%;
      background: var(--brand-primary);
      color: var(--brand-secondary);
      cursor: pointer;
    }
    .extras {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
    }
    /* Custom checkbox for the "has 3D tour" filter: a drawn box with a tick on :checked. */
    .tour {
      display: inline-flex;
      align-items: center;
      gap: 0.6rem;
      padding: 0.4rem 0;
      font-size: 0.875rem;
      cursor: pointer;
    }
    .tour input {
      appearance: none;
      flex: none;
      display: grid;
      place-content: center;
      width: 1.15rem;
      height: 1.15rem;
      margin: 0;
      border: 2px solid var(--color-surface-border);
      border-radius: 0.4rem;
      background: var(--color-surface);
      cursor: pointer;
    }
    .tour input::before {
      content: '';
      width: 0.6rem;
      height: 0.35rem;
      border-left: 2px solid var(--color-on-accent);
      border-bottom: 2px solid var(--color-on-accent);
      transform: rotate(-45deg) scale(0);
      transition: transform 0.12s ease;
    }
    .tour input:checked {
      background: var(--brand-secondary);
      border-color: var(--brand-secondary);
    }
    .tour input:checked::before {
      transform: rotate(-45deg) scale(1);
    }
    .tour [aria-invalid='true'] {
      border-color: var(--color-error-strong);
    }
    .errors {
      margin: 0;
      padding-left: 1.25rem;
      color: var(--color-error);
    }
    @media (max-width: 60rem) {
      .bar {
        border-radius: var(--radius-card);
      }
      .segment + .segment {
        border-left: 0;
      }
    }
  `,
})
export class SearchFormComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly locale = inject(LocaleService);

  /** Validated search parameters; emitted only if the form is valid (Req 7.2). */
  readonly search = output<SearchParams>();

  protected readonly meta: SearchMeta = withTaxonomyWarning(inject(StartupState).meta());
  protected readonly offerTypes = OFFER_TYPES;
  protected readonly ranges = RANGES;
  protected readonly roomFields = ROOM_FIELDS;
  protected readonly roomsMin = SEARCH_FORM_ROOMS_MIN;
  protected readonly roomsMax = LISTING_BOUNDS.rooms.max;
  protected readonly roomsStep = LISTING_BOUNDS.rooms.step;

  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly form = this.fb.group({
    ...INITIAL_SEARCH_FORM_VALUES,
    offerType: this.fb.control<OfferType>('SALE'),
    // `type="number"` inputs: Angular's NumberValueAccessor yields a number or null.
    roomsMin: this.fb.control<number | null>(null),
    roomsMax: this.fb.control<number | null>(null),
  });

  protected readonly errors = signal<readonly SearchFormError[]>([]);
  private readonly errorFields = computed(() => new Set(this.errors().map((e) => e.field)));

  protected submit(): void {
    const raw = this.form.getRawValue();
    const values: SearchFormValues = {
      ...raw,
      roomsMin: this.roomsText('roomsMin', raw.roomsMin),
      roomsMax: this.roomsText('roomsMax', raw.roomsMax),
    };
    const result = validateSearchForm(values, this.meta);
    if ('errors' in result) {
      this.errors.set(result.errors);
      const first = result.errors[0];
      if (first !== undefined) this.focus(first.field);
      return;
    }
    this.errors.set([]);
    this.search.emit(result.params);
  }

  /** Blocks letters and signs in number fields; editing keys and shortcuts pass. */
  protected onlyNumberKeys(event: KeyboardEvent): void {
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!NUMBER_KEY.test(event.key)) event.preventDefault();
  }

  protected invalid(field: SearchFormField): 'true' | null {
    return this.errorFields().has(field) ? 'true' : null;
  }

  protected describedBy(field: SearchFormField): string | null {
    return this.errorFields().has(field) ? `search-error-${field}` : null;
  }

  /** Bounds formatted for the active locale (e.g. "0,5" in German). */
  protected messageParams(error: SearchFormError): Record<string, string> {
    const format = new Intl.NumberFormat(this.locale.active() || undefined);
    return Object.fromEntries(
      Object.entries(error.params ?? {}).map(([key, value]) => [key, format.format(value)]),
    );
  }

  /**
   * Room input as text for the validator. A number input reports unparseable text (e.g. pasted
   * "drei") as empty with `validity.badInput`; it becomes "NaN", which the schema rejects like
   * any malformed number, instead of silently dropping the filter.
   */
  private roomsText(field: (typeof ROOM_FIELDS)[number], value: number | null): string {
    const input = this.host.nativeElement.querySelector<HTMLInputElement>(`#search-${field}`);
    if (input?.validity.badInput === true) return 'NaN';
    return value === null ? '' : String(value);
  }

  private focus(field: SearchFormField): void {
    const checked = this.host.nativeElement.querySelector<HTMLElement>(
      `[data-field="${field}"]:checked`,
    );
    (
      checked ?? this.host.nativeElement.querySelector<HTMLElement>(`[data-field="${field}"]`)
    )?.focus();
  }
}

/** Missing or invalid taxonomy → no group selection, rest works. */
function withTaxonomyWarning(meta: SearchMeta): SearchMeta {
  if (meta.taxonomy === undefined) {
    console.warn('search: /meta has no valid taxonomy; the group filter is hidden');
  }
  return meta;
}
