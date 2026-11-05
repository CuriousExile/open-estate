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
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { OFFER_TYPES, type OfferType } from '@open-estate/shared';
import type { SearchParams } from '../api/api-client';
import { CurrencyService } from '../currency/currency.service';
import { CodeLabelPipe } from '../locale/code-label.pipe';
import { LocaleService } from '../locale/locale.service';
import { codeLabelKey } from '../locale/text-fallback';
import { CityComboboxComponent } from '../location/city-combobox.component';
import { StartupState } from '../startup/startup-state';
import { SelectComponent, type SelectOption } from '../ui/select/select.component';
import { EXTRA_FILTERS } from './filters/extra-filters';
import {
  activeFilterCount,
  filterErrors,
  validateWithFilters,
  type FilterValues,
} from './filters/filter-registry';
import { MoreFiltersComponent } from './filters/more-filters.component';
import { ROOMS_CHIPS } from './rooms-chips';
import type { SearchMeta } from './search-meta';
import {
  INITIAL_SEARCH_FORM_VALUES,
  type SearchFormError,
  type SearchFormField,
  type SearchFormValues,
} from './validate-search-form';

/** Values and errors to show, e.g. from a deep link (`undefined` = initial form). */
export interface SearchFormState {
  values: Required<SearchFormValues>;
  errors: readonly SearchFormError[];
}

/**
 * Search form (design: SearchFormComponent; Req 4.7, 7.1, 7.2, 12.10). A lean main bar — offer
 * type, city, property group, price and rooms chips — plus the "More filters" view rendered from
 * the filter registry (`filters/extra-filters.ts`). Validates with the shared `SearchQuery` schema
 * (+ registry rules); on errors nothing is emitted, the invalid fields are named and focused and
 * all inputs stay as typed. On success `search` emits the API parameters.
 */
