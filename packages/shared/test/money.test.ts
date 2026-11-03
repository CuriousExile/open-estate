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

// Inputs that are not plain non-negative decimals with ≤ 2 fraction digits.
const MALFORMED = [
  '',
  ' ',
  '-1',
  '+1',
  ' 1',
  '1 ',
  '1.',
  '.5',
  '1.234',
  '1,50',
  '1e3',
  '1E3',
  '0x10',
  'abc',
  '1.5a',
  'NaN',
  'Infinity',
  '01',
  '1_000',
];

describe('toMinor', () => {
  it.each([
    ['0', 0],
    ['0.01', 1],
    ['0.1', 10],
    ['1', 100],
    ['1250', 125_000],
    ['1250.5', 125_050],
    ['1250.05', 125_005],
    ['999999999.99', 99_999_999_999],
  ])('converts %s to %d hundredths', (input, expected) => {
    expect(toMinor(input)).toBe(expected);
  });

  it.each([
    ['0.29', 29],
    ['0.57', 57],
    ['1.15', 115],
    ['4.35', 435],
    ['1.00', 100],
    ['19.99', 1_999],
    ['8.20', 820],
  ])('is free of floating-point rounding for %s', (input, expected) => {
    // e.g. parseFloat('0.29') * 100 === 28.999999999999996
    expect(toMinor(input)).toBe(expected);
  });

  it.each(MALFORMED)('rejects malformed input %p', (input) => {
    expect(() => toMinor(input)).toThrow(RangeError);
  });

  it('rejects values too large to be represented exactly', () => {
    expect(toMinor('9999999999999.99')).toBe(999_999_999_999_999);
    expect(() => toMinor('10000000000000')).toThrow(RangeError);
  });
});

describe('formatDecimal', () => {
  it.each([
    [0, '0.00'],
    [1, '0.01'],
    [10, '0.10'],
    [100, '1.00'],
    [125_000, '1250.00'],
    [125_005, '1250.05'],
    [99_999_999_999, '999999999.99'],
  ])('formats %d as %s', (minor, expected) => {
    expect(formatDecimal(minor)).toBe(expected);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %p',
    (minor) => {
      expect(() => formatDecimal(minor)).toThrow(RangeError);
    },
  );

  it.each([1, 99, 100, 125_050, MONEY_MAX_MINOR])('round-trips %d through toMinor', (minor) => {
    expect(toMinor(formatDecimal(minor))).toBe(minor);
  });
});

describe('Money schema', () => {
  it.each([
    ['0.01', MONEY_MIN_MINOR],
    ['1250', 125_000],
    ['1250.5', 125_050],
    ['999999999.99', MONEY_MAX_MINOR],
  ])('accepts %s as %d hundredths', (input, expected) => {
    expect(Money.parse(input)).toBe(expected);
  });

  it.each(['0', '0.00', '1000000000', '1000000000.00', '9999999999', ...MALFORMED])(
    'rejects %p',
    (input) => {
      expect(Money.safeParse(input).success).toBe(false);
    },
  );

  it.each([1250, null, undefined, {}])('rejects non-string input %p', (input) => {
    expect(Money.safeParse(input).success).toBe(false);
  });
});

describe('Area schema', () => {
  it.each([
    ['1', AREA_MIN_MINOR],
    ['1.00', AREA_MIN_MINOR],
    ['72.35', 7_235],
    ['100000', AREA_MAX_MINOR],
    ['100000.00', AREA_MAX_MINOR],
  ])('accepts %s m² as %d hundredths', (input, expected) => {
    expect(Area.parse(input)).toBe(expected);
  });

  it.each(['0', '0.99', '100000.01', '1000000', ...MALFORMED])('rejects %p', (input) => {
    expect(Area.safeParse(input).success).toBe(false);
  });
});
