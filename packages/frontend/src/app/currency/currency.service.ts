import { DOCUMENT } from '@angular/common';
import { computed, inject, Injectable, signal } from '@angular/core';
import type { DisplayCurrency } from '../listing/listing-format';
import { LocaleService } from '../locale/locale.service';
import type { StorageProvider } from '../locale/resolve-locale';
import { StartupState } from '../startup/startup-state';
import {
  availableDisplayCurrency,
  displayCurrencies,
  priceFilterCurrency,
  readStoredCurrency,
  writeStoredCurrency,
} from './currency-model';

/**
 * Display currency of the header ("Original currency" or one with a static exchange rate from
 * `/meta`) and the currency of the price filter. Remembered in `localStorage` like the country.
 */
@Injectable({ providedIn: 'root' })
export class CurrencyService {
  private readonly document = inject(DOCUMENT);
  private readonly meta = inject(StartupState).meta;
  private readonly locale = inject(LocaleService);
  private readonly storage: StorageProvider = () => this.document.defaultView?.localStorage;
  private readonly selected = signal(readStoredCurrency(this.storage));

  /** Static exchange rates from `/meta`; `undefined` without (only "Original currency"). */
  readonly rates = computed(() => this.meta().exchangeRates);
  /** Selectable currencies besides "Original currency". */
  readonly currencies = computed(() => displayCurrencies(this.rates()));
  /** Selected display currency, `''` = original currency. */
  readonly currency = computed(() => availableDisplayCurrency(this.selected(), this.rates()));
  /** Input of the price formatting of result cards and detail view. */
  readonly display = computed<DisplayCurrency>(() => ({
    currency: this.currency(),
    rates: this.rates(),
  }));
  /** Currency of the price fields (display currency or the default currency). */
  readonly priceCurrency = computed(() =>
    priceFilterCurrency(this.currency(), this.meta().defaultCurrency),
  );
  /** `asOf` of the rates, formatted for the active locale (tooltip of converted prices). */
  readonly ratesDate = computed(() => {
    const asOf = this.rates()?.asOf ?? '';
    try {
      return new Intl.DateTimeFormat(this.locale.active() || undefined, {
        dateStyle: 'medium',
        timeZone: 'UTC',
      }).format(new Date(`${asOf}T00:00:00Z`));
    } catch {
      return asOf;
    }
  });

  setCurrency(currency: string): void {
    this.selected.set(currency);
    if (!writeStoredCurrency(this.storage, currency)) {
      console.warn('[currency] could not store currency choice');
    }
  }
}
