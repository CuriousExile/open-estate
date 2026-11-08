import fc from 'fast-check';
import {
  assertValidTaxonomy,
  DEFAULT_TAXONOMY_CONFIG,
  ListingContent,
  type ListingContentInput,
  type OfferType,
} from '@open-estate/shared';

// Generators for the Duplikat-Erkennung (duplicate-detection tasks 2.11, 3.x). Unlike
// `arbListing`, these build *realistic* listings from word pools: the normalization rules
// (Req 3.2) are about spellings of real addresses and texts, and arbitrary Unicode noise would
// only test the code against itself.

export const TAXONOMY = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);

const CITIES = [
  { city: 'Berlin', postalCode: '10115', country: 'DE' },
  { city: 'München', postalCode: '80331', country: 'DE' },
  { city: 'Wien', postalCode: '1010', country: 'AT' },
  { city: 'Zürich', postalCode: '8001', country: 'CH' },
  { city: 'London', postalCode: 'SW1A1AA', country: 'GB' },
] as const;

const STREETS = [
  'Hauptstraße',
  'Bahnhofstraße',
  'Müllerweg',
  'Allee der Kosmonauten',
  'Main Street',
  'Church Road',
] as const;

const TITLE_WORDS = [
  'Helle',
  'Ruhige',
  'Moderne',
  'Altbauwohnung',
  'Neubau',
  'Maisonette',
  'mit',
  'Balkon',
  'Garten',
  'Blick',
  'im',
  'Zentrum',
] as const;

const DESCRIPTION_WORDS = [
  'Die',
  'Wohnung',
  'liegt',
  'ruhig',
  'und',
  'zentral',
  'Fenster',
  'nach',
  'Süden',
  'frisch',
  'saniert',
  'Parkett',
  'Einbauküche',
] as const;

const phrase = (pool: readonly string[], min: number, max: number): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...pool), { minLength: min, maxLength: max }).map((w) => w.join(' '));

const arbHouseNumber: fc.Arbitrary<string> = fc.oneof(
  fc.integer({ min: 1, max: 200 }).map(String),
  fc
    .tuple(fc.integer({ min: 1, max: 200 }), fc.constantFrom('a', 'b', 'c'))
    .map(([n, s]) => `${n}${s}`),
);

const arbMediaUrl: fc.Arbitrary<string> = fc
  .integer({ min: 1, max: 50 })
  .map((n) => `https://cdn.example/img/${n}.jpg`);

export interface ContentArbOptions {
  /** Listing types to choose from (default: apartment types of the default taxonomy). */
  listingTypes?: readonly string[];
  /** Offer types of the listing (default: one of SALE, RENT). */
  offerTypes?: readonly OfferType[];
}

/**
 * Realistic Listing_Inhalt in the API representation, with optional street, house number, unit,
 * geo, media and Objektmerkmale.
 */
export function arbRealisticInput(
  options: ContentArbOptions = {},
): fc.Arbitrary<ListingContentInput> {
  const types = options.listingTypes ?? ['apartment_unit', 'condominium', 'loft'];
  return fc
    .record(
      {
        place: fc.constantFrom(...CITIES),
        street: fc.constantFrom(...STREETS),
        houseNumber: arbHouseNumber,
        unit: fc.oneof(fc.integer({ min: 1, max: 40 }).map(String), fc.constant('EG links')),
        title: phrase(TITLE_WORDS, 2, 6),
        description: phrase(DESCRIPTION_WORDS, 0, 10),
        listingType: fc.constantFrom(...types),
        offerType: fc.constantFrom(...(options.offerTypes ?? (['SALE', 'RENT'] as const))),
        amount: fc.integer({ min: 500, max: 900_000 }),
        currency: fc.constantFrom('EUR', 'CHF'),
        rooms: fc.integer({ min: 0, max: 12 }).map((n) => n / 2),
        area: fc.integer({ min: 20, max: 400 }),
        geo: fc.record({
          lat: fc.integer({ min: -890_000, max: 890_000 }).map((n) => n / 10_000),
          lon: fc.integer({ min: -1_790_000, max: 1_790_000 }).map((n) => n / 10_000),
        }),
        media: fc.array(arbMediaUrl, { maxLength: 6 }),
        floor: fc.integer({ min: -2, max: 20 }),
        totalFloors: fc.integer({ min: 20, max: 40 }),
        yearBuilt: fc.integer({ min: 1850, max: 2030 }),
        bedrooms: fc.integer({ min: 0, max: 8 }),
        bathrooms: fc.integer({ min: 0, max: 4 }),
        parcelId: fc.integer({ min: 1, max: 9999 }).map((n) => `Flur 3/${n}`),
        sourceUrl: fc.integer({ min: 1, max: 10_000 }).map((n) => `https://makler.example/w/${n}`),
      },
      {
        requiredKeys: [
          'place',
          'title',
          'description',
          'listingType',
          'offerType',
          'amount',
          'currency',
          'rooms',
          'area',
          'media',
          'sourceUrl',
        ],
      },
    )
    .map(({ place, street, houseNumber, unit, offerType, amount, currency, ...rest }) => ({
      originalLocale: 'de',
      title: rest.title,
      description: rest.description,
      translations: [],
      offers: [
        offerType === 'SALE'
          ? { offerType: 'SALE' as const, price: `${amount}.00`, currency }
          : { offerType: 'RENT' as const, coldRent: `${amount}.00`, currency },
      ],
      listingType: rest.listingType,
      rooms: rest.rooms,
      area: `${rest.area}.00`,
      address: {
        city: place.city,
        postalCode: place.postalCode,
        country: place.country,
        ...(street !== undefined && {
          street: houseNumber === undefined ? street : `${street} ${houseNumber}`,
        }),
        ...(unit !== undefined && { unit }),
      },
      ...(rest.geo !== undefined && { geo: rest.geo }),
      sourceUrl: rest.sourceUrl,
      media: rest.media.map((url) => ({ url })),
      tours: [],
      ...(rest.floor !== undefined && { floor: rest.floor }),
      ...(rest.totalFloors !== undefined && { totalFloors: rest.totalFloors }),
      ...(rest.yearBuilt !== undefined && { yearBuilt: rest.yearBuilt }),
      ...(rest.bedrooms !== undefined && { bedrooms: rest.bedrooms }),
      ...(rest.bathrooms !== undefined && { bathrooms: rest.bathrooms }),
      ...(rest.parcelId !== undefined && { parcelId: rest.parcelId }),
    }));
}

