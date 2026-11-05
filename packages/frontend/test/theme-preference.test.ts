import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LocaleStorage } from '../src/app/locale/resolve-locale';
import {
  parseThemePreference,
  readStoredThemePreference,
  resolveColorTheme,
  THEME_PREFERENCES,
  THEME_STORAGE_KEY,
  writeStoredThemePreference,
  type ThemePreference,
} from '../src/app/theme/theme-preference';

function memoryStorage(initial: Record<string, string> = {}): LocaleStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => void (data[key] = value),
    removeItem: (key) => void Reflect.deleteProperty(data, key),
  };
}

const throwing = () => {
  throw new Error('SecurityError');
};

describe('theme preference model', () => {
  it('parses stored values; anything else is "system"', () => {
    expect(parseThemePreference('light')).toBe('light');
    expect(parseThemePreference('dark')).toBe('dark');
    for (const value of ['system', 'Dark', '', null, undefined, 1]) {
      expect(parseThemePreference(value)).toBe('system');
    }
  });

  it('resolves "system" from prefers-color-scheme and keeps explicit choices', () => {
    expect(resolveColorTheme('system', true)).toBe('dark');
    expect(resolveColorTheme('system', false)).toBe('light');
    expect(resolveColorTheme('light', true)).toBe('light');
    expect(resolveColorTheme('dark', false)).toBe('dark');
  });

  it('stores explicit choices, removes the key for "system", survives blocked storage', () => {
    const storage = memoryStorage();
    expect(writeStoredThemePreference(() => storage, 'dark')).toBe(true);
    expect(storage.data).toEqual({ [THEME_STORAGE_KEY]: 'dark' });
    expect(readStoredThemePreference(() => storage)).toBe('dark');
    expect(writeStoredThemePreference(() => storage, 'system')).toBe(true);
    expect(storage.data).toEqual({});
    expect(readStoredThemePreference(throwing)).toBe('system');
    expect(writeStoredThemePreference(throwing, 'light')).toBe(false);
    expect(writeStoredThemePreference(() => null, 'light')).toBe(false);
  });
});

/**
 * The inline script in index.html applies the theme before the first paint. Run it against fake
 * browser globals and compare with the model for every stored value and system setting.
 */
describe('inline theme script of index.html', () => {
  const html = readFileSync(resolve(__dirname, '../src/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, body]) => body);

  function run(stored: string | null | 'throw', systemDark: boolean | undefined) {
    const attributes: Record<string, string> = {};
    const style: { colorScheme?: string } = {};
    const documentElement = {
      setAttribute: (name: string, value: string) => void (attributes[name] = value),
      style,
    };
    const localStorage = {
      getItem: (key: string) => {
        if (stored === 'throw') throw new Error('SecurityError');
        return key === THEME_STORAGE_KEY ? stored : null;
      },
    };
    const matchMedia =
      systemDark === undefined
        ? undefined
        : (query: string) => ({ matches: query === '(prefers-color-scheme: dark)' && systemDark });
    const window = { matchMedia };
    new Function('document', 'localStorage', 'matchMedia', 'window', scripts[0] ?? '')(
      { documentElement },
      localStorage,
      matchMedia,
      window,
    );
    return { theme: attributes['data-theme'], colorScheme: style.colorScheme };
  }

  it('is a single static inline script (allowed by its CSP hash)', () => {
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain(THEME_STORAGE_KEY);
  });

  it.each([null, 'light', 'dark', 'system', 'bogus', 'throw'] as const)(
    'agrees with the model for stored %p',
    (stored) => {
      for (const systemDark of [true, false]) {
        const preference: ThemePreference =
          stored === 'throw' ? 'system' : parseThemePreference(stored);
        const expected = resolveColorTheme(preference, systemDark);
        expect(run(stored, systemDark)).toEqual({ theme: expected, colorScheme: expected });
      }
    },
  );

  it('falls back to light without matchMedia, like the service', () => {
    expect(run(null, undefined).theme).toBe('light');
  });

  it('offers System, Light and Dark', () => {
    expect(THEME_PREFERENCES).toEqual(['system', 'light', 'dark']);
  });
});
