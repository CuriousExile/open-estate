import { z } from 'zod';
import { isValidLocaleTag, MAX_LOCALE_LENGTH } from '../locale';
import {
  Area,
  AREA_MAX_MINOR,
  AREA_MIN_MINOR,
  formatDecimal,
  Money,
  MONEY_MAX_MINOR,
  MONEY_MIN_MINOR,
} from '../money';
import { err, ok, type Result } from '../result';
import {
  groupOfType,
  TAXONOMY_CODE_MAX_LENGTH,
  TAXONOMY_CODE_MIN_LENGTH,
  type Taxonomy,
} from '../taxonomy';
import { maxItems } from './non-aborting';

// Money/Area live in ../money (pure decimal logic); re-exported for importers of this module.
export { Area, Money } from '../money';

// Listing data model (Req 4, 12, 14.1, 14.2, 16.1, 16.2). Every schema accepts the API/raw
// representation (amounts and area as decimal strings) and outputs the internal representation
// (integer hundredths). Dynamic enums (listing type from the taxonomy, enabled locales) are added
// later by `buildSchemas` (Task 5.14) via `refineListing(ListingBase.extend(...))`.

/**
 * All value ranges of the listing model in one place (Req 4.7). Schemas, frontend validators,
 * OpenAPI and test generators derive their limits from these constants.
 */
export const LISTING_BOUNDS = {
  id: { min: 1, max: 128 },
  title: { min: 1, max: 300 },
  description: { min: 0, max: 5000 },
  locale: { min: 1, max: MAX_LOCALE_LENGTH },
  translations: { max: 20 },
  offers: { min: 1, max: 2 },
  /** Money in minor units (hundredths): 0.01–999,999,999.99 (Req 4.3, 12.2, 12.3). */
  money: { minMinor: MONEY_MIN_MINOR, maxMinor: MONEY_MAX_MINOR },
  /** Area in hundredths of m²: 1–100,000 m² (Req 4.5). */
  area: { minMinor: AREA_MIN_MINOR, maxMinor: AREA_MAX_MINOR },
  rooms: { min: 0, max: 99.5, step: 0.5 },
  listingType: { min: TAXONOMY_CODE_MIN_LENGTH, max: TAXONOMY_CODE_MAX_LENGTH },
  city: { min: 1, max: 200 },
  postalCode: { min: 1, max: 10 },
  street: { min: 1, max: 200 },
  lat: { min: -90, max: 90 },
  lon: { min: -180, max: 180 },
  url: { min: 1, max: 2048 },
  media: { max: 50 },
  tours: { max: 10 },
  providerCode: { min: 1, max: 64 },
  contactName: { min: 1, max: 200 },
  contactPhone: { min: 1, max: 50 },
  contactEmail: { min: 1, max: 254 },
  source: { min: 1, max: 128 },
  runId: { min: 1, max: 128 },
} as const;

const B = LISTING_BOUNDS;

const boundedString = (bounds: { readonly min: number; readonly max: number }) =>
  z.string().min(bounds.min).max(bounds.max);

// ---------------------------------------------------------------------------------------------
// PII markers (Req 18.1–18.3): the import pipeline finds PII fields generically via the schema.
// ---------------------------------------------------------------------------------------------

/** Registry of schemas whose values are personal data; not emitted into JSON Schema/OpenAPI. */
export const piiRegistry = z.registry<{ pii: true }>();

/** Marks `schema` as personal data (PII) and returns it unchanged. */
export function pii<T extends z.ZodType>(schema: T): T {
  piiRegistry.add(schema, { pii: true });
  return schema;
}

/**
 * Dot-separated paths of all PII-marked fields reachable in `schema`
 * (e.g. `["contact.name", "contact.phone", "contact.email"]`); array elements appear as `[]`.
 */
export function piiFieldPaths(schema: z.core.$ZodType): string[] {
  const paths: string[] = [];
  collectPiiPaths(schema, '', paths);
  return paths;
}

function collectPiiPaths(schema: z.core.$ZodType, path: string, out: string[]): void {
  if (piiRegistry.has(schema)) {
    out.push(path);
  } else if (schema instanceof z.ZodObject) {
    for (const [key, field] of Object.entries(schema.shape)) {
      collectPiiPaths(field, path === '' ? key : `${path}.${key}`, out);
    }
  } else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    collectPiiPaths(schema.unwrap(), path, out);
  } else if (schema instanceof z.ZodPipe) {
    collectPiiPaths(schema.in, path, out);
  } else if (schema instanceof z.ZodArray) {
    collectPiiPaths(schema.element, `${path}[]`, out);
  }
}

