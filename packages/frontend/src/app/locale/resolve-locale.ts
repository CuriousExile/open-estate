// Framework-free locale resolution (design: LocaleService; Req 13.6, 13.11).
// Kept free of Angular and DOM types so it can be unit-tested with plain Jest.

/** Primary language subtag, lower-cased (`de-AT` → `de`). */
export function primaryLanguage(tag: string): string {
  return (tag.split('-', 1)[0] ?? tag).toLowerCase();
}

function findExact(tag: string, available: readonly string[]): string | undefined {
  const wanted = tag.trim().toLowerCase();
  return wanted === '' ? undefined : available.find((locale) => locale.toLowerCase() === wanted);
}

/**
 * Available locale a browser language corresponds to (Req 13.6): exact match (case-insensitive)
 * first, else the available locale that equals the browser language's primary subtag
 * (`de-AT` → `de`).
 *
 * Decision: matching only goes from the browser language to its primary language, not the reverse —
 * browser `de` does not select an enabled `de-AT`, and `de-AT` does not select `de-CH`. Only a locale
 * enabled as the bare language (`de`) covers its regional variants.
 */
export function matchLocale(tag: string, available: readonly string[]): string | undefined {
  return findExact(tag, available) ?? findExact(primaryLanguage(tag.trim()), available);
}

/**
 * Active locale at startup (design: Locale-Bestimmung, Property 28): the stored choice if it is
 * available; else the first browser language (in `navigator.languages` order) that matches an
 * available locale exactly or via its primary language; else the default locale.
 * "Available" means enabled and with a readable translation file. Returns the configured spelling.
 */
export function resolveLocale(
  stored: string | undefined,
  browserLanguages: readonly string[],
  available: readonly string[],
  defaultLocale: string,
): string {
  const storedMatch = stored === undefined ? undefined : findExact(stored, available);
  if (storedMatch !== undefined) return storedMatch;
  for (const language of browserLanguages) {
    const match = matchLocale(language, available);
    if (match !== undefined) return match;
  }
  return defaultLocale;
}

/** `localStorage` key of the user's language choice (Req 13.11). */
export const LOCALE_STORAGE_KEY = 'open-estate.locale';

/** Subset of the Web Storage API used here. */
export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Storage access may throw (blocked cookies/storage, private mode, quota) — even reading the
 * `localStorage` property itself. The getter is therefore called inside the guard as well.
 */
export type StorageProvider = () => LocaleStorage | null | undefined;

export function readStoredLocale(storage: StorageProvider): string | undefined {
  try {
    return storage()?.getItem(LOCALE_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Returns `false` if the choice could not be stored (it then only lasts for the current page). */
export function writeStoredLocale(storage: StorageProvider, locale: string): boolean {
  try {
    const target = storage();
    if (!target) return false;
    target.setItem(LOCALE_STORAGE_KEY, locale);
    return true;
  } catch {
    return false;
  }
}

export function removeStoredLocale(storage: StorageProvider): void {
  try {
    storage()?.removeItem(LOCALE_STORAGE_KEY);
  } catch {
    // Nothing to clean up if storage is not accessible.
  }
}
