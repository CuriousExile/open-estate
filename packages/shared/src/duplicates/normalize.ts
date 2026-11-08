import type { DuplicateConfig } from './config';

// Normalization of addresses and texts for the Duplikat_Bewertung (duplicate-detection Req 3.2).
// Pure and deterministic: differences in case, Unicode form, whitespace, punctuation, diacritics,
// "ß"/"ss" and in the spelling of street suffixes must not change the result, and a house number
// may stand in `address.street` or in `address.houseNumber` alike (Req 1.8).

/** German umlauts are transliterated before diacritics are stripped ("Müller" = "Mueller"). */
const TRANSLITERATIONS: readonly (readonly [RegExp, string])[] = [
  [/ä/g, 'ae'],
  [/ö/g, 'oe'],
  [/ü/g, 'ue'],
  [/ß/g, 'ss'],
];

/**
 * Case-, punctuation- and diacritics-insensitive form of a text: lower case, umlauts
 * transliterated, combining marks removed, every character that is neither a letter nor a digit
 * replaced by a single space, trimmed. Idempotent.
 */
export function normalizeText(value: string): string {
  let text = value.normalize('NFKC').toLowerCase();
  for (const [pattern, replacement] of TRANSLITERATIONS) text = text.replace(pattern, replacement);
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Words of a normalized text (empty for a text without letters or digits). */
export function words(value: string): string[] {
  const normalized = normalizeText(value);
  return normalized === '' ? [] : normalized.split(' ');
}

/** Alias → canonical suffix, built once per configuration. */
function suffixIndex(config: DuplicateConfig): Map<string, string> {
  const index = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(config.normalization.streetSuffixes)) {
    const normalizedCanonical = normalizeText(canonical);
    for (const alias of aliases) {
      const normalizedAlias = normalizeText(alias);
      if (normalizedAlias !== '') index.set(normalizedAlias, normalizedCanonical);
    }
  }
  return index;
}

/**
 * Normalized street without whitespace: every token is mapped onto the canonical spelling of its
 * suffix, both as a whole token ("Haupt Str.") and at the end of a compound ("Hauptstraße").
 * Longer aliases win, so "strasse" is not shortened by the alias "str" first.
 */
export function normalizeStreet(street: string, config: DuplicateConfig): string {
  const index = suffixIndex(config);
  const aliases = [...index.keys()].sort((a, b) => b.length - a.length);
  const mapped = words(street).map((token) => {
    const exact = index.get(token);
    if (exact !== undefined) return exact;
    const suffix = aliases.find((alias) => token.length > alias.length && token.endsWith(alias));
    return suffix === undefined ? token : token.slice(0, -suffix.length) + index.get(suffix);
  });
  return mapped.join('');
}

/** House number with an optional letter and an optional range: "12", "12a", "12-14", "12/3". */
const HOUSE_NUMBER = String.raw`\d{1,5}\s*[a-z]?(?:\s*[-/]\s*\d{1,5}\s*[a-z]?)?`;
const TRAILING_NUMBER = new RegExp(String.raw`^(.*?)[\s,]+(${HOUSE_NUMBER})$`, 'i');
const LEADING_NUMBER = new RegExp(String.raw`^(${HOUSE_NUMBER})[\s,]+(.*)$`, 'i');

/**
 * Splits a street line into street and house number. Accepts the German order ("Hauptstraße 12a")
 * and the English one ("12 Main Street"); without a recognizable number the line stays unchanged.
 * The returned parts are raw (not normalized), so callers can normalize them with their own rules.
 */
export function splitHouseNumber(street: string): { street: string; houseNumber?: string } {
  const line = street.trim();
  const trailing = TRAILING_NUMBER.exec(line);
  if (trailing?.[1] !== undefined && trailing[2] !== undefined && trailing[1].trim() !== '') {
    return { street: trailing[1].trim(), houseNumber: trailing[2].trim() };
  }
  const leading = LEADING_NUMBER.exec(line);
  if (leading?.[1] !== undefined && leading[2] !== undefined && leading[2].trim() !== '') {
    return { street: leading[2].trim(), houseNumber: leading[1].trim() };
  }
  return { street: line };
}

/** Normalized house number without whitespace ("12 A" = "12a"). */
export function normalizeHouseNumber(houseNumber: string): string {
  return normalizeText(houseNumber).replace(/ /g, '');
}

/** Normalized unit designation without noise words ("Whg. 3" = "3"). */
export function normalizeUnit(unit: string, config: DuplicateConfig): string {
  const noise = new Set(config.normalization.unitNoiseWords.map(normalizeText));
  return words(unit)
    .filter((word) => !noise.has(word))
    .join('');
}

/** Postal code without whitespace and separators ("SW1A 1AA" = "sw1a1aa"). */
export function normalizePostalCode(postalCode: string): string {
  return normalizeText(postalCode).replace(/ /g, '');
}

/** Cadastral reference without whitespace and separators. */
export function normalizeParcelId(parcelId: string): string {
  return normalizeText(parcelId).replace(/ /g, '');
}

/**
 * Street and house number of an address, wherever the number stands: `houseNumber` wins, else the
 * number is taken from the street line (Req 1.8, 3.2).
 */
export function addressParts(
  address: { street?: string | undefined; houseNumber?: string | undefined },
  config: DuplicateConfig,
): { street: string; houseNumber?: string } {
  const line = address.street ?? '';
  const explicit = address.houseNumber?.trim();
  if (explicit !== undefined && explicit !== '') {
    // The street line may repeat the number; it is removed so both spellings match.
    const { street } = splitHouseNumber(line);
    return { street: normalizeStreet(street, config), houseNumber: normalizeHouseNumber(explicit) };
  }
  const split = splitHouseNumber(line);
  const street = normalizeStreet(split.street, config);
  return split.houseNumber === undefined
    ? { street }
    : { street, houseNumber: normalizeHouseNumber(split.houseNumber) };
}
