// Framework-free startup logic (design: AppInitializer; Req 8.1, 13.3, 13.9).
// Kept free of Angular imports so it can be unit-tested with plain Jest.
import type { ZodType } from 'zod';
import {
  describeIssues,
  I18nConfigSchema,
  RuntimeConfigSchema,
  TranslationSchema,
  type I18nConfig,
  type RuntimeConfig,
  type Translation,
} from './config-schemas';

/** Fetches and parses JSON; rejects on network, HTTP or parse errors. */
export type JsonFetcher = (url: string) => Promise<unknown>;

/** Structured log sink (`console.error` in the browser). */
export type StartupLogger = (message: string, fields: Record<string, unknown>) => void;

/** Outcome of loading one optional resource; failures must not prevent the start. */
export type LoadState<T> = { status: 'loaded'; value: T } | { status: 'failed'; error: string };

/** URLs relative to the SPA's base href, served with `no-cache` (design: Hosting). */
export const STARTUP_URLS = {
  themeConfig: 'theme-config.json',
  i18nConfig: 'i18n-config.json',
  runtimeConfig: 'runtime-config.json',
} as const;

/** URL of a translation file; loaded at runtime, never bundled (Req 13.3). */
export function translationUrl(locale: string): string {
  return `i18n/${encodeURIComponent(locale)}.json`;
}

/** Joins the configured API base URL and an endpoint path without duplicate slashes. */
export function apiUrl(apiBaseUrl: string, path: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Everything the app needs once the start succeeded. */
export interface StartupContext {
  i18nConfig: I18nConfig;
  /** Validated translations of `i18nConfig.defaultLocale`. */
  defaultTranslation: Translation;
  /** Raw `theme-config.json`; resolved and validated per value by the ThemeService (Req 8.3–8.5). */
  theme: LoadState<unknown>;
  /** Raw `/meta` response; consumed by later features (taxonomy, tour providers). */
  meta: LoadState<unknown>;
  runtimeConfig: LoadState<RuntimeConfig>;
}

export type StartupError =
  | { code: 'I18N_CONFIG_INVALID'; detail: string }
  | { code: 'DEFAULT_LOCALE_TRANSLATION_INVALID'; locale: string; detail: string };

/** Translations to render the error page with, if any enabled locale has a readable file. */
export interface ErrorPageTranslation {
  locale: string;
  translation: Translation;
}

export type StartupResult =
  | { ok: true; context: StartupContext }
  | { ok: false; error: StartupError; errorPage?: ErrorPageTranslation };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function load(fetchJson: JsonFetcher, url: string): Promise<LoadState<unknown>> {
  try {
    return { status: 'loaded', value: await fetchJson(url) };
  } catch (error) {
    return { status: 'failed', error: errorText(error) };
  }
}

function validate<T>(state: LoadState<unknown>, schema: ZodType<T>): LoadState<T> {
  if (state.status === 'failed') return state;
  const parsed = schema.safeParse(state.value);
  return parsed.success
    ? { status: 'loaded', value: parsed.data }
    : { status: 'failed', error: describeIssues(parsed.error) };
}

/** Loads and validates `i18n/{locale}.json`; never rejects. */
export async function loadTranslation(
  fetchJson: JsonFetcher,
  locale: string,
): Promise<LoadState<Translation>> {
  return validate(await load(fetchJson, translationUrl(locale)), TranslationSchema);
}

/** `/meta` depends on the API base URL, so it runs after `runtime-config.json` — but in parallel to the other files. */
async function loadRuntimeAndMeta(
  fetchJson: JsonFetcher,
): Promise<{ runtimeConfig: LoadState<RuntimeConfig>; meta: LoadState<unknown> }> {
  const runtimeConfig = validate(
    await load(fetchJson, STARTUP_URLS.runtimeConfig),
    RuntimeConfigSchema,
  );
  if (runtimeConfig.status === 'failed') {
    return { runtimeConfig, meta: { status: 'failed', error: 'runtime-config.json unavailable' } };
  }
  return {
    runtimeConfig,
    meta: await load(fetchJson, apiUrl(runtimeConfig.value.apiBaseUrl, 'meta')),
  };
}

/** First other enabled locale with a valid file, so the error page can still be translated. */
async function findErrorPageTranslation(
  fetchJson: JsonFetcher,
  config: I18nConfig,
): Promise<ErrorPageTranslation | undefined> {
  for (const { locale } of config.enabled) {
    if (locale === config.defaultLocale) continue;
    const state = await loadTranslation(fetchJson, locale);
    if (state.status === 'loaded') return { locale, translation: state.value };
  }
  return undefined;
}

/**
 * Loads `theme-config.json`, `i18n-config.json` and `/meta` in parallel, then the translation file
 * of the default locale. A missing/invalid i18n config or default-locale file aborts the start
 * (Req 13.9); theme, runtime config and `/meta` failures are logged and reported as `failed` state.
 */
export async function initialize(
  fetchJson: JsonFetcher,
  log: StartupLogger,
): Promise<StartupResult> {
  const [theme, i18nRaw, { runtimeConfig, meta }] = await Promise.all([
    load(fetchJson, STARTUP_URLS.themeConfig),
    load(fetchJson, STARTUP_URLS.i18nConfig),
    loadRuntimeAndMeta(fetchJson),
  ]);
  if (theme.status === 'failed') log('theme config unavailable', { error: theme.error });
  if (runtimeConfig.status === 'failed') {
    log('runtime config unavailable', { error: runtimeConfig.error });
  }
  if (meta.status === 'failed') log('meta unavailable', { error: meta.error });

  const i18nConfig = validate(i18nRaw, I18nConfigSchema);
  if (i18nConfig.status === 'failed') {
    log('i18n config invalid', { error: i18nConfig.error });
    return { ok: false, error: { code: 'I18N_CONFIG_INVALID', detail: i18nConfig.error } };
  }

  const locale = i18nConfig.value.defaultLocale;
  const defaultTranslation = await loadTranslation(fetchJson, locale);
  if (defaultTranslation.status === 'failed') {
    log('default locale translation invalid', { locale, error: defaultTranslation.error });
    const error: StartupError = {
      code: 'DEFAULT_LOCALE_TRANSLATION_INVALID',
      locale,
      detail: defaultTranslation.error,
    };
    const errorPage = await findErrorPageTranslation(fetchJson, i18nConfig.value);
    return errorPage ? { ok: false, error, errorPage } : { ok: false, error };
  }

  return {
    ok: true,
    context: {
      i18nConfig: i18nConfig.value,
      defaultTranslation: defaultTranslation.value,
      theme,
      meta,
      runtimeConfig,
    },
  };
}
