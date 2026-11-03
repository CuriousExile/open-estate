// Feature: real-estate-platform, Property 10: Geldbetrags- und Dezimal-Round-Trip
import fc from 'fast-check';
import {
  Area,
  AREA_MAX_MINOR,
  AREA_MIN_MINOR,
  formatDecimal,
  Money,
  MONEY_MAX_MINOR,
  MONEY_MIN_MINOR,
  toMinor,
} from '../src';

/** **Validates: Requirements 4.3, 4.5, 12.2, 12.3** */

const RUNS = { numRuns: 100 };

const SCHEMAS = [
  { name: 'Money', schema: Money, min: MONEY_MIN_MINOR, max: MONEY_MAX_MINOR },
  { name: 'Area', schema: Area, min: AREA_MIN_MINOR, max: AREA_MAX_MINOR },
] as const;

/** Canonical decimal string (no leading zeros) with exactly `fractionDigits` fraction digits. */
const arbDecimal = (maxWhole: number, fractionDigits: fc.Arbitrary<number>): fc.Arbitrary<string> =>
  fc.tuple(fc.integer({ min: 0, max: maxWhole }), fractionDigits).chain(([whole, digits]) =>
    digits === 0
      ? fc.constant(String(whole))
      : fc
          .string({
            unit: fc.constantFrom(...'0123456789'),
            minLength: digits,
            maxLength: digits,
          })
          .map((fraction) => `${whole}.${fraction}`),
  );

/** Exact rational reference: compares two decimal strings via BigInt cross-multiplication. */
function compareDecimalExact(a: string, b: string): number {
  const [aWhole = '', aFrac = ''] = a.split('.');
  const [bWhole = '', bFrac = ''] = b.split('.');
  const left = BigInt(aWhole + aFrac) * 10n ** BigInt(bFrac.length);
  const right = BigInt(bWhole + bFrac) * 10n ** BigInt(aFrac.length);
  return left === right ? 0 : left < right ? -1 : 1;
}

describe('Property 10: Geldbetrags- und Dezimal-Round-Trip', () => {
  it.each(SCHEMAS)(
    'toMinor(formatDecimal(m)) = m and $name.parse round-trips in range',
    ({ schema, min, max }) => {
      fc.assert(
        fc.property(fc.integer({ min, max }), (m) => {
          const decimal = formatDecimal(m);
          expect(toMinor(decimal)).toBe(m);
          expect(schema.parse(decimal)).toBe(m);
        }),
        RUNS,
      );
    },
  );

  it.each(SCHEMAS)('$name rejects strings with three or more fraction digits', ({ schema }) => {
    fc.assert(
      fc.property(arbDecimal(999_999, fc.integer({ min: 3, max: 6 })), (decimal) => {
        expect(schema.safeParse(decimal).success).toBe(false);
        expect(() => toMinor(decimal)).toThrow(RangeError);
      }),
      RUNS,
    );
  });

  it.each(SCHEMAS)(
    '$name rejects values below the minimum or above the maximum',
    ({ schema, min, max }) => {
      const outOfRange = fc.oneof(
        fc.integer({ min: 0, max: min - 1 }),
        fc.integer({ min: max + 1, max: max * 10 + 9 }),
      );
      fc.assert(
        fc.property(outOfRange, (m) => {
          expect(schema.safeParse(formatDecimal(m)).success).toBe(false);
        }),
        RUNS,
      );
    },
  );

  it('integer comparison of minor values matches exact decimal comparison', () => {
    const arbMoney = arbDecimal(999_999_999, fc.integer({ min: 0, max: 2 }));
    fc.assert(
      fc.property(arbMoney, arbMoney, (a, b) => {
        expect(Math.sign(toMinor(a) - toMinor(b))).toBe(compareDecimalExact(a, b));
      }),
      RUNS,
    );
  });
});
