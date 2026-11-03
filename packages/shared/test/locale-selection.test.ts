import {
  resolvePreferences,
  selectLocalizedVersion,
  type LocalizableListing,
  type LocalePreference,
} from '../src';

const prefs = (...tags: string[]): LocalePreference[] => tags.map((tag) => ({ tag, q: 1 }));

function listing(original: string, ...translations: string[]): LocalizableListing {
  return {
    originalLocale: original,
    title: `title ${original}`,
    description: `description ${original}`,
    translations: translations.map((locale) => ({
      locale,
      title: `title ${locale}`,
      description: `description ${locale}`,
    })),
  };
}

const version = (locale: string) => ({
  title: `title ${locale}`,
  description: `description ${locale}`,
  deliveredLocale: locale,
});

describe('resolvePreferences', () => {
  it('uses lang as the only preference and ignores Accept-Language', () => {
    expect(resolvePreferences({ lang: 'fr-CA', acceptLanguage: 'de, en;q=0.5' })).toEqual({
      ok: true,
      value: [{ tag: 'fr-CA', q: 1 }],
    });
  });

  it.each(['', 'not a locale', 'x'.repeat(36)])('rejects invalid lang %p', (lang) => {
    expect(resolvePreferences({ lang, acceptLanguage: 'de' })).toEqual({
      ok: false,
      error: { code: 'INVALID_LOCALE', field: 'lang', message: expect.any(String) },
    });
  });

  it('parses Accept-Language when lang is absent', () => {
    expect(resolvePreferences({ acceptLanguage: 'fr;q=0.5, de-AT' })).toEqual({
      ok: true,
      value: [
        { tag: 'de-AT', q: 1 },
        { tag: 'fr', q: 0.5 },
      ],
    });
  });

  it.each([{}, { acceptLanguage: '' }, { acceptLanguage: '*, de;q=0' }])(
    'returns no preferences for %p',
    (req) => {
      expect(resolvePreferences(req)).toEqual({ ok: true, value: [] });
    },
  );
});

describe('selectLocalizedVersion', () => {
  it('selects an exact match, case-insensitively, keeping the stored spelling', () => {
    const l = listing('de', 'en-US', 'fr');
    expect(selectLocalizedVersion(l, prefs('en-US'))).toEqual(version('en-US'));
    expect(selectLocalizedVersion(l, prefs('EN-us'))).toEqual(version('en-US'));
    expect(selectLocalizedVersion(l, prefs('DE'))).toEqual(version('de'));
  });

  it('prefers an exact match over a primary-subtag match', () => {
    const l = listing('de', 'de-AT', 'de-CH');
    expect(selectLocalizedVersion(l, prefs('de-CH'))).toEqual(version('de-CH'));
  });

  it('falls back to the primary subtag in both directions', () => {
    expect(selectLocalizedVersion(listing('en', 'de'), prefs('de-AT'))).toEqual(version('de'));
    expect(selectLocalizedVersion(listing('en', 'de-AT'), prefs('de'))).toEqual(version('de-AT'));
    expect(selectLocalizedVersion(listing('en', 'DE-at'), prefs('de-CH'))).toEqual(
      version('DE-at'),
    );
  });

  it('prefers the original locale among primary-subtag candidates', () => {
    expect(selectLocalizedVersion(listing('de-DE', 'de-AT', 'de-CH'), prefs('de-LU'))).toEqual(
      version('de-DE'),
    );
  });

  it('otherwise picks the lexicographically smallest candidate (case-insensitive)', () => {
    expect(selectLocalizedVersion(listing('en', 'de-CH', 'DE-AT', 'de-LI'), prefs('de'))).toEqual(
      version('DE-AT'),
    );
    // Independent of translation order.
    expect(selectLocalizedVersion(listing('en', 'de-LI', 'de-CH', 'DE-AT'), prefs('de'))).toEqual(
      version('DE-AT'),
    );
  });

  it('checks preferences in order and returns the first one that matches', () => {
    const l = listing('de', 'en', 'fr');
    expect(selectLocalizedVersion(l, prefs('it', 'fr-BE', 'en'))).toEqual(version('fr'));
    expect(selectLocalizedVersion(l, prefs('en-GB', 'fr'))).toEqual(version('en'));
  });

  it('falls back to the original locale without a match or without preferences', () => {
    const l = listing('de', 'en');
    expect(selectLocalizedVersion(l, prefs('fr', 'it'))).toEqual(version('de'));
    expect(selectLocalizedVersion(l, [])).toEqual(version('de'));
  });

  it('takes title and description from the same version', () => {
    const l: LocalizableListing = {
      originalLocale: 'de',
      title: 'Wohnung',
      description: 'Schöne Wohnung',
      translations: [
        { locale: 'en', title: 'Flat', description: 'Nice flat' },
        { locale: 'fr', title: 'Appartement', description: 'Bel appartement' },
      ],
    };
    expect(selectLocalizedVersion(l, prefs('fr'))).toEqual({
      title: 'Appartement',
      description: 'Bel appartement',
      deliveredLocale: 'fr',
    });
    expect(selectLocalizedVersion(l, prefs('es'))).toEqual({
      title: 'Wohnung',
      description: 'Schöne Wohnung',
      deliveredLocale: 'de',
    });
  });

  it('works end-to-end with resolvePreferences (lang overrides header)', () => {
    const resolved = resolvePreferences({ lang: 'fr', acceptLanguage: 'en' });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(selectLocalizedVersion(listing('de', 'en', 'fr'), resolved.value)).toEqual(
        version('fr'),
      );
    }
  });
});
