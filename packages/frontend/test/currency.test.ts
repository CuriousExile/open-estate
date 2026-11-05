import type { ExchangeRatesConfig } from '@open-estate/shared';
import {
  availableDisplayCurrency,
  currencyName,
  currencySymbol,
  CURRENCY_STORAGE_KEY,
  displayCurrencies,
  ORIGINAL_CURRENCY,
  priceFilterCurrency,
  readStoredCurrency,
  withPriceCurrency,
  writeStoredCurrency,
} from '../src/app/currency/currency-model';
import { toListingDetail } from '../src/app/listing/listing-detail-model';
import { convertPriceInput, formatPrice } from '../src/app/listing/listing-format';
import type { LocaleStorage } from '../src/app/locale/resolve-locale';
import { toResultRow } from '../src/app/results/result-list-model';
import { parseSearchMeta } from '../src/app/search/search-meta';
import { currencyFromQuery, searchQueryParams } from '../src/app/search/search-url';

const RATES: ExchangeRatesConfig = {
  base: 'EUR',
  asOf: '2026-11-01',
  rates: { THB: 40, USD: 1.25 },
};

const PATTAYA = {
  id: 'pattaya',
  offers: [{ offerType: 'SALE' as const, price: '4200000.00', currency: 'THB' }],
};

/** `Intl` separates with (narrow) no-break spaces; compare with plain spaces. */
const plain = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value).replace(/[\u00a0\u202f]/g, ' ')) as T;

function memoryStorage(): LocaleStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => void (data[key] = value),
    removeItem: (key) => void Reflect.deleteProperty(data, key),
  };
}

describe('formatPrice', () => {
  const price = (...args: Parameters<typeof formatPrice>) => plain(formatPrice(...args));

  it('shows the original amount without a display currency or for the same currency', () => {
    expect(price('4200000.00', 'THB', 'en', undefined)).toEqual({ value: 'THB 4,200,000' });
    expect(price('4200000.00', 'THB', 'en', { currency: '', rates: RATES })).toEqual({
      value: 'THB 4,200,000',
    });
    expect(
      price('4200000.00', 'THB', 'en', { currency: 'THB', rates: RATES }).original,
    ).toBeUndefined();
  });

  it('converts into the display currency, marked as approximate, with the original amount', () => {
    expect(price('4200000.00', 'THB', 'en', { currency: 'EUR', rates: RATES })).toEqual({
      value: '≈ €105,000',
      original: 'THB 4,200,000',
    });
    // German formatting, rounded to whole units.
    expect(price('1250.50', 'EUR', 'de', { currency: 'USD', rates: RATES })).toEqual({
      value: '≈ 1.563 $',
      original: '1.250,50 €',
    });
  });

  it('keeps the original amount if a currency has no rate', () => {
    expect(price('100.00', 'JPY', 'en', { currency: 'EUR', rates: RATES })).toEqual({
      value: '¥100',
    });
    expect(price('100.00', 'THB', 'en', { currency: 'EUR' })).toEqual({ value: 'THB 100' });
  });
});

describe('result rows and detail view in the display currency', () => {
  const listing = {
    ...PATTAYA,
    title: 'Beachfront condo',
    description: '',
    deliveredLocale: 'en',
    originalLocale: 'en',
    listingType: 'condominium',
    rooms: 2,
    area: '68.00',
    address: { city: 'Pattaya', postalCode: '20150', country: 'TH' },
    sourceUrl: 'https://partner.example/pattaya',
    media: [],
    tours: [],
    source: 'demo',
    lastImportedAt: '2026-11-05T03:00:12.000Z',
    lastRunId: 'run-1',
  };
  const display = { currency: 'EUR', rates: RATES };

  it('converts the card price and keeps the original', () => {
    const row = plain(toResultRow(listing, 'SALE', 'en', display));
    expect(row.price).toBe('≈ €105,000');
    expect(row.priceOriginal).toBe('THB 4,200,000');
    expect(toResultRow(listing, 'SALE', 'en').priceOriginal).toBeUndefined();
  });

  it('converts every amount of the detail view', () => {
    const [offer] = plain(toListingDetail(listing, 'en', { display }).offers);
    expect(offer?.amounts).toEqual([
      { key: 'detail.offer.price', value: '≈ €105,000', original: 'THB 4,200,000' },
    ]);
  });
});

