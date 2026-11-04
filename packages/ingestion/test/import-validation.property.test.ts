// Feature: real-estate-platform, Property 11: Import-Validierung akzeptiert genau gültige Listings
import { LISTING_BOUNDS as B } from '@open-estate/shared';
import fc from 'fast-check';
import { arbListing, LOCALE_POOL } from '../../shared/test/arbitraries';
import {
  covers,
  expectedStored,
  setupImport,
  toInput,
  type Input,
  type Obj,
} from './support/import-harness';

/**
 * Property 11: a candidate is stored iff every required field is present and every value lies in
 * its range or value list (rooms in steps of 0.5, geo pair complete or absent, ≤ 20 translations
 * with unique locales including the original locale); a rejection names every violating field.
 *
 * Strategy: a valid listing from `arbListing` in the input representation (decimal strings) plus
 * 0..k targeted mutations from a catalog. Every mutation returns the field it violates. Mutations
 * are grouped into slots (one mutation per slot) so that two mutations never cancel each other
 * out (e.g. removing `translations` and duplicating a locale in it). Media, tours and PII are not
 * mutated: the pipeline drops those element by element instead of rejecting (other properties).
 *
 * **Validates: Requirements 4.1, 4.2, 4.4, 4.5, 4.6, 4.8, 4.9, 4.10, 14.1, 14.2**
 */

const RUN_ID = 'run-11';

interface Mutation {
  /** Mutations of one slot touch the same fields; at most one per slot is applied. */
  readonly slot: string;
  readonly name: string;
  /** Mutates `input` in place and returns the violated field path. */
  readonly apply: (input: Input) => string;
  /** Used by fast-check to print counterexamples. */
  readonly [fc.toStringMethod]: () => string;
}

// ---------------------------------------------------------------------------------------------
// Mutation catalog
// ---------------------------------------------------------------------------------------------

const tooLong = (bounds: { readonly max: number }): string => 'x'.repeat(bounds.max + 1);

const obj = (input: Input, key: string): Obj => input[key] as Obj;
const translations = (input: Input): Obj[] => input['translations'] as Obj[];
const firstOffer = (input: Input): Obj => (input['offers'] as Obj[])[0] as Obj;
/** Amount field of the first offer (`price` for SALE, `coldRent` for RENT). */
const amountKey = (offer: Obj): string => (offer['offerType'] === 'SALE' ? 'price' : 'coldRent');

const swapCase = (tag: string): string =>
  tag === tag.toUpperCase() ? tag.toLowerCase() : tag.toUpperCase();

/** Pool locales not yet used by the original locale or a translation (case-insensitive). */
function unusedLocales(input: Input): string[] {
  const used = new Set(
    [input['originalLocale'], ...translations(input).map((t) => t['locale'])].map((l) =>
      String(l).toLowerCase(),
    ),
  );
  return LOCALE_POOL.filter((l) => !used.has(l.toLowerCase()));
}

/** Appends a valid translation with an unused locale. */
function pushTranslation(input: Input): void {
  const [locale = 'xx'] = unusedLocales(input);
  translations(input).push({ locale, title: 'Titel', description: '' });
}

/** Index of a translation that exists afterwards (one is appended if there is none). */
function ensureTranslation(input: Input): number {
  if (translations(input).length === 0) pushTranslation(input);
  return 0;
}

/** Field `key` of `input` (or of `input[parent]`) is removed or set to `value`. */
function setField(parent: string | undefined, key: string, value: unknown) {
  return (input: Input): string => {
    const target = parent === undefined ? input : obj(input, parent);
    if (value === undefined) Reflect.deleteProperty(target, key);
    else target[key] = value;
    return parent === undefined ? key : `${parent}.${key}`;
  };
}

/** Mutation printed by its name in counterexamples. */
const make = (slot: string, name: string, apply: (input: Input) => string): Mutation => ({
  slot,
  name,
  apply,
  [fc.toStringMethod]: () => `${slot}: ${name}`,
});

const describeValue = (value: unknown): string =>
  value === undefined ? 'removed' : (JSON.stringify(value) ?? String(value)).slice(0, 40);

/** Same slot, several fixed variants of one field. */
function fieldVariants(
  slot: string,
  parent: string | undefined,
  key: string,
  values: readonly unknown[],
): fc.Arbitrary<Mutation> {
  const path = parent === undefined ? key : `${parent}.${key}`;
  return fc
    .constantFrom(...values)
    .map((value) => make(slot, `${path} = ${describeValue(value)}`, setField(parent, key, value)));
}

const mutation = (slot: string, name: string, apply: (input: Input) => string) =>
  fc.constant(make(slot, name, apply));

const ensureGeo = (input: Input): Obj => {
  input['geo'] ??= { lat: 0, lon: 0 };
  return obj(input, 'geo');
};

