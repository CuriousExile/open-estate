import type { LocationsDocument } from '@open-estate/shared';
import type { LocaleStorage } from '../src/app/locale/resolve-locale';
import {
  availableCountry,
  CLOSED_COMBOBOX,
  citySuggestions,
  comboboxKey,
  COUNTRY_STORAGE_KEY,
  countryName,
  countryOptions,
  foldText,
  initialCountry,
  MAX_CITY_SUGGESTIONS,
  parseCountryCode,
  readStoredCountry,
  withCountry,
  writeStoredCountry,
} from '../src/app/location/location-model';

const DOC: LocationsDocument = {
  countries: [
    { code: 'DE', count: 7 },
    { code: 'TH', count: 2 },
  ],
  cities: [
    { name: 'Berlin', country: 'DE', count: 4 },
    { name: 'Lübeck', country: 'DE', count: 1 },
    { name: 'Frankfurt am Main', country: 'DE', count: 2 },
    { name: 'Bangkok', country: 'TH', count: 1 },
    { name: 'Pattaya', country: 'TH', count: 1 },
  ],
};

const names = (query: string, country = '', doc = DOC) =>
  citySuggestions(doc, query, country, 'de').map((c) => c.name);

describe('foldText', () => {
  it('ignores case and diacritics', () => {
    expect(foldText('Lübeck')).toBe('lubeck');
    expect(foldText(' MÜNCHEN ')).toBe('munchen');
    expect(foldText('Mu\u0308nchen')).toBe('munchen');
    expect(foldText('Straße')).toBe('strasse');
  });
});

describe('citySuggestions', () => {
  it('matches the typed prefix case- and diacritic-insensitively ("lub" → Lübeck)', () => {
    expect(names('lub')).toEqual(['Lübeck']);
    expect(names('LÜB')).toEqual(['Lübeck']);
    expect(names('b')).toEqual(['Berlin', 'Bangkok']);
  });

  it('filters by the selected country', () => {
    expect(names('b', 'TH')).toEqual(['Bangkok']);
    expect(names('b', 'DE')).toEqual(['Berlin']);
    expect(names('pat', 'DE')).toEqual([]);
  });

  it('ranks word matches after prefix matches', () => {
    expect(names('main')).toEqual(['Frankfurt am Main']);
    expect(names('fr')).toEqual(['Frankfurt am Main']);
  });

  it('suggests nothing for an empty query or without data', () => {
    expect(names('  ')).toEqual([]);
    expect(citySuggestions(undefined, 'b', '', 'de')).toEqual([]);
  });

  it('orders by count, then name, at most 8, with country label and count', () => {
    const many: LocationsDocument = {
      countries: [{ code: 'DE', count: 12 }],
      cities: Array.from({ length: 12 }, (_, i) => ({
        name: `Bad ${String.fromCharCode(65 + i)}`,
        country: 'DE',
        count: i === 5 ? 9 : 1,
      })),
    };
    const result = citySuggestions(many, 'bad', '', 'de');
    expect(result).toHaveLength(MAX_CITY_SUGGESTIONS);
    expect(result[0]).toEqual({
      name: 'Bad F',
      country: 'DE',
      count: 9,
      countryLabel: countryName('DE', 'de'),
    });
    expect(result.slice(1, 3).map((c) => c.name)).toEqual(['Bad A', 'Bad B']);
  });
});

describe('country options', () => {
  it('labels countries in the active language and sorts by label', () => {
    expect(countryName('TH', 'de')).toBe('Thailand');
    expect(countryName('DE', 'de')).toBe('Deutschland');
    expect(countryName('DE', 'en')).toBe('Germany');
    expect(countryOptions(DOC, 'en')).toEqual([
      { code: 'DE', label: 'Germany', count: 7 },
      { code: 'TH', label: 'Thailand', count: 2 },
    ]);
    expect(countryOptions(undefined, 'en')).toEqual([]);
  });

  it('falls back to the code for an invalid locale', () => {
    expect(countryName('DE', '!!')).toBe('DE');
  });
});

