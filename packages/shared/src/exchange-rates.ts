import * as z from 'zod';
import { Currency } from './schema/listing';

// `exchange-rates.json` (design: "Konfigurationsmodelle"): manually maintained, static exchange
// rates for display conversion in the frontend and the optional currency conversion of price
// filters (`convertCurrency=true`). Validated at `cdk synth`, at Lambda init and in the frontend.
// No rate is fetched from an external service; see docs/known-issues.md.

/** Limits of `exchange-rates.json`. */
export const EXCHANGE_RATES_BOUNDS = {
  /**
   * Currencies besides the base currency. Kept small because a converted price filter becomes
   * one condition per currency (DynamoDB limits a filter expression to 4 KB).
   */
  rates: { max: 30 },
  /** Units of a currency per one unit of the base currency. */
  rate: { min: 0.000001, max: 1_000_000_000 },
} as const;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Calendar date `YYYY-MM-DD` that exists (no `2026-02-30`). */
const IsoDate = z
  .string()
  .regex(ISO_DATE, { message: 'Expected a date YYYY-MM-DD' })
  .refine(
    (value) => {
      const date = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
    },
    { message: 'Expected an existing calendar date' },
  );

const Rate = z
  .number()
  .finite()
  .min(EXCHANGE_RATES_BOUNDS.rate.min)
  .max(EXCHANGE_RATES_BOUNDS.rate.max);

/**
 * `{ "base": "EUR", "asOf": "2026-11-01", "rates": { "THB": 37.9, "USD": 1.16 } }`: one unit of
 * `base` is worth `rates[X]` units of `X`. `base` itself is implicit (rate 1); listing it is only
 * allowed with the rate 1. Unknown keys are rejected.
 */
export const ExchangeRatesConfig = z
  .strictObject({
    base: Currency,
    /** Date the rates were taken from (informational; shown in the frontend tooltip). */
    asOf: IsoDate,
    rates: z.record(Currency, Rate),
  })
  .superRefine(({ base, rates }, ctx) => {
    const entries = Object.entries(rates).filter(([code]) => code !== base);
    if (entries.length > EXCHANGE_RATES_BOUNDS.rates.max) {
      ctx.addIssue({
        code: 'custom',
        path: ['rates'],
        message: `At most ${EXCHANGE_RATES_BOUNDS.rates.max} currencies besides the base currency`,
      });
    }
    if (Object.hasOwn(rates, base) && rates[base] !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['rates', base],
        message: `The base currency ${base} has the rate 1`,
      });
    }
  });
export type ExchangeRatesConfig = z.infer<typeof ExchangeRatesConfig>;

/** Rate of every configured currency relative to the base (base = 1). */
export function rateTable(config: ExchangeRatesConfig): ReadonlyMap<string, number> {
  return new Map([[config.base, 1], ...Object.entries(config.rates)]);
}

/** Configured currencies: the base first, then the others in code order. */
export function exchangeCurrencies(config: ExchangeRatesConfig): string[] {
  const others = Object.keys(config.rates)
    .filter((code) => code !== config.base)
    .sort();
  return [config.base, ...others];
}

/**
 * Factor that converts an amount in `from` into `to` (`amountTo = amountFrom × factor`), or
 * `undefined` if either currency has no rate. Equal currencies always convert with 1, even
 * without configuration.
 */
export function exchangeFactor(
  config: ExchangeRatesConfig | undefined,
  from: string,
  to: string,
): number | undefined {
  if (from === to) return 1;
  if (config === undefined) return undefined;
  const rates = rateTable(config);
  const rateFrom = rates.get(from);
  const rateTo = rates.get(to);
  return rateFrom === undefined || rateTo === undefined ? undefined : rateTo / rateFrom;
}

/** Converts `amount` (any unit, e.g. minor units) from `from` into `to`; not rounded. */
export function convertAmount(
  config: ExchangeRatesConfig | undefined,
  amount: number,
  from: string,
  to: string,
): number | undefined {
  const factor = exchangeFactor(config, from, to);
  return factor === undefined ? undefined : amount * factor;
}

/** Tolerance against binary floating-point noise when rounding converted bounds. */
const ROUNDING_EPSILON = 1e-6;

/** Inclusive integer bounds (e.g. minor units); an omitted bound is unbounded. */
export interface AmountBounds {
  min?: number;
  max?: number;
}

/**
 * Converts inclusive integer bounds from `from` into `to`: the lower bound is rounded up, the
 * upper bound down, so an amount matches iff its value converted back lies within the original
 * bounds (up to rounding to whole minor units). `undefined` if a rate is missing or the converted
 * range is empty. Results are capped at `Number.MAX_SAFE_INTEGER`.
 */
export function convertBounds(
  config: ExchangeRatesConfig | undefined,
  bounds: AmountBounds,
  from: string,
  to: string,
): AmountBounds | undefined {
  const factor = exchangeFactor(config, from, to);
  if (factor === undefined) return undefined;
  if (factor === 1) return { ...bounds };
  const cap = (value: number) => Math.min(value, Number.MAX_SAFE_INTEGER);
  const min =
    bounds.min === undefined ? undefined : cap(Math.ceil(bounds.min * factor - ROUNDING_EPSILON));
  const max =
    bounds.max === undefined ? undefined : cap(Math.floor(bounds.max * factor + ROUNDING_EPSILON));
  if (min !== undefined && max !== undefined && min > max) return undefined;
  return { ...(min !== undefined && { min }), ...(max !== undefined && { max }) };
}
