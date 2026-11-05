import fc from 'fast-check';
// Package import (not '../../src'), so packages/loadtest can compile these arbitraries against the
// built package; jest maps it to the sources.
import {
  assertValidTaxonomy,
  COORDINATE_DECIMALS,
  DEFAULT_TAXONOMY_CONFIG,
  LISTING_BOUNDS as B,
  typeCodes,
  type Listing,
  type LocalizedVersion,
  type Offer,
  type OfferType,
  type RentOffer,
  type SaleOffer,
} from '@open-estate/shared';

// Generators for valid internal listings (minor units), derived from LISTING_BOUNDS.

type Bounds = { readonly min: number; readonly max: number };

const COORDINATE_SCALE = 10 ** COORDINATE_DECIMALS;

const boundedString = (bounds: Bounds): fc.Arbitrary<string> =>
  fc.string({ minLength: bounds.min, maxLength: bounds.max });

/** Valid BCP-47 tags, pairwise distinct case-insensitively; > translations.max + 1 entries. */
export const LOCALE_POOL = [
  'de',
  'de-AT',
  'de-CH',
  'en',
  'en-GB',
  'en-US',
  'fr',
  'fr-CA',
  'it',
  'es',
  'es-MX',
  'pt',
  'pt-BR',
  'nl',
  'pl',
  'cs',
  'da',
  'sv',
  'fi',
  'tr',
  'el',
  'ja',
  'zh-Hant-TW',
  'sr-Latn',
  'uk',
] as const;

export const arbLocaleTag: fc.Arbitrary<string> = fc.constantFrom(...LOCALE_POOL);

export const arbCurrency: fc.Arbitrary<string> = fc.stringMatching(/^[A-Z]{3}$/);

/** Money in minor units within LISTING_BOUNDS.money. */
export const arbMoneyMinor: fc.Arbitrary<number> = fc.integer({
  min: B.money.minMinor,
  max: B.money.maxMinor,
});

export const arbSaleOffer: fc.Arbitrary<SaleOffer> = fc.record({
  offerType: fc.constant('SALE' as const),
  price: arbMoneyMinor,
  currency: arbCurrency,
});

/** Rent offer with optional additional costs and optional warm rent ≥ cold rent. */
export const arbRentOffer: fc.Arbitrary<RentOffer> = arbMoneyMinor.chain((coldRent) =>
  fc.record(
    {
      offerType: fc.constant('RENT' as const),
      coldRent: fc.constant(coldRent),
      currency: arbCurrency,
      additionalCosts: arbMoneyMinor,
      warmRent: fc.integer({ min: coldRent, max: B.money.maxMinor }),
    },
    { requiredKeys: ['offerType', 'coldRent', 'currency'] },
  ),
);

/** Valid offer-type combinations: SALE only, RENT only, SALE + RENT (both orders). */
export const OFFER_TYPE_COMBINATIONS: readonly (readonly OfferType[])[] = [
  ['SALE'],
  ['RENT'],
  ['SALE', 'RENT'],
  ['RENT', 'SALE'],
];

export function arbOffers(
  combinations: readonly (readonly OfferType[])[] = OFFER_TYPE_COMBINATIONS,
): fc.Arbitrary<Offer[]> {
  return fc
    .constantFrom(...combinations)
    .chain((types) =>
      fc.tuple(
        ...types.map((t): fc.Arbitrary<Offer> => (t === 'SALE' ? arbSaleOffer : arbRentOffer)),
      ),
    );
}

const arbUrlPath = fc
  .array(fc.stringMatching(/^[a-z0-9-]{1,20}$/), { maxLength: 4 })
  .map((segments) => segments.join('/'));

export function arbUrl(schemes: readonly ('http' | 'https')[] = ['https']): fc.Arbitrary<string> {
  return fc
    .tuple(fc.constantFrom(...schemes), fc.domain(), arbUrlPath)
    .map(([scheme, host, path]) => `${scheme}://${host}/${path}`);
}

/**
 * Coordinate as the schema outputs it (`normalizeCoordinate`): 6 decimal places, no -0, so
 * generated listings are fixed points of parsing.
 */
const arbCoordinate = (bounds: Bounds): fc.Arbitrary<number> =>
  fc
    .integer({ min: bounds.min * COORDINATE_SCALE, max: bounds.max * COORDINATE_SCALE })
    .map((n) => n / COORDINATE_SCALE || 0);

