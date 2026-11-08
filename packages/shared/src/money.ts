import * as z from 'zod';
import { integer } from './schema/non-aborting';

/** Fixed scale for all currencies and areas: values are stored as integer hundredths. */
export const MINOR_UNIT_SCALE = 100;

/** Money bounds (Req 4.3, 12.2, 12.3): 0.01–999,999,999.99, in minor units. */
export const MONEY_MIN_MINOR = 1;
export const MONEY_MAX_MINOR = 99_999_999_999;

/** Area bounds in square metres (Req 4.5): 1–100,000, in hundredths. */
export const AREA_MIN_MINOR = 100;
export const AREA_MAX_MINOR = 10_000_000;

/**
 * Plot area bounds in square metres (duplicate-detection Req 1.1): 1–10,000,000, in hundredths.
 * Wider than {@link AREA_MAX_MINOR} because a plot is not a living area (10,000,000 m² = 1,000 ha).
 */
export const PLOT_AREA_MIN_MINOR = 100;
export const PLOT_AREA_MAX_MINOR = 1_000_000_000;

/**
 * Canonical plain decimal: digits only, no sign, no leading zeros (except a single "0"),
 * optional "." followed by one or two fraction digits. Rejects whitespace, "+"/"-",
 * exponent notation ("1e3"), "1." and ".5".
 */
const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;

/** 13 whole digits × 100 + 99 stays below Number.MAX_SAFE_INTEGER, so the result is exact. */
const MAX_WHOLE_DIGITS = 13;

/**
 * Converts a decimal string with at most two fraction digits (e.g. "1250.5") into integer
 * hundredths (125050). Purely string-based — never via floating-point multiplication.
 *
 * @throws RangeError if the input is not a plain non-negative decimal with ≤ 2 fraction digits
 *   or too large to be represented exactly.
 */
export function toMinor(decimal: string): number {
  const match = DECIMAL_PATTERN.exec(decimal);
  if (!match) {
    throw new RangeError(
      `Invalid decimal "${decimal}": expected digits with at most two fraction digits`,
    );
  }
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (whole.length > MAX_WHOLE_DIGITS) {
    throw new RangeError(`Decimal "${decimal}" is too large to be represented exactly`);
  }
  return Number(whole) * MINOR_UNIT_SCALE + Number(fraction.padEnd(2, '0'));
}

/**
 * Formats integer hundredths as the canonical decimal string with exactly two fraction digits
 * (125000 → "1250.00"). Inverse of {@link toMinor} for all valid amounts.
 *
 * @throws RangeError if `minor` is not a non-negative safe integer.
 */
export function formatDecimal(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new RangeError(`Invalid minor amount ${minor}: expected a non-negative safe integer`);
  }
  const fraction = minor % MINOR_UNIT_SCALE;
  const whole = (minor - fraction) / MINOR_UNIT_SCALE;
  return `${whole}.${String(fraction).padStart(2, '0')}`;
}

/** Decimal string (≤ `maxWholeDigits` whole digits, ≤ 2 fraction digits) → bounded hundredths. */
function decimalSchema(maxWholeDigits: number, minMinor: number, maxMinor: number) {
  const pattern = new RegExp(`^(0|[1-9]\\d{0,${maxWholeDigits - 1}})(\\.\\d{1,2})?$`);
  return z
    .string()
    .regex(pattern, {
      message: `Expected a decimal string with at most ${maxWholeDigits} whole and two fraction digits`,
    })
    .transform(toMinor)
    .pipe(
      integer()
        .min(minMinor, { message: `Must be at least ${formatDecimal(minMinor)}` })
        .max(maxMinor, { message: `Must be at most ${formatDecimal(maxMinor)}` }),
    );
}

/** API: decimal string "1250.00" (0.01–999999999.99, ≤ 2 fraction digits); internal: hundredths. */
export const Money = decimalSchema(9, MONEY_MIN_MINOR, MONEY_MAX_MINOR);

/** API: decimal string in m² (1–100000, ≤ 2 fraction digits); internal: hundredths of m². */
export const Area = decimalSchema(6, AREA_MIN_MINOR, AREA_MAX_MINOR);

/** API: decimal string in m² (1–10000000, ≤ 2 fraction digits); internal: hundredths of m². */
export const PlotArea = decimalSchema(8, PLOT_AREA_MIN_MINOR, PLOT_AREA_MAX_MINOR);