const MUTATIONS: readonly fc.Arbitrary<Mutation>[] = [
  // Req 4.1: required fields and their bounds.
  fieldVariants('id', undefined, 'id', [undefined, '', tooLong(B.id), 42]),
  fieldVariants('title', undefined, 'title', [undefined, '', tooLong(B.title), 7]),
  fieldVariants('description', undefined, 'description', [undefined, tooLong(B.description)]),
  fieldVariants('listingType', undefined, 'listingType', [undefined, 'castle', '']),
  fieldVariants('sourceUrl', undefined, 'sourceUrl', [
    undefined,
    'ftp://files.example/listing',
    'not a url',
    `https://partner.example/${'a'.repeat(B.url.max)}`,
  ]),
  fieldVariants('offers', undefined, 'offers', [undefined]),
  mutation('offers', 'offers.0.currency = "eur"', (input) => {
    firstOffer(input)['currency'] = 'eur';
    return 'offers.0.currency';
  }),
  fc.constantFrom('1000000000.00', '0.00', '-5.00', '12.345').map((amount) =>
    make('offers', `offers.0 amount = ${amount}`, (input) => {
      const offer = firstOffer(input);
      const key = amountKey(offer);
      offer[key] = amount;
      // warmRent ≥ coldRent is Property 12; keep it out of this mutation.
      delete offer['warmRent'];
      return `offers.0.${key}`;
    }),
  ),
  // Req 4.4: rooms 0–99.5 in steps of 0.5.
  fc
    .oneof(
      fc.integer({ min: 0, max: 98 }).map((n) => n + 0.3),
      fc.constantFrom(-0.5, B.rooms.max + B.rooms.step, 2.3, 0.25),
      fc.constantFrom<unknown>(undefined, '3'),
    )
    .map((rooms) =>
      make('rooms', `rooms = ${describeValue(rooms)}`, setField(undefined, 'rooms', rooms)),
    ),
  // Req 4.5: area 1–100,000 m², ≤ 2 fraction digits.
  fieldVariants('area', undefined, 'area', [undefined, '0.99', '100000.01', '12.345', 50]),
  // Req 4.2: address.
  fieldVariants('address', undefined, 'address', [undefined]),
  fieldVariants('address', 'address', 'city', [undefined, '', tooLong(B.city)]),
  fieldVariants('address', 'address', 'postalCode', [undefined, '', tooLong(B.postalCode)]),
  fieldVariants('address', 'address', 'country', [undefined, 'DEU', 'de', 'Germany']),
  fieldVariants('address', 'address', 'street', ['', tooLong(B.street)]),
  // Req 4.6, 4.10: geo pair complete or absent, within range.
  fc
    .constantFrom<[string, number | undefined]>(
      ['lat', undefined],
      ['lon', undefined],
      ['lat', 90.5],
      ['lat', -91],
      ['lon', 180.5],
      ['lon', -181],
    )
    .map(([key, value]) =>
      make('geo', `geo.${key} = ${describeValue(value)}`, (input) => {
        const geo = ensureGeo(input);
        if (value === undefined) Reflect.deleteProperty(geo, key);
        else geo[key] = value;
        return `geo.${key}`;
      }),
    ),
  // Req 14.1, 14.2: original locale and translations (one slot: these mutations interact).
  fieldVariants('locales', undefined, 'originalLocale', [
    undefined,
    '',
    'not a locale',
    'x'.repeat(B.locale.max + 1),
  ]),
  fieldVariants('locales', undefined, 'translations', [undefined]),
  mutation('locales', 'translation repeats the original locale (other case)', (input) => {
    const list = translations(input);
    const locale = swapCase(String(input['originalLocale']));
    if (list.length === 0) {
      list.push({ locale, title: 'Titel', description: '' });
      return 'translations.0.locale';
    }
    const last = list.length - 1;
    (list[last] as Obj)['locale'] = locale;
    return `translations.${last}.locale`;
  }),
  mutation('locales', 'two translations share a locale (other case)', (input) => {
    if (translations(input).length === 0) pushTranslation(input);
    const list = translations(input);
    const locale = swapCase(String((list[0] as Obj)['locale']));
    if (list.length < B.translations.max) {
      list.push({ locale, title: 'Titel', description: '' });
      return `translations.${list.length - 1}.locale`;
    }
    const last = list.length - 1;
    (list[last] as Obj)['locale'] = locale;
    return `translations.${last}.locale`;
  }),
  mutation('locales', 'translation with invalid locale', (input) => {
    const index = ensureTranslation(input);
    (translations(input)[index] as Obj)['locale'] = 'not a locale';
    return `translations.${index}.locale`;
  }),
  mutation('locales', 'translation with empty title', (input) => {
    const index = ensureTranslation(input);
    (translations(input)[index] as Obj)['title'] = '';
    return `translations.${index}.title`;
  }),
  mutation('locales', `${B.translations.max + 1} translations`, (input) => {
    while (translations(input).length <= B.translations.max) pushTranslation(input);
    return 'translations';
  }),
];

/** No mutation (valid candidate) or 1–4 mutations from distinct slots. */
const arbMutations: fc.Arbitrary<Mutation[]> = fc.oneof(
  { arbitrary: fc.constant<Mutation[]>([]), weight: 1 },
  {
    arbitrary: fc.uniqueArray(fc.oneof(...MUTATIONS), {
      minLength: 1,
      maxLength: 4,
      selector: (m) => m.slot,
    }),
    weight: 3,
  },
);

describe('Property 11: Import-Validierung akzeptiert genau gültige Listings', () => {
  it('stores exactly the valid candidates and names every violating field', async () => {
    await fc.assert(
      fc.asyncProperty(arbListing(), arbMutations, async (listing, mutations) => {
        const input = structuredClone(toInput(listing));
        const named = mutations.map((m) => m.apply(input));
        // Without a valid `id` (and no `customId`) the record is rejected at the identity step,
        // before validation; only `id` is named (Req 12.4).
        const expected = named.includes('id') ? ['id'] : named;
        const t = setupImport(RUN_ID);

        const outcome = await t.process(input);

        if (mutations.length === 0) {
          expect(outcome).toBe('imported');
          expect(t.writes()).toBe(1);
          expect(t.store.get(listing.id)).toEqual(expectedStored(listing, RUN_ID));
          expect(t.rejectedFields()).toEqual([]);
          return;
        }

        expect(outcome).toBe('rejected');
        expect(t.writes()).toBe(0);
        const logged = t.rejectedFields();
        // Every violating field is named …
        expect(expected.filter((field) => !logged.some((l) => covers(l, field)))).toEqual([]);
        // … and no field outside the mutations.
        expect(logged.filter((l) => !expected.some((field) => covers(l, field)))).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});
