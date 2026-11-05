// Framework-free model of the light/dark theme choice. Kept free of Angular and DOM types so it can
// be unit-tested with plain Jest. The inline script in `src/index.html` applies the same rules
// before the first paint (no flash); `test/theme-preference.test.ts` checks that both agree.
import type { StorageProvider } from '../locale/resolve-locale';

/** What the user chose in the header; `system` follows `prefers-color-scheme`. */
export type ThemePreference = 'system' | 'light' | 'dark';
/** What is applied: `data-theme` and `color-scheme` on `<html>`. */
export type ColorTheme = 'light' | 'dark';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

/** `localStorage` key of the choice (next to language, country and currency). */
export const THEME_STORAGE_KEY = 'open-estate.theme';

/** Media query of the operating-system setting used for `system`. */
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

/** A stored value, or `system` for anything else (missing, unknown, unreadable storage). */
export function parseThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** Applied theme: the explicit choice, or the system setting for `system`. */
export function resolveColorTheme(preference: ThemePreference, systemDark: boolean): ColorTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

export function readStoredThemePreference(storage: StorageProvider): ThemePreference {
  try {
    return parseThemePreference(storage()?.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

/** Stores the choice; `system` removes the key. `false` if storage is unavailable. */
export function writeStoredThemePreference(
  storage: StorageProvider,
  preference: ThemePreference,
): boolean {
  try {
    const store = storage();
    if (!store) return false;
    if (preference === 'system') store.removeItem(THEME_STORAGE_KEY);
    else store.setItem(THEME_STORAGE_KEY, preference);
    return true;
  } catch {
    return false;
  }
}
