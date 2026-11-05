import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { LocaleService } from '../locale/locale.service';
import { SelectComponent, type SelectOption } from '../ui/select/select.component';
import { currencyName, currencySymbol, ORIGINAL_CURRENCY } from './currency-model';
import { CurrencyService } from './currency.service';

/**
 * Display currency of the header, next to the country: "Original currency" plus every currency
 * with a static exchange rate (`/meta` `exchangeRates`), with localized names, code badges and
 * symbols, in the shared dropdown `oe-select`. Hidden if no rates are configured.
 */
@Component({
  selector: 'oe-currency-select',
  imports: [SelectComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (currencies.currencies().length > 0) {
      <oe-select
        fieldName="currency"
        align="end"
        [label]="'currency.label' | transloco"
        [options]="options()"
        [value]="currencies.currency()"
        (valueChange)="currencies.setCurrency($event)"
      >
        <svg
          oeSelectIcon
          class="oe-select-icon"
          viewBox="0 0 24 24"
          width="18"
          height="18"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.6" />
          <path
            d="M14.8 9.2a3.2 3.2 0 0 0-5.6 1.3c0 3 5.6 1.7 5.6 4.3a3.2 3.2 0 0 1-5.6 1.2M12 6.8v1.6M12 15.9v1.6"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
      </oe-select>
    }
  `,
})
export class CurrencySelectComponent {
  protected readonly currencies = inject(CurrencyService);
  private readonly locale = inject(LocaleService);
  private readonly transloco = inject(TranslocoService);

  protected readonly options = computed<SelectOption[]>(() => {
    const locale = this.locale.active(); // re-translate on a language switch
    return [
      { value: ORIGINAL_CURRENCY, label: this.transloco.translate('currency.original') },
      ...this.currencies.currencies().map((code) => ({
        value: code,
        label: currencyName(code, locale),
        icon: code,
        meta: currencySymbol(code, locale),
      })),
    ];
  });
}
