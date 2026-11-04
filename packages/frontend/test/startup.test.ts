import { I18nConfigSchema } from '../src/app/startup/config-schemas';
import {
  apiUrl,
  initialize,
  type JsonFetcher,
  type StartupLogger,
} from '../src/app/startup/initialize';
import { startupErrorMessage } from '../src/app/startup/startup-error-message';

const I18N_CONFIG = {
  defaultLocale: 'en',
  enabled: [
    { locale: 'en', label: 'English' },
    { locale: 'de', label: 'Deutsch' },
  ],
};
const EN = { 'home.title': 'Home' };
const DE = {
  'startup.error.title': 'Startfehler',
  'startup.error.defaultLocale': 'Datei für „{{locale}}“ fehlt.',
};
const THEME = { colors: { primary: '#000000' } };
const META = { locales: ['en', 'de'] };

/** In-memory fetcher: unknown URLs reject like a 404. */
function fetcher(files: Record<string, unknown>): JsonFetcher & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (url: string): Promise<unknown> => {
    calls.push(url);
    if (!(url in files)) throw new Error(`404 ${url}`);
    return files[url];
  };
  return Object.assign(fn, { calls });
}

const files = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  'theme-config.json': THEME,
  'i18n-config.json': I18N_CONFIG,
  'runtime-config.json': { apiBaseUrl: 'https://api.example.org/' },
  'https://api.example.org/meta': META,
  'i18n/en.json': EN,
  'i18n/de.json': DE,
  ...overrides,
});

function withoutKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

let log: jest.MockedFunction<StartupLogger>;
beforeEach(() => {
  log = jest.fn();
});

describe('initialize', () => {
  it('loads all configuration and the default-locale translation', async () => {
    const result = await initialize(fetcher(files()), log);

    expect(result).toEqual({
      ok: true,
      context: {
        i18nConfig: I18N_CONFIG,
        defaultTranslation: EN,
        theme: { status: 'loaded', value: THEME },
        meta: { status: 'loaded', value: META },
        runtimeConfig: { status: 'loaded', value: { apiBaseUrl: 'https://api.example.org/' } },
      },
    });
    expect(log).not.toHaveBeenCalled();
  });

  it('requests theme config, i18n config and runtime config/meta in parallel', async () => {
    const pending: string[] = [];
    const release: (() => void)[] = [];
    const inner = fetcher(files());
    const slow: JsonFetcher = (url) =>
      new Promise((resolve) => {
        pending.push(url);
        release.push(() => resolve(inner(url)));
      });

    const done = initialize(slow, log);
    await Promise.resolve();
    // Nothing resolved yet, all three startup files are already requested.
    expect(pending).toEqual(['theme-config.json', 'i18n-config.json', 'runtime-config.json']);

    // Release requests as they arrive until startup completes.
    const drain = setInterval(() => release.shift()?.(), 0);
    await expect(done).resolves.toMatchObject({ ok: true });
    clearInterval(drain);
    expect(pending.indexOf('i18n/en.json')).toBeGreaterThan(pending.indexOf('i18n-config.json'));
  });

  it('starts with a failed meta state when /meta is unavailable', async () => {
    const result = await initialize(
      fetcher(withoutKey(files(), 'https://api.example.org/meta')),
      log,
    );

    expect(result).toMatchObject({ ok: true, context: { meta: { status: 'failed' } } });
    expect(log).toHaveBeenCalledWith('meta unavailable', expect.any(Object));
  });

  it('starts without runtime config and does not call /meta then', async () => {
    const fetch = fetcher(withoutKey(files(), 'runtime-config.json'));
    const result = await initialize(fetch, log);

    expect(result).toMatchObject({
      ok: true,
      context: { runtimeConfig: { status: 'failed' }, meta: { status: 'failed' } },
    });
    expect(fetch.calls.some((url) => url.endsWith('/meta'))).toBe(false);
  });

  it('starts with a failed theme state when theme-config.json is unavailable', async () => {
    const result = await initialize(fetcher(withoutKey(files(), 'theme-config.json')), log);

    expect(result).toMatchObject({ ok: true, context: { theme: { status: 'failed' } } });
    expect(log).toHaveBeenCalledWith('theme config unavailable', expect.any(Object));
  });

  it('aborts when i18n-config.json is invalid', async () => {
    const result = await initialize(fetcher(files({ 'i18n-config.json': { enabled: [] } })), log);

    expect(result).toMatchObject({ ok: false, error: { code: 'I18N_CONFIG_INVALID' } });
  });

  it.each([
    ['missing', undefined],
    ['not an object', ['home.title']],
    ['non-string values', { 'home.title': { nested: 'x' } }],
  ])('aborts naming the default locale when its translation file is %s', async (_, content) => {
    const overrides = content === undefined ? {} : { 'i18n/en.json': content };
    const base = content === undefined ? withoutKey(files(), 'i18n/en.json') : files(overrides);

    const result = await initialize(fetcher(base), log);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'DEFAULT_LOCALE_TRANSLATION_INVALID', locale: 'en' },
      errorPage: { locale: 'de', translation: DE },
    });
    expect(log).toHaveBeenCalledWith(
      'default locale translation invalid',
      expect.objectContaining({ locale: 'en' }),
    );
  });

  it('aborts without error-page translation when no other locale file is readable', async () => {
    const base = withoutKey(withoutKey(files(), 'i18n/en.json'), 'i18n/de.json');

    const result = await initialize(fetcher(base), log);

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'DEFAULT_LOCALE_TRANSLATION_INVALID', locale: 'en' }),
    });
  });
});

describe('I18nConfigSchema', () => {
  it.each([
    ['default locale not enabled', { ...I18N_CONFIG, defaultLocale: 'fr' }],
    [
      'duplicate locales (case-insensitive)',
      {
        defaultLocale: 'en',
        enabled: [
          { locale: 'en', label: 'English' },
          { locale: 'EN', label: 'English' },
        ],
      },
    ],
    ['invalid locale tag', { defaultLocale: 'en', enabled: [{ locale: 'e n', label: 'x' }] }],
    ['empty label', { defaultLocale: 'en', enabled: [{ locale: 'en', label: ' ' }] }],
  ])('rejects %s', (_, config) => {
    expect(I18nConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe('apiUrl', () => {
  it.each([
    ['/api', '/api/meta'],
    ['/api/', '/api/meta'],
    ['https://api.example.org', 'https://api.example.org/meta'],
  ])('joins %s and meta', (base, expected) => {
    expect(apiUrl(base, '/meta')).toBe(expected);
  });
});

describe('startupErrorMessage', () => {
  const error = {
    code: 'DEFAULT_LOCALE_TRANSLATION_INVALID',
    locale: 'en',
    detail: '404',
  } as const;

  it('uses the error-page translation and names the locale', () => {
    expect(startupErrorMessage(error, { locale: 'de', translation: DE })).toEqual({
      lang: 'de',
      title: 'Startfehler',
      message: 'Datei für „en“ fehlt.',
    });
  });

  it('falls back to built-in English that still names the locale', () => {
    const message = startupErrorMessage(error, { locale: 'de', translation: {} });

    expect(message.lang).toBe('en');
    expect(message.message).toContain('"en"');
  });

  it('describes an invalid i18n config without a locale', () => {
    const message = startupErrorMessage({ code: 'I18N_CONFIG_INVALID', detail: 'x' });

    expect(message.message).toContain('i18n-config.json');
  });
});
