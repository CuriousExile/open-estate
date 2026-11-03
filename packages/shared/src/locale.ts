import type { ApiError } from './errors';

/** Maximum length of a locale tag accepted via the `lang` parameter (Req 14.9). */
export const MAX_LOCALE_LENGTH = 35;

/**
 * One requested language with its weight. `tag` is kept as sent (trimmed);
 * matching against stored locales is case-insensitive (Req 14.3).
 */
export interface LocalePreference {
  tag: string;
  /** Weight in (0, 1] per RFC 9110 §12.4.2. */
  q: number;
}

/** True if `tag` is a non-empty, at most 35 characters long, syntactically valid BCP-47 locale. */
export function isValidLocaleTag(tag: string): boolean {
  if (tag.length === 0 || tag.length > MAX_LOCALE_LENGTH) return false;
  try {
    Intl.getCanonicalLocales(tag);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates the `lang` request parameter (Req 14.9).
 * Returns `undefined` if valid, otherwise an `INVALID_LOCALE` error for field `lang`.
 */
export function validateLang(lang: string): ApiError | undefined {
  if (isValidLocaleTag(lang)) return undefined;
  return {
    code: 'INVALID_LOCALE',
    field: 'lang',
    message: `lang must be a valid BCP 47 locale with 1 to ${MAX_LOCALE_LENGTH} characters`,
  };
}

// RFC 9110 qvalue: "0" [ "." 0*3DIGIT ] / "1" [ "." 0*3("0") ]
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;
const WEIGHT = /^q=(.*)$/i;

/** Parses one list element; `undefined` means the entry is discarded. */
function parseEntry(entry: string): LocalePreference | undefined {
  const [rawTag = '', ...params] = entry.split(';');
  const tag = rawTag.trim();
  // Only a single weight parameter is allowed for Accept-Language.
  if (params.length > 1 || !isValidLocaleTag(tag)) return undefined;
  let q = 1;
  if (params.length === 1) {
    const value = WEIGHT.exec((params[0] ?? '').trim())?.[1];
    if (value === undefined || !QVALUE.test(value)) return undefined;
    q = Number(value);
  }
  return q > 0 ? { tag, q } : undefined;
}

/**
 * Parses an Accept-Language header (Req 14.6). Never throws: syntactically invalid
 * entries, `*` and entries with q=0 are discarded. Result is sorted by q descending;
 * ties keep their order of appearance (Array.prototype.sort is stable).
 */
export function parseAcceptLanguage(header: string | undefined): LocalePreference[] {
  if (header === undefined) return [];
  const prefs: LocalePreference[] = [];
  for (const entry of header.split(',')) {
    const pref = parseEntry(entry);
    if (pref) prefs.push(pref);
  }
  return prefs.sort((a, b) => b.q - a.q);
}