/** Realistic Listing_Inhalt in the internal representation. */
export const arbRealisticContent = (
  options: ContentArbOptions = {},
): fc.Arbitrary<ListingContent> =>
  arbRealisticInput(options).map((input) => ListingContent.parse(input));

// ---------------------------------------------------------------------------------------------
// Formatting variants (Req 3.2): same meaning, different spelling
// ---------------------------------------------------------------------------------------------

/** Spellings of a street suffix that must normalize alike. */
const SUFFIX_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  straße: ['straße', 'strasse', ' Str.', ' str', 'Straße'],
  Street: ['Street', ' St.', 'street'],
  Road: ['Road', ' Rd.', 'road'],
};

/** Replaces the suffix of a street name with an equivalent spelling. */
function varyStreetSuffix(street: string, pick: number): string {
  for (const [suffix, variants] of Object.entries(SUFFIX_VARIANTS)) {
    if (street.toLowerCase().endsWith(suffix.toLowerCase())) {
      const variant = variants[pick % variants.length] ?? suffix;
      return street.slice(0, street.length - suffix.length) + variant;
    }
  }
  return street;
}

/** Upper/lower case and extra punctuation between words; never inside a word. */
function varyText(text: string, seed: number): string {
  const words = text.split(' ').filter((w) => w !== '');
  const separator = ['  ', ' - ', ', ', ' '][seed % 4] ?? ' ';
  const cased = words.map((word, index) =>
    (seed + index) % 2 === 0 ? word.toLocaleUpperCase('de') : word.toLocaleLowerCase('de'),
  );
  return `${cased.join(separator)}${seed % 3 === 0 ? '!' : ''}`;
}

/** "ß" ↔ "ss" and umlaut ↔ transliteration: both must normalize alike. */
function varyUmlauts(text: string, seed: number): string {
  if (seed % 2 === 0) return text;
  return text.replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue');
}

export interface VariantOptions {
  /** Move the house number from the street line into `address.houseNumber` (Req 1.8). */
  splitHouseNumber: boolean;
  /** Prefix the unit with a noise word ("Whg. 3"). */
  unitNoise: boolean;
  seed: number;
}

export const arbVariantOptions: fc.Arbitrary<VariantOptions> = fc.record({
  splitHouseNumber: fc.boolean(),
  unitNoise: fc.boolean(),
  seed: fc.integer({ min: 0, max: 1000 }),
});

const HOUSE_NUMBER_AT_END = /^(.*?)[\s]+(\d{1,5}\s?[a-c]?)$/;

/**
 * Same listing, differently written: case, whitespace, punctuation, "ß"/"ss", street suffix,
 * house number in the street line or in its own field, noise words in the unit, media in another
 * order. The Merkmalsprofil must not change (Property 5, Property 8).
 */
export function formattingVariant(
  input: ListingContentInput,
  options: VariantOptions,
): ListingContentInput {
  const { seed } = options;
  const address = { ...input.address };
  if (address.street !== undefined) {
    const match = HOUSE_NUMBER_AT_END.exec(address.street);
    const street = match?.[1] ?? address.street;
    const houseNumber = match?.[2];
    const variedStreet = varyUmlauts(varyStreetSuffix(street, seed), seed);
    if (houseNumber !== undefined && options.splitHouseNumber) {
      address.street = variedStreet;
      address.houseNumber = seed % 2 === 0 ? houseNumber : houseNumber.toUpperCase();
    } else if (houseNumber !== undefined) {
      address.street = `${variedStreet}${seed % 2 === 0 ? ' ' : '  '}${houseNumber}`;
    } else {
      address.street = variedStreet;
    }
  }
  if (address.unit !== undefined && options.unitNoise) {
    address.unit = `Whg. ${address.unit}`;
  }
  if (address.postalCode.length > 3 && seed % 2 === 0) {
    address.postalCode = `${address.postalCode.slice(0, 2)} ${address.postalCode.slice(2)}`;
  }
  return {
    ...input,
    title: varyUmlauts(varyText(input.title, seed), seed),
    description: varyUmlauts(varyText(input.description, seed), seed + 1),
    address,
    media: [...input.media].reverse(),
  };
}