describe('display currency model', () => {
  it('offers the configured currencies, the base first; none without rates', () => {
    expect(displayCurrencies(RATES)).toEqual(['EUR', 'THB', 'USD']);
    expect(displayCurrencies(undefined)).toEqual([]);
  });

  it('falls back to "Original currency" for a currency without rate', () => {
    expect(availableDisplayCurrency('THB', RATES)).toBe('THB');
    expect(availableDisplayCurrency('GBP', RATES)).toBe(ORIGINAL_CURRENCY);
    expect(availableDisplayCurrency('THB', undefined)).toBe(ORIGINAL_CURRENCY);
  });

  it('enters prices in the display currency, else in the default currency', () => {
    expect(priceFilterCurrency('THB', 'EUR')).toBe('THB');
    expect(priceFilterCurrency(ORIGINAL_CURRENCY, 'CHF')).toBe('CHF');
    expect(priceFilterCurrency(ORIGINAL_CURRENCY, undefined)).toBe('EUR');
  });

  it('remembers the choice like the country', () => {
    const storage = memoryStorage();
    expect(writeStoredCurrency(() => storage, 'THB')).toBe(true);
    expect(storage.data).toEqual({ [CURRENCY_STORAGE_KEY]: 'THB' });
    expect(readStoredCurrency(() => storage)).toBe('THB');
    writeStoredCurrency(() => storage, ORIGINAL_CURRENCY);
    expect(storage.data).toEqual({});
    storage.data[CURRENCY_STORAGE_KEY] = 'thb';
    expect(readStoredCurrency(() => storage)).toBe(ORIGINAL_CURRENCY);
    expect(
      readStoredCurrency(() => {
        throw new Error('blocked');
      }),
    ).toBe(ORIGINAL_CURRENCY);
  });

  it('names currencies in the UI language', () => {
    expect(currencyName('THB', 'en')).toBe('Thai Baht');
    expect(currencyName('EUR', 'de')).toBe('Euro');
    expect(currencySymbol('EUR', 'de')).toBe('€');
  });
});

describe('price filter currency', () => {
  it('sends currency and convertCurrency only with a price bound', () => {
    expect(withPriceCurrency({ offerType: 'SALE', priceMax: '200000' }, 'EUR', RATES)).toEqual({
      offerType: 'SALE',
      priceMax: '200000',
      currency: 'EUR',
      convertCurrency: true,
    });
    expect(withPriceCurrency({ offerType: 'SALE', currency: 'EUR' }, 'EUR', RATES)).toEqual({
      offerType: 'SALE',
    });
    expect(withPriceCurrency({ offerType: 'RENT', priceMin: '1' }, 'THB', undefined)).toEqual({
      offerType: 'RENT',
      priceMin: '1',
      currency: 'THB',
    });
    expect(withPriceCurrency(undefined, 'EUR', RATES)).toBeUndefined();
  });

  it('keeps the bounds currency in the URL', () => {
    expect(searchQueryParams({ offerType: 'SALE', priceMax: '5' }, 'THB')).toEqual({
      offerType: 'SALE',
      priceMax: '5',
      currency: 'THB',
    });
    expect(searchQueryParams({ offerType: 'SALE' }, 'THB')).toEqual({ offerType: 'SALE' });
    expect(currencyFromQuery({ currency: 'THB' })).toBe('THB');
    expect(currencyFromQuery({ currency: 'thb' })).toBeUndefined();
    expect(currencyFromQuery({})).toBeUndefined();
  });

  it('converts entered bounds on a currency switch, rounded to whole units', () => {
    expect(convertPriceInput('200000', 'EUR', 'THB', RATES)).toBe('8000000');
    expect(convertPriceInput('8000000', 'THB', 'EUR', RATES)).toBe('200000');
    expect(convertPriceInput('', 'EUR', 'THB', RATES)).toBe('');
    expect(convertPriceInput('abc', 'EUR', 'THB', RATES)).toBe('abc');
    expect(convertPriceInput('5', 'EUR', 'JPY', RATES)).toBe('5');
    expect(convertPriceInput('999999999', 'EUR', 'THB', RATES)).toBe('999999999');
  });

  it('reads the exchange rates from /meta and drops invalid ones', () => {
    expect(parseSearchMeta({ exchangeRates: RATES }).exchangeRates).toEqual(RATES);
    expect(parseSearchMeta({ exchangeRates: { base: 'EUR' } }).exchangeRates).toBeUndefined();
    expect(parseSearchMeta({}).exchangeRates).toBeUndefined();
  });
});
