// Feature: real-estate-platform, Property 27: Accept-Language-Parsing
import fc from 'fast-check';
import { isValidLocaleTag, parseAcceptLanguage, type LocalePreference } from '../src';
import { LOCALE_POOL } from './arbitraries';

/**
 * Model-based test: every generated list element carries the preference it must yield
 * (`undefined` = discarded), so the expected result is known independently of the parser.
 *
 * **Validates: Requirements 14.6**
 */

interface Entry {
  text: string;
  expected: LocalePreference | undefined;
}

/** Syntactically invalid tags (none contains ',' or ';'). */
const INVALID_TAGS = [
  '',
  '*',
  'a',
  '123',
  'de_AT',
  'en-',
  '-de',
  'not a locale',
  'toolongsub',
  `de-${'a'.repeat(8)}-${'b'.repeat(8)}-${'c'.repeat(8)}-${'d'.repeat(6)}`, // 36 characters
];

/** Values that violate the RFC 9110 qvalue grammar. */
const INVALID_QVALUES = [
  '',
  '.5',
  '-0.5',
  '1.5',
  '2',
  '1.001',
  '0.1234',
  '0,5',
  'abc',
  ' 0.5',
  '0.5 x',
  '01',
];

const ows = fc.constantFrom('', ' ', '  ', '\t');
const validTag = fc.mixedCase(fc.constantFrom(...LOCALE_POOL));
const invalidTag = fc.constantFrom(...INVALID_TAGS);
const qKey = fc.constantFrom('q=', 'Q=');

/** Valid qvalue string per RFC 9110: "0" [ "." 0*3DIGIT ] / "1" [ "." 0*3("0") ]. */
const validQValue: fc.Arbitrary<string> = fc.oneof(
  fc.constant('0'),
  fc.constant('1'),
  fc.stringMatching(/^0\.\d{0,3}$/),
  fc.stringMatching(/^1\.0{0,3}$/),
);

/** Builds `<ows>tag<ows>[;<ows>param<ows>]...` and pairs it with the expectation. */
function entry(tag: string, params: string[], pad: string[], expected: Entry['expected']): Entry {
  const [p0 = '', p1 = '', ...rest] = pad;
  const paramText = params.map((p, i) => `;${rest[i] ?? ''}${p}${rest[i] ?? ''}`).join('');
  return { text: `${p0}${tag}${p1}${paramText}`, expected };
}

const pads = fc.array(ows, { minLength: 6, maxLength: 6 });

/** Valid tag, default weight q=1. */
const arbDefaultWeight = fc
  .tuple(validTag, pads)
  .map(([tag, pad]) => entry(tag, [], pad, { tag, q: 1 }));

/** Valid tag with a valid explicit weight; q=0 means discarded. */
const arbWeighted = fc.tuple(validTag, qKey, validQValue, pads).map(([tag, key, value, pad]) => {
  const q = Number(value);
  return entry(tag, [`${key}${value}`], pad, q > 0 ? { tag, q } : undefined);
});

/** Invalid tag (incl. `*`), with or without a valid weight. */
const arbInvalidTag = fc
  .tuple(invalidTag, fc.option(validQValue, { nil: undefined }), pads)
  .map(([tag, value, pad]) =>
    entry(tag, value === undefined ? [] : [`q=${value}`], pad, undefined),
  );

/** Valid tag with a malformed weight parameter. */
const arbInvalidWeight = fc
  .tuple(
    validTag,
    fc.oneof(
      fc.constantFrom(...INVALID_QVALUES).map((v) => `q=${v}`),
      fc.constantFrom('x=0.5', 'q', 'q 0.5', 'level=1', 'q =0.5', 'q= 0.5'),
    ),
    pads,
  )
  .map(([tag, param, pad]) => entry(tag, [param], pad, undefined));

/** Valid tag with more than one parameter. */
const arbTooManyParams = fc
  .tuple(
    validTag,
    fc.array(
      validQValue.map((v) => `q=${v}`),
      { minLength: 2, maxLength: 3 },
    ),
    pads,
  )
  .map(([tag, params, pad]) => entry(tag, params, pad, undefined));

const arbEntry: fc.Arbitrary<Entry> = fc.oneof(
  { arbitrary: arbDefaultWeight, weight: 2 },
  { arbitrary: arbWeighted, weight: 4 },
  { arbitrary: arbInvalidTag, weight: 1 },
  { arbitrary: arbInvalidWeight, weight: 1 },
  { arbitrary: arbTooManyParams, weight: 1 },
);

/** Expected order without relying on sort stability: distinct q descending, then appearance. */
function expectedResult(entries: Entry[]): LocalePreference[] {
  const kept = entries.flatMap((e) => (e.expected ? [e.expected] : []));
  const weights = [...new Set(kept.map((p) => p.q))].sort((a, b) => b - a);
  return weights.flatMap((q) => kept.filter((p) => p.q === q));
}

describe('Property 27: Accept-Language-Parsing', () => {
  it('generator pools match the tag validator', () => {
    expect(LOCALE_POOL.every(isValidLocaleTag)).toBe(true);
    expect(INVALID_TAGS.filter(isValidLocaleTag)).toEqual([]);
  });

  it('keeps exactly the valid ranges with q > 0, sorted by q descending, ties in order', () => {
    fc.assert(
      fc.property(fc.array(arbEntry, { maxLength: 12 }), (entries) => {
        const header = entries.map((e) => e.text).join(',');
        expect(parseAcceptLanguage(header)).toEqual(expectedResult(entries));
      }),
      { numRuns: 100 },
    );
  });

  it('never throws on arbitrary strings and only returns valid, sorted preferences', () => {
    const headerChars = fc.constantFrom(...'abcdeqQ-*;=,. \t01235789'.split(''));
    const arbHeader = fc.oneof(fc.string({ unit: headerChars }), fc.string({ unit: 'binary' }));
    fc.assert(
      fc.property(arbHeader, (header) => {
        const result = parseAcceptLanguage(header);
        for (const [i, pref] of result.entries()) {
          expect(isValidLocaleTag(pref.tag)).toBe(true);
          expect(pref.tag).toBe(pref.tag.trim());
          expect(pref.q).toBeGreaterThan(0);
          expect(pref.q).toBeLessThanOrEqual(1);
          expect(pref.q).toBeLessThanOrEqual(result[i - 1]?.q ?? 1);
        }
      }),
      { numRuns: 100 },
    );
  });
});
