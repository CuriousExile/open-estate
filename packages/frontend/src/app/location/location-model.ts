// Framework-free logic of the country selector and the city autocomplete (`GET /locations`).
// Kept free of Angular and DOM types so it can be unit-tested with plain Jest.
import type { CityFacet, LocationsDocument } from '@open-estate/shared';
import type { SearchParams } from '../api/api-client';
import type { LocaleStorage, StorageProvider } from '../locale/resolve-locale';

/** At most this many city suggestions are shown. */
export const MAX_CITY_SUGGESTIONS = 8;

/** `localStorage` key of the country choice (next to the language choice). */
export const COUNTRY_STORAGE_KEY = 'open-estate.country';

/** URL query parameter that preselects a country (deep link), e.g. `/?country=TH`. */
export const COUNTRY_QUERY_PARAM = 'country';

const COUNTRY_CODE = /^[A-Z]{2}$/;

/** ISO 3166-1 alpha-2 in upper case, or `undefined` (input is trimmed and upper-cased). */
export function parseCountryCode(value: string | null | undefined): string | undefined {
  const code = value?.trim().toUpperCase() ?? '';
  return COUNTRY_CODE.test(code) ? code : undefined;
}

/** Case- and diacritic-insensitive form for prefix matching ("Lübeck" → "lubeck"). */
export function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('und')
    .replace(/ß/g, 'ss')
    .trim();
}

export interface CountryOption {
  code: string;
  /** Localized country name (`Intl.DisplayNames`), the code if the runtime has none. */
  label: string;
  count: number;
}

/** Localized country name; falls back to the code. */
export function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale || 'en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Collator of `locale`; the default one for an empty or invalid tag. */
function collatorFor(locale: string): Intl.Collator {
  try {
    return new Intl.Collator(locale || undefined);
  } catch {
    return new Intl.Collator();
  }
}

/** Countries with listings, labelled in `locale` and sorted by label in that locale. */
export function countryOptions(
  doc: LocationsDocument | undefined,
  locale: string,
): CountryOption[] {
  const collator = collatorFor(locale);
  return (doc?.countries ?? [])
    .map(({ code, count }) => ({ code, label: countryName(code, locale), count }))
    .sort((a, b) => collator.compare(a.label, b.label));
}

export interface CitySuggestion extends CityFacet {
  /** Localized country name for the suggestion line. */
  countryLabel: string;
}

/**
 * City suggestions for the typed text: cities of `country` (all countries if empty) whose folded
 * name starts with the folded query — or, as second rank, has a word starting with it ("frank" →
 * "Frankfurt am Main", "main" → "Frankfurt am Main"). More listings first, then by name. No
 * suggestions for an empty query.
 */
export function citySuggestions(
  doc: LocationsDocument | undefined,
  query: string,
  country: string,
  locale: string,
  limit = MAX_CITY_SUGGESTIONS,
): CitySuggestion[] {
  const needle = foldText(query);
  if (needle === '' || doc === undefined) return [];
  const collator = collatorFor(locale);
  const ranked: { city: CityFacet; rank: number }[] = [];
  for (const city of doc.cities) {
    if (country !== '' && city.country !== country) continue;
    const name = foldText(city.name);
    const rank = name.startsWith(needle)
      ? 0
      : name.split(/[\s\-/()]+/).some((word) => word.startsWith(needle))
        ? 1
        : -1;
    if (rank >= 0) ranked.push({ city, rank });
  }
  return ranked
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        b.city.count - a.city.count ||
        collator.compare(a.city.name, b.city.name) ||
        a.city.country.localeCompare(b.city.country),
    )
    .slice(0, limit)
    .map(({ city }) => ({ ...city, countryLabel: countryName(city.country, locale) }));
}

/**
 * Search parameters with the header's country (`''` = no country filter); `undefined` stays
 * `undefined` (no search yet).
 */