// ---------------------------------------------------------------------------------------------
// Primitive field schemas
// ---------------------------------------------------------------------------------------------

export const OFFER_TYPES = ['SALE', 'RENT'] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

/** ISO 4217 alpha-3 currency code. */
export const Currency = z.string().regex(/^[A-Z]{3}$/);

/** ISO 3166-1 alpha-2 country code. */
export const CountryCode = z.string().regex(/^[A-Z]{2}$/);

/** BCP-47 locale tag (≤ 35 characters, accepted by `Intl.getCanonicalLocales`). */
export const LocaleTag = boundedString(B.locale).refine(isValidLocaleTag, {
  message: 'Expected a valid BCP 47 locale tag',
});

/** ISO-8601 date-time with `Z` or a numeric offset. */
export const IsoDateTime = z.iso.datetime({ offset: true });

/** Absolute http(s) URL, ≤ 2,048 characters (Req 4.1). */
export const HttpUrl = z
  .url({ protocol: /^https?$/ })
  .min(B.url.min)
  .max(B.url.max);

/** Absolute https URL, ≤ 2,048 characters (Req 16.1, 16.2). */
export const HttpsUrl = z
  .url({ protocol: /^https$/ })
  .min(B.url.min)
  .max(B.url.max);

// ---------------------------------------------------------------------------------------------
// Offers (Req 12.1–12.5, 12.11, 12.14)
// ---------------------------------------------------------------------------------------------

/**
 * Purchase offer. `strictObject` rejects rent fields (`coldRent`, `additionalCosts`, `warmRent`)
 * and names each of them in the `unrecognized_keys` issue (Req 12.5). One `currency` per offer
 * applies to all of its amounts (Req 12.3).
 */
export const SaleOffer = z.strictObject({
  offerType: z.literal('SALE'),
  price: Money,
  currency: Currency,
});

/** Rent offer: cold rent as price, optional additional costs and warm rent ≥ cold rent (Req 12.3, 12.4). */
export const RentOffer = z
  .strictObject({
    offerType: z.literal('RENT'),
    coldRent: Money,
    currency: Currency,
    additionalCosts: Money.optional(),
    warmRent: Money.optional(),
  })
  .refine((o) => o.warmRent === undefined || o.warmRent >= o.coldRent, {
    path: ['warmRent'],
    message: 'warmRent must be greater than or equal to coldRent',
  });

export const Offer = z.discriminatedUnion('offerType', [SaleOffer, RentOffer]);

function uniqueOfferTypes(offers: readonly { offerType: OfferType }[], ctx: z.RefinementCtx): void {
  // More than the allowed offers is already reported once on `offers` (count check).
  if (offers.length > B.offers.max) return;
  const seen = new Set<OfferType>();
  for (const offer of offers) {
    if (seen.has(offer.offerType)) {
      ctx.addIssue({
        code: 'custom',
        message: `Duplicate offer type ${offer.offerType}; at most one offer per type is allowed`,
      });
    }
    seen.add(offer.offerType);
  }
}

/** 1–2 offers, at most one per offer type: SALE only, RENT only, or SALE + RENT (Req 12.1, 12.14). */
export const Offers = maxItems(z.array(Offer).min(B.offers.min), B.offers.max).superRefine(
  uniqueOfferTypes,
);

// ---------------------------------------------------------------------------------------------
// Listing parts
// ---------------------------------------------------------------------------------------------

/** Number of rooms 0–99.5 in steps of 0.5 (Req 4.4); stored as a plain decimal number. */
export const Rooms = z.number().min(B.rooms.min).max(B.rooms.max).multipleOf(B.rooms.step);

export const Address = z.object({
  city: boundedString(B.city),
  postalCode: boundedString(B.postalCode),
  country: CountryCode,
  street: boundedString(B.street).optional(),
});

/** Decimal places kept for coordinates: 1e-6° ≈ 0.1 m. */
export const COORDINATE_DECIMALS = 6;
const COORDINATE_SCALE = 10 ** COORDINATE_DECIMALS;

