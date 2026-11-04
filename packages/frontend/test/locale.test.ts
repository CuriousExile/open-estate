import { loadLocaleCatalog, selectAvailableLocales } from '../src/app/locale/locale-catalog';
import {
  LOCALE_STORAGE_KEY,
  matchLocale,
  readStoredLocale,
  removeStoredLocale,
  resolveLocale,
  writeStoredLocale,
  type LocaleStorage,
} from '../src/app/locale/resolve-locale';
import type { I18nConfig } from '../src/app/startup/config-schemas';
import type { JsonFetcher, StartupLogger } from '../src/app/startup/initialize';

describe('resolveLocale (Req 13.6, 13.11)', () => {
  const available = ['en', 'de', 'fr-CA'];

  it('uses the stored choice if available, ignoring browser languages', () => {
    expect(resolveLocale('de', ['fr-CA', 'en'], available, 'en')).toBe('de');
  });

  it('matches the stored choice case-insensitively and returns the configured spelling', () => {
    expect(resolveLocale('FR-ca', [], available, 'en')).toBe('fr-CA');
  });

  it('ignores a stored choice that is not available and uses the browser languages', () => {
    expect(resolveLocale('it', ['de-AT'], available, 'en')).toBe('de');
  });

  it('does not apply primary-language matching to the stored choice', () => {
    expect(resolveLocale('de-AT', [], available, 'en')).toBe('en');
  });

  it('uses the first browser language that matches, in preference order', () => {
    expect(resolveLocale(undefined, ['it', 'fr-ca', 'de'], available, 'en')).toBe('fr-CA');
  });

  it('matches a browser language via its primary language (de-AT → de)', () => {
    expect(resolveLocale(undefined, ['de-AT', 'en'], available, 'en')).toBe('de');
  });

  it('prefers an exact match over the primary language of the same browser language', () => {
    expect(resolveLocale(undefined, ['de-AT'], ['de', 'de-AT'], 'de')).toBe('de-AT');
  });

  it('does not match a bare browser language to a regional locale (de ↛ de-AT)', () => {
    expect(resolveLocale(undefined, ['de', 'de-CH'], ['en', 'de-AT'], 'en')).toBe('en');
  });

  it('falls back to the default locale without stored choice and matching browser language', () => {
    expect(resolveLocale(undefined, ['it', 'es-ES'], available, 'en')).toBe('en');
    expect(resolveLocale(undefined, [], available, 'en')).toBe('en');
  });

  it('skips empty browser language entries', () => {
    expect(resolveLocale('', ['', ' ', 'de'], available, 'en')).toBe('de');
  });
});

describe('matchLocale', () => {
  it.each([
    ['EN', 'en'],
    ['en-GB', 'en'],
    ['fr-CA', 'fr-CA'],
    ['fr', undefined],
    ['zh-Hant-TW', undefined],
  ])('%s → %s', (tag, expected) => {
    expect(matchLocale(tag, ['en', 'de', 'fr-CA'])).toBe(expected);
  });
});

describe('locale storage', () => {
  function memoryStorage(): LocaleStorage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    };
  }
  const blocked = (): LocaleStorage => {
    throw new Error('SecurityError');
  };

  it('writes, reads and removes the choice', () => {
    const storage = memoryStorage();

    expect(writeStoredLocale(() => storage, 'de')).toBe(true);
    expect(storage.data.get(LOCALE_STORAGE_KEY)).toBe('de');
    expect(readStoredLocale(() => storage)).toBe('de');
    removeStoredLocale(() => storage);
    expect(readStoredLocale(() => storage)).toBeUndefined();
  });

  it('tolerates blocked or missing storage', () => {
    expect(readStoredLocale(blocked)).toBeUndefined();
    expect(writeStoredLocale(blocked, 'de')).toBe(false);
    expect(writeStoredLocale(() => undefined, 'de')).toBe(false);
    expect(() => removeStoredLocale(blocked)).not.toThrow();
  });
});

const CONFIG: I18nConfig = {
  defaultLocale: 'en',
  enabled: [
    { locale: 'en', label: 'English' },
    { locale: 'de', label: 'Deutsch' },
    { locale: 'fr', label: 'Français' },
  ],
};
const EN = { 'home.title': 'Home' };
const DE = { 'home.title': 'Start' };

describe('selectAvailableLocales (Req 13.4, 13.12)', () => {
  it('keeps enabled locales with a loaded file in configuration order, default always', () => {
    const result = selectAvailableLocales(CONFIG, EN, {
      fr: { status: 'failed', error: '404' },
      de: { status: 'loaded', value: DE },
    });

    expect(result).toEqual({
      options: [
        { locale: 'en', label: 'English' },
        { locale: 'de', label: 'Deutsch' },
      ],
      translations: { en: EN, de: DE },
      unavailable: [{ locale: 'fr', error: '404' }],
    });
  });

  it('treats a locale without load result as unavailable', () => {
    const result = selectAvailableLocales(CONFIG, EN, {});

    expect(result.options.map((o) => o.locale)).toEqual(['en']);
    expect(result.unavailable.map((u) => u.locale)).toEqual(['de', 'fr']);
  });
});

describe('loadLocaleCatalog', () => {
  let log: jest.MockedFunction<StartupLogger>;
  beforeEach(() => {
    log = jest.fn();
  });

  function fetcher(files: Record<string, unknown>): JsonFetcher & { calls: string[] } {
    const calls: string[] = [];
    const fn = async (url: string): Promise<unknown> => {
      calls.push(url);
      if (!(url in files)) throw new Error(`404 ${url}`);
      return files[url];
    };
    return Object.assign(fn, { calls });
  }

  it('hides locales with missing or invalid files and logs them with the locale', async () => {
    const fetch = fetcher({ 'i18n/de.json': DE, 'i18n/fr.json': ['not', 'a', 'map'] });

    const catalog = await loadLocaleCatalog(fetch, CONFIG, EN, log);

    expect(catalog).toEqual({
      options: [
        { locale: 'en', label: 'English' },
        { locale: 'de', label: 'Deutsch' },
      ],
      translations: { en: EN, de: DE },
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ locale: 'fr' }));
  });

  it('requests all non-default files in parallel and not the default again', async () => {
    const pending: string[] = [];
    const fetch: JsonFetcher = (url) =>
      new Promise((resolve) => {
        pending.push(url);
        setTimeout(() => resolve(DE), 0);
      });

    const done = loadLocaleCatalog(fetch, CONFIG, EN, log);
    await Promise.resolve();

    expect(pending).toEqual(['i18n/de.json', 'i18n/fr.json']);
    await expect(done).resolves.toMatchObject({ options: expect.any(Array) });
  });
});
