import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { OFFER_TYPES, type OfferType } from '@open-estate/shared';
import type { SearchParams } from '../api/api-client';
import { CodeLabelPipe } from '../locale/code-label.pipe';
import { LocaleService } from '../locale/locale.service';
import { StartupState } from '../startup/startup-state';
import type { SearchMeta } from './search-meta';
import {
  INITIAL_SEARCH_FORM_VALUES,
  validateSearchForm,
  type SearchFormError,
  type SearchFormField,
} from './validate-search-form';

/** Range segments of the search bar (Req 7.1). */
const RANGES = [
  { name: 'price', min: 'priceMin', max: 'priceMax' },
  { name: 'rooms', min: 'roomsMin', max: 'roomsMax' },
  { name: 'area', min: 'areaMin', max: 'areaMax' },
] as const;

/**
 * Search form (design: SearchFormComponent; Req 4.7, 7.1, 7.2, 12.10). Validates with the shared
 * `SearchQuery` schema; on errors nothing is emitted, the invalid fields are named and focused and
 * all inputs stay as typed. On success `search` emits the API parameters — the caller sends them.
 */
@Component({
  selector: 'oe-search-form',
  imports: [ReactiveFormsModule, TranslocoPipe, CodeLabelPipe],
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
        @for (field of textFields; track field.name) {
          <div class="segment">
            <label class="label" [for]="'search-' + field.name">{{
              'search.field.' + field.name | transloco
            }}</label>
            <input
              [id]="'search-' + field.name"
              [attr.data-field]="field.name"
              [formControlName]="field.name"
              [attr.autocomplete]="field.autocomplete"
              [placeholder]="'search.placeholder.' + field.name | transloco"
              [attr.aria-invalid]="invalid(field.name)"
              [attr.aria-describedby]="describedBy(field.name)"
            />
          </div>
        }
        @for (range of ranges; track range.name) {
          <fieldset class="segment">
            <legend class="label">{{ 'search.field.' + range.name | transloco }}</legend>
            <div class="pair">
              @for (field of [range.min, range.max]; track field; let first = $first) {
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
        }
        @if (meta.taxonomy; as taxonomy) {
          <div class="segment">
            <label class="label" for="search-group">{{ 'search.field.group' | transloco }}</label>
            <select
              id="search-group"
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
        @if (meta.taxonomy; as taxonomy) {
          <details #typesDetails>
            <summary>
              {{ 'search.field.types' | transloco }}
              @if (form.controls.types.value.length > 0) {
                ({{
                  'search.types.selected' | transloco: { count: form.controls.types.value.length }
                }})
              }
            </summary>
            <fieldset [attr.aria-describedby]="describedBy('types')">
              <legend class="visually-hidden">{{ 'search.field.types' | transloco }}</legend>
              @for (group of taxonomy.groups; track group.code) {
                <p class="label">{{ group.code | codeLabel: 'taxonomy.group' | transloco }}</p>
                <div class="chips">
                  @for (type of group.types; track type) {
                    <input
                      type="checkbox"
                      [id]="'search-type-' + type"
                      data-field="types"
                      [checked]="form.controls.types.value.includes(type)"
                      (change)="toggleType(type)"
                      [attr.aria-invalid]="invalid('types')"
                    />
                    <label [for]="'search-type-' + type">{{
                      type | codeLabel: 'taxonomy.type' | transloco
                    }}</label>
                  }
                </div>
              }
            </fieldset>
          </details>
        }
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
    input,
    select {
      font: inherit;
      color: inherit;
    }
    .toggle,
    summary,
    .chips label {
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-pill);
    }
    .toggle {
      display: inline-flex;
      justify-self: start;
      padding: 0.25rem;
    }
    .toggle input,
    .chips input {
      position: absolute;
      opacity: 0;
    }
    .toggle label,
    .chips label {
      padding: 0.4rem 1.1rem;
      border-radius: var(--radius-pill);
      font-size: 0.875rem;
      cursor: pointer;
    }
    .toggle input:checked + label,
    .chips input:checked + label {
      background: var(--brand-secondary);
      color: var(--color-on-accent);
    }
    .toggle input:focus-visible + label,
    .chips input:focus-visible + label {
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
    .bar input,
    .bar select {
      width: 100%;
      min-width: 0;
      padding: 0.2rem 0;
      border: 0;
      background: transparent;
    }
    .pair {
      display: flex;
      gap: 0.5rem;
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
      align-items: flex-start;
      gap: 1rem;
    }
    summary {
      padding: 0.4rem 1.1rem;
      cursor: pointer;
      font-size: 0.875rem;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .tour {
      display: inline-flex;
      gap: 0.5rem;
      padding: 0.4rem 0;
      font-size: 0.875rem;
    }
    .errors {
      margin: 0;
      padding-left: 1.25rem;
      color: var(--color-error);
    }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
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
  private readonly typesDetails = viewChild<ElementRef<HTMLDetailsElement>>('typesDetails');

  /** Validated search parameters; emitted only if the form is valid (Req 7.2). */
  readonly search = output<SearchParams>();

  protected readonly meta: SearchMeta = withTaxonomyWarning(inject(StartupState).meta());
  protected readonly offerTypes = OFFER_TYPES;
  protected readonly ranges = RANGES;
  protected readonly textFields = [
    { name: 'city', autocomplete: 'address-level2' },
    { name: 'postalCode', autocomplete: 'postal-code' },
  ] as const;

  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly form = this.fb.group({
    ...INITIAL_SEARCH_FORM_VALUES,
    offerType: this.fb.control<OfferType>('SALE'),
    types: new FormControl<readonly string[]>([], { nonNullable: true }),
  });

  protected readonly errors = signal<readonly SearchFormError[]>([]);
  private readonly errorFields = computed(() => new Set(this.errors().map((e) => e.field)));

  constructor() {
    // Group XOR types (Req 15.7): choosing a group clears the type selection.
    this.form.controls.group.valueChanges.pipe(takeUntilDestroyed()).subscribe((group) => {
      if (group !== '') this.form.controls.types.setValue([]);
    });
  }

  /** Ticking a type clears the group selection (group XOR types). */
  protected toggleType(type: string): void {
    const types = this.form.controls.types.value;
    const next = types.includes(type) ? types.filter((t) => t !== type) : [...types, type];
    this.form.controls.types.setValue(next);
    if (next.length > 0) this.form.controls.group.setValue('', { emitEvent: false });
  }

  protected submit(): void {
    const result = validateSearchForm(this.form.getRawValue(), this.meta);
    if ('errors' in result) {
      this.errors.set(result.errors);
      const first = result.errors[0];
      if (first !== undefined) this.focus(first.field);
      return;
    }
    this.errors.set([]);
    this.search.emit(result.params);
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

  private focus(field: SearchFormField): void {
    if (field === 'types') {
      const details = this.typesDetails()?.nativeElement;
      if (details !== undefined) details.open = true;
    }
    const checked = this.host.nativeElement.querySelector<HTMLElement>(
      `[data-field="${field}"]:checked`,
    );
    (
      checked ?? this.host.nativeElement.querySelector<HTMLElement>(`[data-field="${field}"]`)
    )?.focus();
  }
}

/** Missing or invalid taxonomy → no group/type selection, rest works. */
function withTaxonomyWarning(meta: SearchMeta): SearchMeta {
  if (meta.taxonomy === undefined) {
    console.warn('search: /meta has no valid taxonomy; group and type filters are hidden');
  }
  return meta;
}