/**
 * Rounds to {@link COORDINATE_DECIMALS} decimal places and maps -0 to 0. Besides fixing the
 * precision, this keeps every stored coordinate either 0 or ≥ 1e-6 in magnitude: DynamoDB rejects
 * numbers with magnitude < 1e-130 ("Number underflow", e.g. 5e-324), and -0 does not survive
 * JSON. Idempotent, so parsing an already parsed listing leaves it unchanged.
 */
export function normalizeCoordinate(value: number): number {
  return Math.round(value * COORDINATE_SCALE) / COORDINATE_SCALE || 0;
}

/**
 * Coordinate that is required once the other one of the pair is given: a half pair
 * (`lat` xor `lon`) yields an issue on exactly the missing field (Req 4.6, 4.10). Valid values
 * are normalized with {@link normalizeCoordinate} (`overwrite` keeps input and output type
 * `number`, so JSON Schema/OpenAPI are unaffected); the range check applies to the raw value.
 */
function coordinate(name: string, other: string, bounds: { min: number; max: number }) {
  return z
    .number({
      error: (issue) =>
        issue.input === undefined ? `${name} is required together with ${other}` : undefined,
    })
    .min(bounds.min)
    .max(bounds.max)
    .overwrite(normalizeCoordinate);
}

/**
 * Optional geo position; latitude and longitude only together (Req 4.6), each rounded to 6
 * decimal places with -0 → 0 ({@link normalizeCoordinate}).
 */
export const Geo = z.object({
  lat: coordinate('lat', 'lon', B.lat),
  lon: coordinate('lon', 'lat', B.lon),
});

export const Translation = z.object({
  locale: LocaleTag,
  title: boundedString(B.title),
  description: boundedString(B.description),
});

export const Media = z.object({ url: HttpsUrl });

/** 3D tour; `providerCode` is derived from the URL host by the import pipeline (Req 16.2). */
export const Tour = z.object({ url: HttpsUrl, providerCode: boundedString(B.providerCode) });

/** Contact data; every field is PII and removed on import unless allow-listed (Req 18.1). */
export const Contact = z
  .object({
    name: pii(boundedString(B.contactName)),
    phone: pii(boundedString(B.contactPhone)),
    email: pii(boundedString(B.contactEmail)),
  })
  .partial();

// ---------------------------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------------------------

/**
 * Listing fields without object-level refinements, so it can be extended (`buildSchemas`, 5.14)
 * or reduced (`LocalizedListing`). Validate listings with {@link Listing}, not with this schema.
 */
export const ListingBase = z.object({
  id: boundedString(B.id),
  originalLocale: LocaleTag,
  /** Title and description in the original locale (Req 14.1). */
  title: boundedString(B.title),
  description: boundedString(B.description),
  /** 0–20 further language versions (Req 14.2). */
  translations: maxItems(z.array(Translation), B.translations.max),
  offers: Offers,
  /** Listing type code; becomes a dynamic enum from the taxonomy in `buildSchemas` (5.14). */
  listingType: boundedString(B.listingType),
  rooms: Rooms,
  area: Area,
  address: Address,
  geo: Geo.optional(),
  sourceUrl: HttpUrl,
  /** Up to 50 media in delivery order (Req 16.1). */
  media: maxItems(z.array(Media), B.media.max),
  /** Up to 10 tours (Req 16.2). */
  tours: maxItems(z.array(Tour), B.tours.max),
  contact: Contact.optional(),
  // Provenance, set by the import pipeline (Req 4.12, 11.5).
  source: boundedString(B.source),
  lastImportedAt: IsoDateTime,
  lastRunId: boundedString(B.runId),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Every locale occurs at most once per listing, original locale included (case-insensitive,
 * Req 14.2). Runs even after field issues (Req 4.9: report all violations at once; field schemas
 * must not abort, see ./non-aborting), so `listing`
 * may be any input: only locales that are strings and passed their own field check are compared;
 * invalid ones are already reported on their own path.
 */
function uniqueLocalesInclOriginal(listing: unknown, ctx: z.core.$RefinementCtx<unknown>): void {
  if (!isRecord(listing)) return;
  const failed = new Set(ctx.issues.map((issue) => (issue.path ?? []).join('.')));
  const checkable = (value: unknown, path: string): value is string =>
    typeof value === 'string' && !failed.has(path);

  const seen = new Set<string>();
  if (checkable(listing['originalLocale'], 'originalLocale')) {
    seen.add(listing['originalLocale'].toLowerCase());
  }
  const translations = listing['translations'];
  if (!Array.isArray(translations)) return;
  translations.forEach((translation: unknown, index) => {
    const locale = isRecord(translation) ? translation['locale'] : undefined;
    if (!checkable(locale, `translations.${index}.locale`)) return;
    const key = locale.toLowerCase();
    if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['translations', index, 'locale'],
        message: `Locale ${locale} occurs more than once (original locale included)`,
      });
    }
    seen.add(key);
  });
}

