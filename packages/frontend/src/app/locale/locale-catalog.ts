// Framework-free availability check of the enabled locales (design: LocaleService; Req 13.4, 13.12).
import type { I18nConfig, Translation } from '../startup/config-schemas';
import {
  loadTranslation,
  type JsonFetcher,
  type LoadState,
  type StartupLogger,
} from '../startup/initialize';

export interface LocaleOption {
  readonly locale: string;
  /** Display name from `i18n-config.json`. */
  readonly label: string;
}

/** Locales offered in the language selection, with their already validated translations. */
export interface LocaleCatalog {
  /** Enabled locales with a readable, valid file, in configuration order. */
  readonly options: readonly LocaleOption[];
  /** Translations by locale — exactly the locales in `options`. */
  readonly translations: Readonly<Record<string, Translation>>;
}

export interface UnavailableLocale {
  readonly locale: string;
  readonly error: string;
}

/**
 * Keeps the enabled locales whose translation file loaded and validated. The default locale is
 * always available: its file was validated during startup (otherwise the start aborts, Req 13.9).
 */
export function selectAvailableLocales(
  config: I18nConfig,
  defaultTranslation: Translation,
  states: Readonly<Record<string, LoadState<Translation>>>,
): LocaleCatalog & { unavailable: UnavailableLocale[] } {
  const options: LocaleOption[] = [];
  const translations: Record<string, Translation> = {};
  const unavailable: UnavailableLocale[] = [];
  for (const { locale, label } of config.enabled) {
    const state: LoadState<Translation> | undefined =
      locale === config.defaultLocale
        ? { status: 'loaded', value: defaultTranslation }
        : states[locale];
    if (state?.status === 'loaded') {
      options.push({ locale, label });
      translations[locale] = state.value;
    } else {
      unavailable.push({ locale, error: state?.error ?? 'not loaded' });
    }
  }
  return { options, translations, unavailable };
}

/**
 * Loads the translation files of all enabled non-default locales in parallel. Unreadable or invalid
 * files hide the locale from the language selection and are logged with the locale (Req 13.12).
 * The loaded translations are cached so switching languages needs no further request.
 */
export async function loadLocaleCatalog(
  fetchJson: JsonFetcher,
  config: I18nConfig,
  defaultTranslation: Translation,
  log: StartupLogger,
): Promise<LocaleCatalog> {
  const others = config.enabled.filter(({ locale }) => locale !== config.defaultLocale);
  const loaded = await Promise.all(
    others.map(async ({ locale }) => [locale, await loadTranslation(fetchJson, locale)] as const),
  );
  const { options, translations, unavailable } = selectAvailableLocales(
    config,
    defaultTranslation,
    Object.fromEntries(loaded),
  );
  for (const { locale, error } of unavailable) {
    log('locale translation unavailable, locale hidden', { locale, error });
  }
  return { options, translations };
}