export function withCountry(
  params: SearchParams | undefined,
  country: string,
): SearchParams | undefined {
  if (params === undefined) return undefined;
  const rest: SearchParams = { ...params };
  delete rest.country;
  return country === '' ? rest : { ...rest, country };
}

/**
 * Country at startup: a valid `?country=` wins over the stored choice; `''` = all countries.
 * Whether the country still has listings is checked once `/locations` is loaded
 * ({@link availableCountry}).
 */
export function initialCountry(queryParam: string | null, stored: string | undefined): string {
  return parseCountryCode(queryParam) ?? parseCountryCode(stored) ?? '';
}

/**
 * The selection if it has listings, else `''` (all countries). Without a loaded document the
 * selection is kept, so a slow or failed `/locations` does not reset a stored choice.
 */
export function availableCountry(selected: string, doc: LocationsDocument | undefined): string {
  if (selected === '' || doc === undefined) return selected;
  return doc.countries.some((c) => c.code === selected) ? selected : '';
}

export function readStoredCountry(storage: StorageProvider): string | undefined {
  try {
    return parseCountryCode(storage()?.getItem(COUNTRY_STORAGE_KEY));
  } catch {
    return undefined;
  }
}

/** Stores the choice; `''` removes it. Returns `false` if storage is not accessible. */
export function writeStoredCountry(storage: StorageProvider, country: string): boolean {
  try {
    const target: LocaleStorage | null | undefined = storage();
    if (!target) return false;
    if (country === '') target.removeItem(COUNTRY_STORAGE_KEY);
    else target.setItem(COUNTRY_STORAGE_KEY, country);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Combobox keyboard model (WAI-ARIA combobox with listbox popup)
// ---------------------------------------------------------------------------------------------

export interface ComboboxState {
  open: boolean;
  /** Index of the highlighted option (`aria-activedescendant`), `-1` = none. */
  active: number;
}

export const CLOSED_COMBOBOX: ComboboxState = { open: false, active: -1 };

export type ComboboxAction =
  | { type: 'none' }
  /** The key was handled: call `preventDefault`. */
  | { type: 'move' }
  | { type: 'select'; index: number }
  | { type: 'close' };

/**
 * Next state for a key in the input. ArrowDown/ArrowUp open the list and move the highlight
 * (wrapping), Home/End jump while open, Enter selects the highlighted option (otherwise it submits
 * the form as usual), Escape closes the list, Tab closes without selecting.
 */
export function comboboxKey(
  state: ComboboxState,
  key: string,
  count: number,
): { state: ComboboxState; action: ComboboxAction } {
  if (count === 0) {
    return {
      state: CLOSED_COMBOBOX,
      action: state.open && key === 'Escape' ? { type: 'close' } : { type: 'none' },
    };
  }
  const last = count - 1;
  switch (key) {
    case 'ArrowDown':
      return {
        state: { open: true, active: !state.open || state.active >= last ? 0 : state.active + 1 },
        action: { type: 'move' },
      };
    case 'ArrowUp':
      return {
        state: { open: true, active: !state.open || state.active <= 0 ? last : state.active - 1 },
        action: { type: 'move' },
      };
    case 'Home':
    case 'End':
      if (!state.open) return { state, action: { type: 'none' } };
      return { state: { open: true, active: key === 'Home' ? 0 : last }, action: { type: 'move' } };
    case 'Enter':
      if (state.open && state.active >= 0 && state.active <= last) {
        return { state: CLOSED_COMBOBOX, action: { type: 'select', index: state.active } };
      }
      return { state: CLOSED_COMBOBOX, action: { type: 'none' } };
    case 'Escape':
      return {
        state: CLOSED_COMBOBOX,
        action: state.open ? { type: 'close' } : { type: 'none' },
      };
    case 'Tab':
      return { state: CLOSED_COMBOBOX, action: { type: 'none' } };
    default:
      return { state, action: { type: 'none' } };
  }
}