@Component({
  selector: 'oe-search-form',
  imports: [
    CityComboboxComponent,
    CodeLabelPipe,
    MoreFiltersComponent,
    ReactiveFormsModule,
    SelectComponent,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.is-compact]': 'compact()' },
  template: `
    <form
      class="oe-search"
      [formGroup]="form"
      (ngSubmit)="submit()"
      novalidate
      [attr.aria-label]="'search.form' | transloco"
    >
      <fieldset
        class="oe-segmented oe-search-type"
        [attr.aria-describedby]="describedBy('offerType')"
      >
        <legend class="visually-hidden">{{ 'search.field.offerType' | transloco }}</legend>
        @for (type of offerTypes; track type) {
          <input
            type="radio"
            class="oe-segmented-input"
            [id]="'search-offerType-' + type"
            data-field="offerType"
            formControlName="offerType"
            [value]="type"
            [attr.aria-invalid]="invalid('offerType')"
          />
          <label class="oe-segmented-option" [for]="'search-offerType-' + type">{{
            type | codeLabel: 'offerType' | transloco
          }}</label>
        }
      </fieldset>

      <div class="oe-search-bar">
        <div class="oe-search-seg oe-search-seg--city">
          <label class="label" for="search-city">{{ 'search.field.city' | transloco }}</label>
          <oe-city-combobox
            formControlName="city"
            inputId="search-city"
            [invalid]="invalid('city')"
            [describedBy]="describedBy('city')"
          />
        </div>
        @if (groupOptions(); as groups) {
          <div class="oe-search-seg oe-search-seg--group">
            <label class="label" for="search-group">{{ 'search.field.group' | transloco }}</label>
            <oe-select
              variant="inline"
              triggerId="search-group"
              fieldName="group"
              formControlName="group"
              [label]="'search.field.group' | transloco"
              [options]="groups"
              [invalid]="invalid('group')"
              [describedBy]="describedBy('group')"
            />
          </div>
        }
        <fieldset class="oe-search-seg oe-search-seg--price">
          <legend class="label">
            {{ 'search.field.priceIn' | transloco: { currency: priceCurrency() } }}
          </legend>
          <div class="oe-search-pair">
            @for (field of priceFields; track field; let first = $first) {
              @if (!first) {
                <span class="oe-search-dash" aria-hidden="true">–</span>
              }
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
        <fieldset class="oe-search-seg oe-search-seg--rooms">
          <legend class="label" id="search-rooms-legend">
            {{ 'search.field.rooms' | transloco }}
          </legend>
          <div
            class="oe-chips"
            role="radiogroup"
            aria-labelledby="search-rooms-legend"
            [attr.aria-describedby]="describedBy('roomsMin')"
          >
            @for (chip of roomsChips; track chip.value; let i = $index) {
              <input
                type="radio"
                class="oe-chip-input"
                [id]="'search-rooms-' + i"
                data-field="roomsMin"
                formControlName="roomsMin"
                [value]="chip.value"
                [attr.aria-invalid]="invalid('roomsMin')"
              />
              <label class="oe-chip" [for]="'search-rooms-' + i">
                @if (chip.count; as count) {
                  <span aria-hidden="true">{{ 'search.rooms.chip' | transloco: { count } }}</span>
                  <span class="visually-hidden">{{
                    'search.rooms.atLeast' | transloco: { count }
                  }}</span>
                } @else {
                  {{ 'search.rooms.any' | transloco }}
                }
              </label>
            }
          </div>
        </fieldset>
        <button class="oe-search-submit" type="submit">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2" />
            <path d="m20 20-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
          <span class="oe-search-submit-text">{{ 'search.submit' | transloco }}</span>
        </button>
      </div>

      <button
        #moreButton
        type="button"
        class="oe-more-button"
        aria-haspopup="dialog"
        [attr.aria-expanded]="moreOpen()"
        (click)="openMore()"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            d="M4 7h10M18 7h2M4 17h4M12 17h8"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          />
          <circle cx="16" cy="7" r="2" fill="none" stroke="currentColor" stroke-width="1.8" />
          <circle cx="10" cy="17" r="2" fill="none" stroke="currentColor" stroke-width="1.8" />
        </svg>
        <span class="oe-more-label">{{ 'search.more.button' | transloco }}</span>
        @if (activeExtras() > 0) {
          <span class="oe-badge">
            <span aria-hidden="true">{{ activeExtras() }}</span>
            <span class="visually-hidden">{{
              'search.more.active' | transloco: { count: activeExtras() }
            }}</span>
          </span>
        }
      </button>

      @if (errors().length > 0) {
        <ul class="oe-search-errors" role="alert">
          @for (error of errors(); track error.field) {
            <li [id]="'search-error-' + error.field">
              <strong>{{ 'search.field.' + error.field | transloco }}:</strong>
              {{ error.messageKey | transloco: messageParams(error) }}
            </li>
          }
        </ul>
      }
    </form>

    @defer (when moreRequested(); prefetch on idle) {
      <oe-more-filters
        [open]="moreOpen()"
        [definitions]="extraFilters"
        [values]="formValue()"
        [meta]="meta"
        [initialErrors]="extraErrors()"
        [messageParams]="boundMessageParams"
        (apply)="applyMore($event)"
        (dismiss)="closeMore()"
      />
    }
  `,
})
export class SearchFormComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly locale = inject(LocaleService);
  private readonly transloco = inject(TranslocoService);
  private readonly moreButton = viewChild.required<ElementRef<HTMLButtonElement>>('moreButton');

  /** Compact layout (search bar in the sticky header after a search). */
  readonly compact = input(false);
  /** Values and errors to show (deep link, back/forward); `undefined` = initial values. */
  readonly state = input<SearchFormState | undefined>(undefined);
  /** Validated search parameters; emitted only if the form is valid (Req 7.2). */
  readonly search = output<SearchParams>();

  protected readonly meta: SearchMeta = withTaxonomyWarning(inject(StartupState).meta());
  /** Currency the price bounds are entered in (display currency or the default currency). */
  protected readonly priceCurrency = inject(CurrencyService).priceCurrency;
  protected readonly offerTypes = OFFER_TYPES;
  protected readonly priceFields = ['priceMin', 'priceMax'] as const;
  protected readonly roomsChips = ROOMS_CHIPS;
  protected readonly extraFilters = EXTRA_FILTERS;

  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly form = this.fb.group({
    ...INITIAL_SEARCH_FORM_VALUES,
    offerType: this.fb.control<OfferType | null>('SALE'),
  });
  protected readonly formValue = toSignal(this.form.valueChanges, {
    initialValue: this.form.getRawValue(),
    injector: this.injector,
  }) as () => Required<SearchFormValues>;

  protected readonly errors = signal<readonly SearchFormError[]>([]);
  private readonly errorFields = computed(() => new Set(this.errors().map((e) => e.field)));
  protected readonly extraErrors = computed(() => filterErrors(EXTRA_FILTERS, this.errors()));
  protected readonly activeExtras = computed(() =>
    activeFilterCount(EXTRA_FILTERS, this.formValue()),
  );

  /** The "More filters" view is open / was opened once (loads its lazy chunk). */
  protected readonly moreOpen = signal(false);
  protected readonly moreRequested = signal(false);

  protected readonly groupOptions = computed<SelectOption[] | undefined>(() => {
    const taxonomy = this.meta.taxonomy;
    if (taxonomy === undefined) return undefined;
    this.locale.active(); // re-translate on a language switch
    return [
      { value: '', label: this.transloco.translate('search.group.any') },
      ...taxonomy.groups.map((group) => ({
        value: group.code,
        label: this.transloco.translate(codeLabelKey('taxonomy.group', group.code)),
      })),
    ];
  });

  protected readonly boundMessageParams = (error: SearchFormError) => this.messageParams(error);

  constructor() {
    effect(() => {
      const state = this.state();
      untracked(() => this.load(state));
    });
  }

  protected submit(): void {
    const values = this.form.getRawValue();
    const result = validateWithFilters(EXTRA_FILTERS, values, this.meta);
    if ('errors' in result) {
      this.showErrors(result.errors);
      return;
    }
    this.errors.set([]);
    this.search.emit(result.params);
  }

  protected openMore(): void {
    this.moreRequested.set(true);
    this.moreOpen.set(true);
  }

  protected closeMore(): void {
    if (!this.moreOpen()) return;
    this.moreOpen.set(false);
    afterNextRender(() => this.moreButton().nativeElement.focus(), { injector: this.injector });
  }

  /** Valid draft from the "More filters" view: take it over and search. */
  protected applyMore(draft: FilterValues): void {
    this.form.patchValue(draft);
    this.moreOpen.set(false);
    this.moreButton().nativeElement.focus();
    this.submit();
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

  private load(state: SearchFormState | undefined): void {
    this.form.setValue(state?.values ?? INITIAL_SEARCH_FORM_VALUES);
    this.errors.set(state?.errors ?? []);
    this.moreOpen.set(false);
  }

  /** Names the invalid fields; focuses the first — in the "More filters" view if it is there. */
  private showErrors(errors: readonly SearchFormError[]): void {
    this.errors.set(errors);
    const first = errors[0];
    if (first === undefined) return;
    if (filterErrors(EXTRA_FILTERS, [first]).length > 0) {
      this.openMore();
      return;
    }
    const root = this.host.nativeElement;
    const target =
      root.querySelector<HTMLElement>(`[data-field="${first.field}"]:checked`) ??
      root.querySelector<HTMLElement>(`[data-field="${first.field}"]`);
    target?.focus();
  }
}

/** Missing or invalid taxonomy → no group selection, rest works. */
function withTaxonomyWarning(meta: SearchMeta): SearchMeta {
  if (meta.taxonomy === undefined) {
    console.warn('search: /meta has no valid taxonomy; the group filter is hidden');
  }
  return meta;
}
