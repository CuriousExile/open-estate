// Framework-free formatting of listing values, shared by result list and detail view
// (Req 7.4, 12.13). Kept free of Angular imports so it can be unit-tested with plain Jest.
import {
  convertAmount,
  type ExchangeRatesConfig,
  type LocalizedListing,
  type OfferType,
} from '@open-estate/shared';

export type ListingOffer = LocalizedListing['offers'][number];

/**
 * Offer shown for a search: the one of the filtered offer type, so a listing with `SALE` + `RENT`
 * shows its purchase price in a `SALE` search and its cold rent in a `RENT` search (Req 7.4, 12.7).
 * Without a filter (or without a matching offer) the first offer is used.
 */
export function selectOffer(
  listing: Pick<LocalizedListing, 'offers'>,
  offerType: OfferType | undefined,
): ListingOffer | undefined {
  return listing.offers.find((offer) => offer.offerType === offerType) ?? listing.offers[0];
}

/** Amount of an offer as decimal string: price for `SALE`, cold rent for `RENT` (Req 7.4). */
export function offerAmount(offer: ListingOffer): string {
  return offer.offerType === 'SALE' ? offer.price : offer.coldRent;
}

const WHOLE_AMOUNT = /^\d+(\.0{1,2})?$/;

/**
 * Formats an API decimal string with its currency for `locale` ("1250000.00", "EUR", "de" →
 * "1.250.000 €"); cents only when non-zero. `Number()` is exact enough here: the amounts have at most
 * 11 significant digits, which a double round-trips, and nothing is computed with the value. Values
 * `Intl` cannot format (malformed amount, unknown currency) are shown as delivered.
 */
export function formatMoney(amount: string, currency: string, locale: string): string {
  const value = Number(amount);
  if (amount.trim() === '' || !Number.isFinite(value)) return `${amount} ${currency}`;
  const fractionDigits = WHOLE_AMOUNT.test(amount) ? 0 : 2;
  try {
    return new Intl.NumberFormat(locale || undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** Formats a number or decimal string (rooms, area) for `locale` with up to two fraction digits. */
export function formatNumber(
  value: number | string,
  locale: string,
  maximumFractionDigits = 2,
): string {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || (typeof value === 'string' && value.trim() === '')) {
    return String(value);
  }
  return new Intl.NumberFormat(locale || undefined, { maximumFractionDigits }).format(number);
}

/**
 * Display currency of the header: `currency` `''` shows every amount in its own currency
 * ("Original currency"); otherwise amounts are converted with the static `rates` from `/meta`.
 */
export interface DisplayCurrency {
  readonly currency: string;
  readonly rates?: ExchangeRatesConfig | undefined;
}

/** A formatted amount; `original` is set iff `value` is a converted, approximate amount. */
export interface PriceView {
  readonly value: string;
  /** The amount in the listing's own currency (shown smaller below the converted one). */
  readonly original?: string;
}

/** Marks converted amounts as approximate ("≈ 110.818 €"). */
export const APPROXIMATE_SIGN = '≈';

/**
 * Amount for the display currency: unchanged without one, for the same currency or without a rate;
 * otherwise converted, rounded to whole units, prefixed with {@link APPROXIMATE_SIGN} and with the
 * original amount in `original`.
 */
export function formatPrice(
  amount: string,
  currency: string,
  locale: string,
  display: DisplayCurrency | undefined,
): PriceView {
  const original = formatMoney(amount, currency, locale);
  const target = display?.currency ?? '';
  const value = Number(amount);
  if (target === '' || target === currency || amount.trim() === '' || !Number.isFinite(value)) {
    return { value: original };
  }
  const converted = convertAmount(display?.rates, value, currency, target);
  if (converted === undefined) return { value: original };
  try {
    const text = new Intl.NumberFormat(locale || undefined, {
      style: 'currency',
      currency: target,
      maximumFractionDigits: 0,
    }).format(Math.round(converted));
    return { value: `${APPROXIMATE_SIGN}\u00a0${text}`, original };
  } catch {
    return { value: original };
  }
}

/**
 * A price bound typed in `from`, converted into `to` and rounded to whole units, e.g. when the
 * display currency changes. Empty or unparsable input and missing rates return the input.
 */
export function convertPriceInput(
  input: string,
  from: string,
  to: string,
  rates: ExchangeRatesConfig | undefined,
): string {
  const value = Number(input.trim());
  if (input.trim() === '' || !Number.isFinite(value) || from === to) return input;
  const converted = convertAmount(rates, value, from, to);
  return converted === undefined
    ? input
    : String(Math.min(PRICE_INPUT_MAX, Math.max(1, Math.round(converted))));
}

/** Largest whole amount a price filter accepts (`Money`: at most 999,999,999.99). */
const PRICE_INPUT_MAX = 999_999_999;
