import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import fc from 'fast-check';
import {
  convertAmount,
  convertBounds,
  exchangeCurrencies,
  exchangeFactor,
  ExchangeRatesConfig,
  EXCHANGE_RATES_BOUNDS,
} from '../src';

const RATES: ExchangeRatesConfig = {
  base: 'EUR',
  asOf: '2026-11-01',
  rates: { THB: 40, USD: 1.25, CHF: 0.9 },
};

describe('ExchangeRatesConfig', () => {
  it('accepts the repository default file', () => {
    const file = path.join(__dirname, '..', 'src', 'config', 'exchange-rates.json');
    const parsed = ExchangeRatesConfig.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    expect(parsed.success).toBe(true);
    const currencies = parsed.success ? exchangeCurrencies(parsed.data) : [];
    expect(currencies).toEqual(expect.arrayContaining(['EUR', 'THB', 'USD', 'GBP', 'CHF']));
  });

  it('accepts a valid config and lists the base first', () => {
    expect(ExchangeRatesConfig.parse(RATES)).toEqual(RATES);
    expect(exchangeCurrencies(RATES)).toEqual(['EUR', 'CHF', 'THB', 'USD']);
  });

  it('accepts the base currency with rate 1 only', () => {
    expect(ExchangeRatesConfig.safeParse({ ...RATES, rates: { EUR: 1 } }).success).toBe(true);
    const wrong = ExchangeRatesConfig.safeParse({ ...RATES, rates: { EUR: 1.1 } });
    expect(wrong.success).toBe(false);
    expect(wrong.error?.issues.map((i) => i.path.join('.'))).toEqual(['rates.EUR']);
  });

  it.each([
    ['lower-case currency', { ...RATES, rates: { thb: 40 } }],
    ['non-positive rate', { ...RATES, rates: { THB: 0 } }],
    ['too large rate', { ...RATES, rates: { THB: EXCHANGE_RATES_BOUNDS.rate.max * 10 } }],
    ['rate as string', { ...RATES, rates: { THB: '40' } }],
    ['invalid base', { ...RATES, base: 'Euro' }],
    ['impossible date', { ...RATES, asOf: '2026-02-30' }],
    ['date with time', { ...RATES, asOf: '2026-11-01T00:00:00Z' }],
    ['missing asOf', { base: 'EUR', rates: {} }],
    ['unknown key', { ...RATES, source: 'ecb' }],
  ])('rejects %s', (_name, config) => {
    expect(ExchangeRatesConfig.safeParse(config).success).toBe(false);
  });

  it('rejects more currencies than allowed', () => {
    const rates: Record<string, number> = {};
    for (let i = 0; i <= EXCHANGE_RATES_BOUNDS.rates.max; i++) {
      rates[String.fromCharCode(65 + (i % 26), 65 + Math.floor(i / 26), 66)] = 1.5;
    }
    expect(ExchangeRatesConfig.safeParse({ ...RATES, base: 'XXX', rates }).success).toBe(false);
  });
});

describe('exchangeFactor / convertAmount', () => {
  it('converts via the base currency', () => {
    expect(exchangeFactor(RATES, 'EUR', 'THB')).toBe(40);
    expect(exchangeFactor(RATES, 'THB', 'EUR')).toBe(1 / 40);
    expect(convertAmount(RATES, 4_000_000, 'THB', 'USD')).toBeCloseTo(125_000, 6);
  });

  it('converts equal currencies with 1, even without configuration', () => {
    expect(exchangeFactor(undefined, 'GBP', 'GBP')).toBe(1);
    expect(convertAmount(RATES, 7, 'JPY', 'JPY')).toBe(7);
  });

  it('is undefined for currencies without a rate', () => {
    expect(exchangeFactor(RATES, 'EUR', 'JPY')).toBeUndefined();
    expect(exchangeFactor(undefined, 'EUR', 'THB')).toBeUndefined();
    expect(convertAmount(RATES, 1, 'JPY', 'EUR')).toBeUndefined();
  });
});

describe('convertBounds', () => {
  it('rounds the lower bound up and the upper bound down', () => {
    // 1 USD = 0.8 EUR = 32 THB; 0.9 CHF = 1 EUR.
    expect(convertBounds(RATES, { min: 101, max: 199 }, 'EUR', 'CHF')).toEqual({
      min: 91,
      max: 179,
    });
    expect(convertBounds(RATES, { max: 100_000_00 }, 'EUR', 'THB')).toEqual({ max: 4_000_000_00 });
  });

  it('keeps bounds of the same currency and drops empty ranges', () => {
    expect(convertBounds(undefined, { min: 5 }, 'EUR', 'EUR')).toEqual({ min: 5 });
    expect(convertBounds(RATES, { min: 1, max: 1 }, 'THB', 'EUR')).toBeUndefined();
    expect(convertBounds(RATES, { min: 1 }, 'EUR', 'JPY')).toBeUndefined();
  });

  it('matches exactly the amounts whose converted value lies within the bounds', () => {
    const currency = fc.constantFrom('EUR', 'THB', 'USD', 'CHF');
    fc.assert(
      fc.property(
        currency,
        currency,
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 1_000_000_000 }),
        (from, to, min, width, amount) => {
          const max = min + width;
          const bounds = convertBounds(RATES, { min, max }, from, to);
          const inTarget =
            bounds !== undefined &&
            amount >= (bounds.min ?? -Infinity) &&
            amount <= (bounds.max ?? Infinity);
          // The amount in `to`, converted back into `from` (exact up to 1 minor unit).
          const back = convertAmount(RATES, amount, to, from) ?? Number.NaN;
          if (back >= min + 1 && back <= max - 1) expect(inTarget).toBe(true);
          if (back < min - 1 || back > max + 1) expect(inTarget).toBe(false);
        },
      ),
    );
  });
});
