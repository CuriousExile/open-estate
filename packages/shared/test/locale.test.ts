import { isValidLocaleTag, parseAcceptLanguage, validateLang } from '../src';

describe('validateLang', () => {
  it.each(['de', 'de-AT', 'en-US', 'zh-Hant-TW', 'sr-Latn', 'en-u-ca-gregory'])(
    'accepts %s',
    (lang) => {
      expect(validateLang(lang)).toBeUndefined();
    },
  );

  it.each([
    ['empty', ''],
    ['36 characters', `de-${'a'.repeat(8)}-${'b'.repeat(8)}-${'c'.repeat(8)}-${'d'.repeat(6)}`],
    ['nonsense', 'not a locale'],
    ['wildcard', '*'],
    ['leading whitespace', ' de'],
    ['single letter', 'a'],
  ])('rejects %s with INVALID_LOCALE on field lang', (_name, lang) => {
    expect(validateLang(lang)).toEqual({
      code: 'INVALID_LOCALE',
      field: 'lang',
      message: expect.any(String),
    });
  });

  it('enforces the 35 character boundary', () => {
    const at35 = `de-${'a'.repeat(8)}-${'b'.repeat(8)}-${'c'.repeat(8)}-${'d'.repeat(5)}`;
    expect(at35).toHaveLength(35);
    expect(isValidLocaleTag(at35)).toBe(true);
    expect(isValidLocaleTag(`${at35}d`)).toBe(false);
  });
});

describe('parseAcceptLanguage', () => {
  it.each([undefined, '', '   ', ','])('returns [] for %p', (header) => {
    expect(parseAcceptLanguage(header)).toEqual([]);
  });

  it('sorts by q descending, defaulting q to 1', () => {
    expect(parseAcceptLanguage('fr;q=0.5, de-AT, en;q=0.8')).toEqual([
      { tag: 'de-AT', q: 1 },
      { tag: 'en', q: 0.8 },
      { tag: 'fr', q: 0.5 },
    ]);
  });

  it('keeps order of appearance for equal q', () => {
    expect(parseAcceptLanguage('en;q=0.5,fr;q=0.9,de;q=0.5,it;q=0.9').map((p) => p.tag)).toEqual([
      'fr',
      'it',
      'en',
      'de',
    ]);
  });

  it('drops *, q=0 and malformed entries', () => {
    expect(
      parseAcceptLanguage(
        '*, de;q=0, nl;q=0.000, en;q=0.7, xx yy, fr;q=2, it;q=0.1234, es;q=, pt;q=abc, ;q=0.5, ja;level=1, ko;q=0.5;q=0.4, sv;Q=0.3',
      ),
    ).toEqual([
      { tag: 'en', q: 0.7 },
      { tag: 'sv', q: 0.3 },
    ]);
  });

  it('tolerates whitespace around tags and weights', () => {
    expect(parseAcceptLanguage('  de-DE ; q=0.9 ,en ;q=1.000 ,, fr;q=0.')).toEqual([
      { tag: 'en', q: 1 },
      { tag: 'de-DE', q: 0.9 },
    ]);
  });

  it('never throws on arbitrary input', () => {
    for (const header of [';;;', 'q=1', '\u0000', 'de;q=1.001', 'de;q=-0.5', ';', '=,=']) {
      expect(() => parseAcceptLanguage(header)).not.toThrow();
    }
    expect(parseAcceptLanguage('de;q=1.001,de;q=-0.5')).toEqual([]);
  });
});
