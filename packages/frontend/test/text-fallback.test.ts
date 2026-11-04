import de from '../public/i18n/de.json';
import en from '../public/i18n/en.json';
import {
  codeLabelKey,
  createMissingTranslationReporter,
  resolveText,
  untranslatedDisplay,
  type MissingTranslation,
} from '../src/app/locale/text-fallback';

describe('resolveText (Req 13.7, 13.8)', () => {
  const translations = {
    en: { 'home.title': 'Find your home', 'only.default': 'Default text', empty: 'x' },
    de: { 'home.title': 'Finde dein Zuhause', empty: '' },
  };

  it('uses the text of the active locale if present', () => {
    expect(resolveText('home.title', 'de', translations, 'en')).toEqual({
      text: 'Finde dein Zuhause',
    });
  });

  it('falls back to the default locale', () => {
    expect(resolveText('only.default', 'de', translations, 'en')).toEqual({
      text: 'Default text',
    });
  });

  it('treats an empty entry as absent', () => {
    expect(resolveText('empty', 'de', translations, 'en')).toEqual({ text: 'x' });
  });

  it('falls back to the default locale if the active locale has no translations at all', () => {
    expect(resolveText('home.title', 'fr', translations, 'en')).toEqual({ text: 'Find your home' });
  });

  it('returns the key and the missing entry with active locale and key', () => {
    expect(resolveText('nope', 'de', translations, 'en')).toEqual({
      text: 'nope',
      missing: { locale: 'de', key: 'nope' },
    });
  });

  it('does not resolve inherited object properties', () => {
    expect(resolveText('toString', 'de', translations, 'en').missing).toEqual({
      locale: 'de',
      key: 'toString',
    });
  });
});

describe('createMissingTranslationReporter', () => {
  it('logs each (locale, key) combination exactly once', () => {
    const logged: MissingTranslation[] = [];
    const report = createMissingTranslationReporter((m) => logged.push(m));

    report({ locale: 'de', key: 'a' });
    report({ locale: 'de', key: 'a' });
    report({ locale: 'en', key: 'a' });
    report({ locale: 'de', key: 'b' });
    report({ locale: 'de', key: 'b' });

    expect(logged).toEqual([
      { locale: 'de', key: 'a' },
      { locale: 'en', key: 'a' },
      { locale: 'de', key: 'b' },
    ]);
  });

  it('does not confuse combinations whose concatenation is equal', () => {
    const logged: MissingTranslation[] = [];
    const report = createMissingTranslationReporter((m) => logged.push(m));
    report({ locale: 'de.a', key: 'b' });
    report({ locale: 'de', key: 'a.b' });
    expect(logged).toHaveLength(2);
  });
});

describe('code labels (Req 13.1, 13.8)', () => {
  it('builds the translation keys of language-neutral codes', () => {
    expect(codeLabelKey('offerType', 'SALE')).toBe('offerType.SALE');
    expect(codeLabelKey('taxonomy.group', 'house')).toBe('taxonomy.group.house');
    expect(codeLabelKey('taxonomy.type', 'villa')).toBe('taxonomy.type.villa');
  });

  it('shows the code for untranslated code labels and the key otherwise', () => {
    expect(untranslatedDisplay('offerType.LEASE')).toBe('LEASE');
    expect(untranslatedDisplay('taxonomy.group.farm')).toBe('farm');
    expect(untranslatedDisplay('taxonomy.type.castle')).toBe('castle');
    expect(untranslatedDisplay('home.title')).toBe('home.title');
    expect(untranslatedDisplay('taxonomy.type.')).toBe('taxonomy.type.');
  });

  it('has labels for both offer types and the default taxonomy in en and de', () => {
    const keys = [
      ...['SALE', 'RENT'].map((c) => codeLabelKey('offerType', c)),
      ...['apartment', 'house', 'land', 'commercial'].map((c) => codeLabelKey('taxonomy.group', c)),
      ...[
        'apartment_unit',
        'condominium',
        'penthouse',
        'loft',
        'single_family',
        'villa',
        'terraced',
        'semi_detached',
        'building_plot',
        'office',
        'retail',
      ].map((c) => codeLabelKey('taxonomy.type', c)),
    ];
    for (const key of keys) {
      expect(resolveText(key, 'en', { en }, 'en').missing).toBeUndefined();
      expect(resolveText(key, 'de', { de }, 'de').missing).toBeUndefined();
    }
  });
});
