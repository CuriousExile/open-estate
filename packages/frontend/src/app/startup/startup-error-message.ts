import type { Translation } from './config-schemas';
import type { ErrorPageTranslation, StartupError } from './initialize';

export interface StartupErrorMessage {
  /** BCP 47 locale of the texts (for the `lang` attribute). */
  lang: string;
  title: string;
  message: string;
}

/** Translation keys of the error page (present in every `i18n/{locale}.json`). */
export const STARTUP_ERROR_KEYS = {
  title: 'startup.error.title',
  defaultLocale: 'startup.error.defaultLocale',
  config: 'startup.error.config',
} as const;

/**
 * Last-resort texts: used only when no readable translation provides the error-page keys,
 * so the operator still sees which locale is affected (Req 13.9).
 */
const BUILT_IN: ErrorPageTranslation = {
  locale: 'en',
  translation: {
    [STARTUP_ERROR_KEYS.title]: 'The application could not be started',
    [STARTUP_ERROR_KEYS.defaultLocale]:
      'The translation file of the default language "{{locale}}" is missing or invalid.',
    [STARTUP_ERROR_KEYS.config]:
      'The language configuration (i18n-config.json) is missing or invalid.',
  },
};

function interpolate(text: string, params: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => params[name] ?? match);
}

/** Error page texts from the error-page translation if it has both keys, else built-in English. */
export function startupErrorMessage(
  error: StartupError,
  errorPage?: ErrorPageTranslation,
): StartupErrorMessage {
  const bodyKey =
    error.code === 'DEFAULT_LOCALE_TRANSLATION_INVALID'
      ? STARTUP_ERROR_KEYS.defaultLocale
      : STARTUP_ERROR_KEYS.config;
  const hasKeys = (t: Translation): boolean =>
    t[STARTUP_ERROR_KEYS.title] !== undefined && t[bodyKey] !== undefined;
  const source = errorPage && hasKeys(errorPage.translation) ? errorPage : BUILT_IN;
  const params: Record<string, string> =
    error.code === 'DEFAULT_LOCALE_TRANSLATION_INVALID' ? { locale: error.locale } : {};
  return {
    lang: source.locale,
    title: interpolate(source.translation[STARTUP_ERROR_KEYS.title] ?? '', params),
    message: interpolate(source.translation[bodyKey] ?? '', params),
  };
}
