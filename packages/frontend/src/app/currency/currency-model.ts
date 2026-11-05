// Framework-free logic of the display currency (header selector) and the price filter currency.
// Kept free of Angular and DOM types so it can be unit-tested with plain Jest.
import { exchangeCurrencies, type ExchangeRatesConfig } from '@open-estate/shared';
import type { SearchParams } from '../api/api-client';
import type { LocaleStorage, StorageProvider } from '../locale/resolve-locale';

/** `localStorage` key of the display currency (next to language and country). */
export const CURRENCY_STORAGE_KEY = 'open-estate.currency';

/** "Original currency": every amount in the listing's own currency (the default). */
export const ORIGINAL_CURRENCY = '';

/** Price filter currency if `/meta` has no `defaultCurrency` (the API's documented default). */
export const FALLBACK_PRICE_CURRENCY = 'EUR';

const CURRENCY_CODE = /^[A-Z]{3}$/;

/** ISO 4217 code (upper case), or `undefined`. */
export function parseCurrencyCode(value: string | null | undefined): string | undefined {
  const code = value?.trim() ?? '';
  return CURRENCY_CODE.test(code) ? code : undefined;
}

/** Selectable display currencies: those with a rate (base first); none without rates. */
export function displayCurrencies(rates: ExchangeRatesConfig | undefined): string[] {
  return rates === undefined ? [] : exchangeCurrencies(rates);
}

/** The selection if it has a rate, else "Original currency". */
export function availableDisplayCurrency(
  selected: string,
  rates: ExchangeRatesConfig | undefined,
): string {
  return displayCurrencies(rates).includes(selected) ? selected : ORIGINAL_CURRENCY;
}

/**
 * Currency the price fields are entered in: the display currency, or the deployment's default
 * currency with "Original currency".
 */
export function priceFilterCurrency(display: string, defaultCurrency: string | undefined): string {
  return display !== ORIGINAL_CURRENCY ? display : (defaultCurrency ?? FALLBACK_PRICE_CURRENCY);
}

/**
 * API parameters of a search with the price filter currency: with a price bound, `currency` and —
 * if rates are configured — `convertCurrency=true`, so listings in other currencies match after
 * conversion; without a bound neither. `undefined` stays `undefined` (no search yet).
 */
export function withPriceCurrency(
  params: SearchParams | undefined,
  currency: string,
  rates: ExchangeRatesConfig | undefined,
): SearchParams | undefined {
  if (params === undefined) return undefined;
  const rest: SearchParams = { ...params };
  delete rest.currency;
  delete rest.convertCurrency;
  const hasPrice = Boolean(params.priceMin) || Boolean(params.priceMax);
  if (!hasPrice) return rest;
  return { ...rest, currency, ...(rates !== undefined && { convertCurrency: true }) };
}

export function readStoredCurrency(storage: StorageProvider): string {
  try {
    return parseCurrencyCode(storage()?.getItem(CURRENCY_STORAGE_KEY)) ?? ORIGINAL_CURRENCY;
  } catch {
    return ORIGINAL_CURRENCY;
  }
}

/** Stores the choice; "Original currency" removes it. `false` if storage is not accessible. */
export function writeStoredCurrency(storage: StorageProvider, currency: string): boolean {
  try {
    const target: LocaleStorage | null | undefined = storage();
    if (!target) return false;
    if (currency === ORIGINAL_CURRENCY) target.removeItem(CURRENCY_STORAGE_KEY);
    else target.setItem(CURRENCY_STORAGE_KEY, currency);
    return true;
  } catch {
    return false;
  }
}

/** Localized currency name ("Thai Baht", "Thailändischer Baht"); the code if `Intl` has none. */
export function currencyName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale || 'en'], { type: 'currency' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Narrow symbol of a currency in `locale` ("€", "฿", "CHF"); the code if `Intl` has none. */
export function currencySymbol(code: string, locale: string): string {
  try {
    const part = new Intl.NumberFormat(locale || undefined, {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
    })
      .formatToParts(0)
      .find((p) => p.type === 'currency');
    return part?.value ?? code;
  } catch {
    return code;
  }
}