describe('country selection', () => {
  it('parses ISO 3166-1 alpha-2 codes only', () => {
    expect(parseCountryCode(' th ')).toBe('TH');
    expect(parseCountryCode('THA')).toBeUndefined();
    expect(parseCountryCode('')).toBeUndefined();
    expect(parseCountryCode(null)).toBeUndefined();
  });

  it('prefers a valid ?country= over the stored choice', () => {
    expect(initialCountry('th', 'DE')).toBe('TH');
    expect(initialCountry('nope', 'DE')).toBe('DE');
    expect(initialCountry(null, undefined)).toBe('');
  });

  it('falls back to all countries once the selection has no listings', () => {
    expect(availableCountry('TH', DOC)).toBe('TH');
    expect(availableCountry('FR', DOC)).toBe('');
    expect(availableCountry('FR', undefined)).toBe('FR');
  });

  it('stores and clears the choice; storage failures are not fatal', () => {
    const data = new Map<string, string>();
    const storage: LocaleStorage = {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
    };
    expect(writeStoredCountry(() => storage, 'TH')).toBe(true);
    expect(data.get(COUNTRY_STORAGE_KEY)).toBe('TH');
    expect(readStoredCountry(() => storage)).toBe('TH');
    expect(writeStoredCountry(() => storage, '')).toBe(true);
    expect(readStoredCountry(() => storage)).toBeUndefined();
    const broken = () => {
      throw new Error('blocked');
    };
    expect(writeStoredCountry(broken, 'TH')).toBe(false);
    expect(readStoredCountry(broken)).toBeUndefined();
  });

  it('adds the country to a search and leaves "no search yet" alone', () => {
    expect(withCountry(undefined, 'TH')).toBeUndefined();
    expect(withCountry({ offerType: 'SALE' }, 'TH')).toEqual({ offerType: 'SALE', country: 'TH' });
    expect(withCountry({ offerType: 'SALE', country: 'TH' }, '')).toEqual({ offerType: 'SALE' });
  });
});

describe('comboboxKey', () => {
  const open = (active: number) => ({ open: true, active });

  it('opens with ArrowDown/ArrowUp and wraps the highlight', () => {
    expect(comboboxKey(CLOSED_COMBOBOX, 'ArrowDown', 3).state).toEqual(open(0));
    expect(comboboxKey(CLOSED_COMBOBOX, 'ArrowUp', 3).state).toEqual(open(2));
    expect(comboboxKey(open(2), 'ArrowDown', 3).state).toEqual(open(0));
    expect(comboboxKey(open(0), 'ArrowUp', 3).state).toEqual(open(2));
    expect(comboboxKey(open(0), 'ArrowDown', 3).action).toEqual({ type: 'move' });
  });

  it('jumps with Home/End only while open', () => {
    expect(comboboxKey(open(1), 'End', 3).state).toEqual(open(2));
    expect(comboboxKey(open(1), 'Home', 3).state).toEqual(open(0));
    expect(comboboxKey(CLOSED_COMBOBOX, 'Home', 3)).toEqual({
      state: CLOSED_COMBOBOX,
      action: { type: 'none' },
    });
  });

  it('selects the highlighted option with Enter, otherwise lets the form submit', () => {
    expect(comboboxKey(open(1), 'Enter', 3)).toEqual({
      state: CLOSED_COMBOBOX,
      action: { type: 'select', index: 1 },
    });
    expect(comboboxKey(open(-1), 'Enter', 3).action).toEqual({ type: 'none' });
    expect(comboboxKey(CLOSED_COMBOBOX, 'Enter', 3).action).toEqual({ type: 'none' });
  });

  it('closes with Escape (handled only while open) and Tab', () => {
    expect(comboboxKey(open(1), 'Escape', 3)).toEqual({
      state: CLOSED_COMBOBOX,
      action: { type: 'close' },
    });
    expect(comboboxKey(CLOSED_COMBOBOX, 'Escape', 3).action).toEqual({ type: 'none' });
    expect(comboboxKey(open(1), 'Tab', 3)).toEqual({
      state: CLOSED_COMBOBOX,
      action: { type: 'none' },
    });
  });

  it('ignores other keys and does nothing without options', () => {
    expect(comboboxKey(open(1), 'a', 3)).toEqual({ state: open(1), action: { type: 'none' } });
    expect(comboboxKey(CLOSED_COMBOBOX, 'ArrowDown', 0)).toEqual({
      state: CLOSED_COMBOBOX,
      action: { type: 'none' },
    });
  });
});
