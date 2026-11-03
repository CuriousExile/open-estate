import type { ApiError } from './errors';
import { parseAcceptLanguage, validateLang, type LocalePreference } from './locale';
import { err, ok, type Result } from './result';
import type { Listing, LocalizedVersion } from './schema/listing';

/** Request inputs that determine the language preferences (Req 14.3, 14.8). */
export interface LocaleRequest {
  /** `lang` query parameter / tool argument. */
  lang?: string | undefined;
  /** Raw `Accept-Language` header value. */
  acceptLanguage?: string | undefined;
}

/**
 * Determines the language preferences of a request (Req 14.8, 14.9).
 * A set `lang` is validated and becomes the only preference; the header is then ignored.
 * Otherwise the `Accept-Language` header is parsed (never an error). No input → `[]`.
 */
export function resolvePreferences(req: LocaleRequest): Result<LocalePreference[], ApiError> {
  if (req.lang !== undefined) {
    const error = validateLang(req.lang);
    return error ? err(error) : ok([{ tag: req.lang, q: 1 }]);
  }
  return ok(parseAcceptLanguage(req.acceptLanguage));
}

/** The listing fields the selection reads. */
export type LocalizableListing = Pick<
  Listing,
  'originalLocale' | 'title' | 'description' | 'translations'
>;

function primarySubtag(locale: string): string {
  const dash = locale.indexOf('-');
  return (dash === -1 ? locale : locale.slice(0, dash)).toLowerCase();
}

/**
 * Total order among same-primary-subtag candidates: original locale first, then by lowercased
 * locale in UTF-16 code-unit order; the stored spelling breaks remaining ties (only possible for
 * listings that violate the uniqueness rule of Req 14.2), so the result is always deterministic.
 */
function compareCandidates(
  a: LocalizedVersion,
  b: LocalizedVersion,
  original: LocalizedVersion,
): number {
  if (a === b) return 0;
  if (a === original) return -1;
  if (b === original) return 1;
  const la = a.deliveredLocale.toLowerCase();
  const lb = b.deliveredLocale.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  if (a.deliveredLocale === b.deliveredLocale) return 0;
  return a.deliveredLocale < b.deliveredLocale ? -1 : 1;
}

/**
 * Selects the language version to deliver (Req 14.3–14.5, 14.7). For each preference in order:
 * (a) a version whose locale equals the preference case-insensitively; otherwise (b) a version
 * with the same primary language subtag (e.g. `de-AT` ↔ `de`, `de-CH`), preferring the original
 * locale, then the lexicographically smallest locale. No match → original locale.
 *
 * Title and description always come from the same version; `deliveredLocale` is that version's
 * stored locale spelling. Language-neutral codes are not touched here (Req 3.8, 14.10).
 */
export function selectLocalizedVersion(
  listing: LocalizableListing,
  prefs: readonly LocalePreference[],
): LocalizedVersion {
  const original: LocalizedVersion = {
    title: listing.title,
    description: listing.description,
    deliveredLocale: listing.originalLocale,
  };
  // Original first, so an exact match on the original wins over a (invalid) duplicate translation.
  const versions: LocalizedVersion[] = [
    original,
    ...listing.translations.map((t) => ({
      title: t.title,
      description: t.description,
      deliveredLocale: t.locale,
    })),
  ];

  for (const pref of prefs) {
    const wanted = pref.tag.toLowerCase();
    const exact = versions.find((v) => v.deliveredLocale.toLowerCase() === wanted);
    if (exact) return exact;

    const subtag = primarySubtag(pref.tag);
    let best: LocalizedVersion | undefined;
    for (const v of versions) {
      if (primarySubtag(v.deliveredLocale) !== subtag) continue;
      if (!best || compareCandidates(v, best, original) < 0) best = v;
    }
    if (best) return best;
  }
  return original;
}