/** Adds the listing's cross-field rules to `ListingBase` or an extension of it. */
export function refineListing<
  T extends z.ZodType<{ originalLocale: string; translations: readonly { locale: string }[] }>,
>(schema: T): T {
  // `when`: run even after field issues (default would skip object refinements then).
  return schema.superRefine(uniqueLocalesInclOriginal, { when: () => true });
}

/** Full listing schema: input = API/raw representation, output = internal (minor units). */
export const Listing = refineListing(ListingBase);

/** Internal representation (amounts and area in minor units). */
export type Listing = z.output<typeof Listing>;
/** API/raw representation (amounts and area as decimal strings). */
export type ListingInput = z.input<typeof Listing>;
export type SaleOffer = z.output<typeof SaleOffer>;
export type RentOffer = z.output<typeof RentOffer>;
export type Offer = z.output<typeof Offer>;

// ---------------------------------------------------------------------------------------------
// API representation (Req 2.1, 3.3, 3.8, 14.7)
// ---------------------------------------------------------------------------------------------

/**
 * Listing as delivered by Search_API and MCP_Server: title/description of the selected language
 * version, `deliveredLocale` and `originalLocale`, no `translations`, amounts and area as decimal
 * strings, `group` derived from the taxonomy (omitted if the type is not in the taxonomy).
 */
export const LocalizedListing = ListingBase.omit({ translations: true }).extend({
  deliveredLocale: LocaleTag,
  group: boundedString(B.listingType).optional(),
});

/** API representation (decimal strings) — what `serialize` returns. */
export type LocalizedListing = z.input<typeof LocalizedListing>;
/** Parsed API representation (minor units) — what `parse` returns. */
export type ParsedLocalizedListing = z.output<typeof LocalizedListing>;

/** Selected language version of a listing (result of the locale selection, Task 5.12). */
export interface LocalizedVersion {
  title: string;
  description: string;
  deliveredLocale: string;
}

export interface SerializeOptions {
  taxonomy: Taxonomy;
  version: LocalizedVersion;
}

function serializeOffer(offer: Offer): z.input<typeof Offer> {
  if (offer.offerType === 'SALE') {
    return { offerType: 'SALE', price: formatDecimal(offer.price), currency: offer.currency };
  }
  return {
    offerType: 'RENT',
    coldRent: formatDecimal(offer.coldRent),
    currency: offer.currency,
    ...(offer.additionalCosts !== undefined && {
      additionalCosts: formatDecimal(offer.additionalCosts),
    }),
    ...(offer.warmRent !== undefined && { warmRent: formatDecimal(offer.warmRent) }),
  };
}

/** Internal listing → API representation for the given language version. */
export function serialize(
  listing: Listing,
  { taxonomy, version }: SerializeOptions,
): LocalizedListing {
  const group = groupOfType(taxonomy, listing.listingType);
  return {
    id: listing.id,
    title: version.title,
    description: version.description,
    deliveredLocale: version.deliveredLocale,
    originalLocale: listing.originalLocale,
    offers: listing.offers.map(serializeOffer),
    listingType: listing.listingType,
    ...(group !== undefined && { group }),
    rooms: listing.rooms,
    area: formatDecimal(listing.area),
    address: { ...listing.address },
    ...(listing.geo !== undefined && { geo: { ...listing.geo } }),
    sourceUrl: listing.sourceUrl,
    media: listing.media.map((m) => ({ ...m })),
    tours: listing.tours.map((t) => ({ ...t })),
    ...(listing.contact !== undefined && { contact: { ...listing.contact } }),
    source: listing.source,
    lastImportedAt: listing.lastImportedAt,
    lastRunId: listing.lastRunId,
  };
}

/** API representation → internal representation (minor units); returns all schema issues on failure. */
export function parse(raw: unknown): Result<ParsedLocalizedListing, z.core.$ZodIssue[]> {
  const result = LocalizedListing.safeParse(raw);
  return result.success ? ok(result.data) : err(result.error.issues);
}