export const arbIsoDateTime: fc.Arbitrary<string> = fc
  .date({
    min: new Date('2000-01-01T00:00:00.000Z'),
    max: new Date('2100-01-01T00:00:00.000Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());

const DEFAULT_TYPES = typeCodes(assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG));

export interface ListingArbOptions {
  /** Allowed offer-type combinations (default: all valid ones). */
  offerTypes?: readonly (readonly OfferType[])[];
  /** Listing type codes to choose from (default: types of the default taxonomy). */
  listingTypes?: readonly string[];
}

/** Valid internal listings; optional fields (geo, street, contact, rent extras) vary. */
export function arbListing(options: ListingArbOptions = {}): fc.Arbitrary<Listing> {
  const arbTranslations = fc
    .shuffledSubarray([...LOCALE_POOL], { minLength: 1, maxLength: B.translations.max + 1 })
    .chain(([originalLocale = 'de', ...others]) =>
      fc.tuple(
        fc.constant(originalLocale),
        fc.tuple(
          ...others.map((locale) =>
            fc.record({
              locale: fc.constant(locale),
              title: boundedString(B.title),
              description: boundedString(B.description),
            }),
          ),
        ),
      ),
    );

  return fc
    .record(
      {
        id: boundedString(B.id),
        locales: arbTranslations,
        title: boundedString(B.title),
        description: boundedString(B.description),
        offers: arbOffers(options.offerTypes),
        listingType: fc.constantFrom(...(options.listingTypes ?? DEFAULT_TYPES)),
        rooms: fc.integer({ min: 0, max: B.rooms.max / B.rooms.step }).map((n) => n * B.rooms.step),
        area: fc.integer({ min: B.area.minMinor, max: B.area.maxMinor }),
        address: fc.record(
          {
            city: boundedString(B.city),
            postalCode: boundedString(B.postalCode),
            country: fc.stringMatching(/^[A-Z]{2}$/),
            street: boundedString(B.street),
          },
          { requiredKeys: ['city', 'postalCode', 'country'] },
        ),
        geo: fc.record({ lat: arbCoordinate(B.lat), lon: arbCoordinate(B.lon) }),
        sourceUrl: arbUrl(['http', 'https']),
        media: fc.array(fc.record({ url: arbUrl() }), { maxLength: B.media.max }),
        tours: fc.array(fc.record({ url: arbUrl(), providerCode: boundedString(B.providerCode) }), {
          maxLength: B.tours.max,
        }),
        contact: fc.record(
          {
            name: boundedString(B.contactName),
            phone: boundedString(B.contactPhone),
            email: boundedString(B.contactEmail),
          },
          { requiredKeys: [] },
        ),
        source: boundedString(B.source),
        lastImportedAt: arbIsoDateTime,
        lastRunId: boundedString(B.runId),
      },
      {
        requiredKeys: [
          'id',
          'locales',
          'title',
          'description',
          'offers',
          'listingType',
          'rooms',
          'area',
          'address',
          'sourceUrl',
          'media',
          'tours',
          'source',
          'lastImportedAt',
          'lastRunId',
        ],
      },
    )
    .map(({ locales: [originalLocale, translations], ...rest }) => ({
      ...rest,
      originalLocale,
      translations,
    }));
}

/** One of the listing's language versions (original or a translation). */
export function arbLocalizedVersion(listing: Listing): fc.Arbitrary<LocalizedVersion> {
  return fc.constantFrom(
    {
      title: listing.title,
      description: listing.description,
      deliveredLocale: listing.originalLocale,
    },
    ...listing.translations.map((t) => ({
      title: t.title,
      description: t.description,
      deliveredLocale: t.locale,
    })),
  );
}

/** Fixed valid internal listing (SALE only, no optional fields) for example-based tests. */
export function exampleListing(id: string, overrides: Partial<Listing> = {}): Listing {
  return {
    id,
    originalLocale: 'de',
    title: `Listing ${id}`,
    description: '',
    translations: [],
    offers: [{ offerType: 'SALE', price: 100_000_00, currency: 'EUR' }],
    listingType: 'apartment_unit',
    rooms: 3,
    area: 75_00,
    address: { city: 'Berlin', postalCode: '10115', country: 'DE' },
    sourceUrl: `https://partner.example/listings/${encodeURIComponent(id)}`,
    media: [],
    tours: [],
    source: 'example',
    lastImportedAt: '2025-01-01T00:00:00.000Z',
    lastRunId: 'run-1',
    ...overrides,
  };
}
