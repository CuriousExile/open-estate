/**
 * Text fallback chain (design: Transloco-Konfiguration; Property 29; Req 13.1, 13.7, 13.8).
 * Framework-free so it can be tested without Angular; the Transloco integration lives in
 * `transloco-fallback.ts`.
 */

/** Flat map of translation keys to texts of one locale. */
export type TranslationMap = Readonly<Record<string, string>>;

export interface MissingTranslation {
  readonly locale: string;
  readonly key: string;
}

export interface ResolvedText {
  readonly text: string;
  /** Set if neither the active locale nor the default locale has an entry (Req 13.8). */
  readonly missing?: MissingTranslation;
}

/**
 * Text of the active locale if present, else of the default locale (Req 13.7), else the key itself
 * (Req 13.8). Empty strings count as absent, matching Transloco (`missingHandler.allowEmpty: false`).
 */
export function resolveText(
  key: string,
  activeLocale: string,
  translations: Readonly<Record<string, TranslationMap>>,
  defaultLocale: string,
): ResolvedText {
  const text = lookup(translations, activeLocale, key) ?? lookup(translations, defaultLocale, key);
  return text === undefined ? { text: key, missing: { locale: activeLocale, key } } : { text };
}

function lookup(
  translations: Readonly<Record<string, TranslationMap>>,
  locale: string,
  key: string,
): string | undefined {
  const translation = Object.hasOwn(translations, locale) ? translations[locale] : undefined;
  const text = translation && Object.hasOwn(translation, key) ? translation[key] : undefined;
  return text ? text : undefined;
}

export type MissingTranslationLogger = (missing: MissingTranslation) => void;

/** Logs each (locale, key) combination exactly once, however often it is rendered (Property 29). */
export function createMissingTranslationReporter(
  log: MissingTranslationLogger,
): (missing: MissingTranslation) => void {
  const reported = new Set<string>();
  return (missing) => {
    const id = JSON.stringify([missing.locale, missing.key]);
    if (reported.has(id)) return;
    reported.add(id);
    log({ locale: missing.locale, key: missing.key });
  };
}

/** Key prefixes of the labels for language-neutral codes (Req 13.1, 14.10). */
export const CODE_LABEL_KINDS = ['offerType', 'taxonomy.group', 'taxonomy.type'] as const;
export type CodeLabelKind = (typeof CODE_LABEL_KINDS)[number];

/** Translation key of a code label, e.g. `codeLabelKey('offerType', 'SALE')` → `offerType.SALE`. */
export function codeLabelKey(kind: CodeLabelKind, code: string): string {
  return `${kind}.${code}`;
}

/**
 * What to show for a key without any translation: the code for code-label keys
 * (`taxonomy.type.villa` → `villa`), otherwise the key itself (Req 13.8).
 */
export function untranslatedDisplay(key: string): string {
  for (const kind of CODE_LABEL_KINDS) {
    const prefix = `${kind}.`;
    if (key.startsWith(prefix) && key.length > prefix.length) return key.slice(prefix.length);
  }
  return key;
}
