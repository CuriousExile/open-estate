// Framework-free logic of the detail view (design: ListingDetailComponent; Req 7.5, 12.13).
// Kept free of Angular imports so it can be unit-tested with plain Jest.
import type { LocalizedListing, OfferType } from '@open-estate/shared';
import { codeLabelKey } from '../locale/text-fallback';
import {
  formatNumber,
  formatPrice,
  type DisplayCurrency,
  type ListingOffer,
} from './listing-format';

/** Translation key of an offer amount label. */
export type OfferAmountKey =
  | 'detail.offer.price'
  | 'detail.offer.coldRent'
  | 'detail.offer.additionalCosts'
  | 'detail.offer.warmRent';

export interface OfferAmountView {
  readonly key: OfferAmountKey;
  /** Amount in the display currency (or the offer's own), formatted for the active locale. */
  readonly value: string;
  /** Original amount if `value` is converted into the display currency (approximate). */
  readonly original?: string;
}

export interface OfferView {
  /** Label via `offerType.<code>`. */
  readonly offerType: OfferType;
  /** `SALE`: price. `RENT`: cold rent, then additional costs and warm rent only if stored (Req 12.13). */
  readonly amounts: readonly OfferAmountView[];
}

/** One offer of the detail view with all of its stored amounts (Req 12.13). */
export function toOfferView(
  offer: ListingOffer,
  locale: string,
  display?: DisplayCurrency,
): OfferView {
  const money = (key: OfferAmountKey, amount: string): OfferAmountView => {
    const price = formatPrice(amount, offer.currency, locale, display);
    return {
      key,
      value: price.value,
      ...(price.original !== undefined && { original: price.original }),
    };
  };
  if (offer.offerType === 'SALE') {
    return { offerType: 'SALE', amounts: [money('detail.offer.price', offer.price)] };
  }
  return {
    offerType: 'RENT',
    amounts: [
      money('detail.offer.coldRent', offer.coldRent),
      ...(offer.additionalCosts !== undefined
        ? [money('detail.offer.additionalCosts', offer.additionalCosts)]
        : []),
      ...(offer.warmRent !== undefined ? [money('detail.offer.warmRent', offer.warmRent)] : []),
    ],
  };
}

/** Display name of a language or region code for `locale`; the code itself if `Intl` has none. */
export function displayName(code: string, type: 'language' | 'region', locale: string): string {
  try {
    return new Intl.DisplayNames(locale || undefined, { type, fallback: 'code' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Date and time for `locale`; the value as delivered if it is not a valid date. */
export function formatDateTime(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return iso;
  }
}

/** `url` if it is an absolute http(s) URL (safe as link target), else `undefined`. */
export function httpUrl(url: string): string | undefined {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One label/value pair of the detail view. The label is the translation key `key`; the value is
 * either listing data (`text`, shown as delivered) or a translated text (`textKey` + `params`).
 * With `href` the value is a link; `external` links open in a new tab.
 */
export interface DetailRow {
  readonly key: string;
  readonly text?: string;
  readonly textKey?: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly href?: string;
  readonly external?: boolean;
}

export interface DetailSection {
  /** Element id of the heading, for `aria-labelledby`. */
  readonly id: string;
  /** Translation key of the heading. */
  readonly key: string;
  readonly rows: readonly DetailRow[];
}

/** Translation key of a call to action in the detail view's summary. */
export type DetailActionKey =
  'detail.action.original' | 'detail.action.email' | 'detail.action.phone';

/**
 * A link of the summary next to the images: the original listing (the primary action) and the
 * contact's email and phone, each only if stored and safe as link target.
 */
export interface DetailAction {
  readonly key: DetailActionKey;
  readonly href: string;
  /** Opens in a new tab (the provider's page). */
  readonly external: boolean;
}

/** All fields of a listing, formatted for the active locale (Req 7.5). */
export interface ListingDetail {
  readonly listing: LocalizedListing;
  readonly title: string;
  readonly description: string;
  /** Locale of title and description (Req 14.7); set as `lang` on them. */
  readonly contentLocale: string;
  readonly city: string;
  readonly postalCode: string;
  /** One line for the summary: street (if stored), postal code and city. */
  readonly address: string;
  /** Listing type code; label via `taxonomy.type.<code>`. */
  readonly listingType: string;
  /** All offers in stored order — both for listings with `SALE` + `RENT` (Req 12.13). */
  readonly offers: readonly OfferView[];
  /** Key facts shown in the summary next to the images: type, group, rooms, area. */
  readonly facts: readonly DetailRow[];
  /** Links of the summary; the original listing first. */
  readonly actions: readonly DetailAction[];
  /** All remaining fields below the summary; rows of values that are not stored are omitted. */
  readonly sections: readonly DetailSection[];
  readonly media: LocalizedListing['media'];
  /** Embedded by TourEmbedComponent if their host is allowed (Req 16.6, 16.7). */
  readonly tours: LocalizedListing['tours'];
}

const section = (name: string, rows: (DetailRow | false | undefined)[]): DetailSection => ({
  id: `detail-${name}`,
  key: `detail.${name}`,
  rows: rows.filter((row): row is DetailRow => row !== false && row !== undefined),
});

/**
 * Rows of technical or provenance data that the public detail view hides unless they are
 * explicitly made visible: coordinates, languages, listing ID, source, import time and run.
 * Visitors need none of them; which rows an agency may switch on is still open (known issues).
 */
export const DETAIL_ROWS_HIDDEN_BY_DEFAULT: ReadonlySet<string> = new Set([
  'detail.coordinates',
  'detail.language',
  'detail.originalLanguage',
  'detail.id',
  'detail.source',
  'detail.importedAt',
  'detail.runId',
]);

/** `tel:` link of a phone number (digits and a leading `+` only). */
function phoneLink(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

/** Options of {@link toListingDetail}. */
export interface ListingDetailOptions {
  /** Row keys of {@link DETAIL_ROWS_HIDDEN_BY_DEFAULT} to show anyway. */
  readonly showRows?: ReadonlySet<string>;
  /** Display currency of the header; amounts in their own currency if omitted. */
  readonly display?: DisplayCurrency;
}

export function toListingDetail(
  listing: LocalizedListing,
  locale: string,
  { showRows = new Set(), display }: ListingDetailOptions = {},
): ListingDetail {
  const shown = (row: DetailRow | false | undefined): DetailRow | undefined =>
    row && (!DETAIL_ROWS_HIDDEN_BY_DEFAULT.has(row.key) || showRows.has(row.key)) ? row : undefined;
  const { address, geo, contact } = listing;
  const sourceHref = httpUrl(listing.sourceUrl);
  const facts = section('facts', [
    { key: 'detail.type', textKey: codeLabelKey('taxonomy.type', listing.listingType) },
    listing.group !== undefined && {
      key: 'detail.group',
      textKey: codeLabelKey('taxonomy.group', listing.group),
    },
    { key: 'detail.rooms', text: formatNumber(listing.rooms, locale) },
    {
      key: 'detail.area',
      textKey: 'detail.areaValue',
      params: { value: formatNumber(listing.area, locale) },
    },
  ]).rows;
  const action = (key: DetailActionKey, href: string, external = false): DetailAction => ({
    key,
    href,
    external,
  });
  const actions: DetailAction[] = [
    ...(sourceHref !== undefined ? [action('detail.action.original', sourceHref, true)] : []),
    ...(contact?.email !== undefined
      ? [action('detail.action.email', `mailto:${contact.email}`)]
      : []),
    ...(contact?.phone !== undefined
      ? [action('detail.action.phone', phoneLink(contact.phone))]
      : []),
  ];
  const sections = [
    section('location', [
      address.street !== undefined && { key: 'detail.street', text: address.street },
      address.unit !== undefined && { key: 'listing.attributes.unit', text: address.unit },
      { key: 'detail.postalCode', text: address.postalCode },
      { key: 'detail.city', text: address.city },
      { key: 'detail.country', text: displayName(address.country, 'region', locale) },
      geo && {
        key: 'detail.coordinates',
        textKey: 'detail.coordinatesValue',
        params: { lat: formatNumber(geo.lat, locale, 6), lon: formatNumber(geo.lon, locale, 6) },
      },
    ]),
    // Objektmerkmale that are stored (duplicate-detection Req 1.7).
    section('property', [
      listing.floor !== undefined && {
        key: 'listing.attributes.floor',
        text: formatNumber(listing.floor, locale, 0),
      },
      listing.totalFloors !== undefined && {
        key: 'listing.attributes.totalFloors',
        text: formatNumber(listing.totalFloors, locale, 0),
      },
      // A year, not an amount: no grouping separator.
      listing.yearBuilt !== undefined && {
        key: 'listing.attributes.yearBuilt',
        text: String(listing.yearBuilt),
      },
      listing.plotArea !== undefined && {
        key: 'listing.attributes.plotArea',
        textKey: 'detail.areaValue',
        params: { value: formatNumber(listing.plotArea, locale) },
      },
      listing.bedrooms !== undefined && {
        key: 'listing.attributes.bedrooms',
        text: formatNumber(listing.bedrooms, locale, 0),
      },
      listing.bathrooms !== undefined && {
        key: 'listing.attributes.bathrooms',
        text: formatNumber(listing.bathrooms, locale, 0),
      },
      listing.parcelId !== undefined && {
        key: 'listing.attributes.parcelId',
        text: listing.parcelId,
      },
    ]),
    // Only contact fields that survived the PII filter are delivered (Req 18.1).
    section('contact', [
      contact?.name !== undefined && { key: 'detail.contactName', text: contact.name },
      contact?.phone !== undefined && {
        key: 'detail.contactPhone',
        text: contact.phone,
        href: phoneLink(contact.phone),
      },
      contact?.email !== undefined && {
        key: 'detail.contactEmail',
        text: contact.email,
        href: `mailto:${contact.email}`,
      },
    ]),
    // A linkable source URL is the summary's primary action; only a non-link stays as text.
    section('about', [
      sourceHref === undefined && { key: 'detail.sourceUrl', text: listing.sourceUrl },
      {
        key: 'detail.language',
        text: displayName(listing.deliveredLocale, 'language', locale),
      },
      {
        key: 'detail.originalLanguage',
        text: displayName(listing.originalLocale, 'language', locale),
      },
      { key: 'detail.id', text: listing.id },
      { key: 'detail.source', text: listing.source },
      { key: 'detail.importedAt', text: formatDateTime(listing.lastImportedAt, locale) },
      { key: 'detail.runId', text: listing.lastRunId },
    ]),
  ]
    .map((s) => ({ ...s, rows: s.rows.flatMap((row) => shown(row) ?? []) }))
    .filter((s) => s.rows.length > 0);

  return {
    listing,
    title: listing.title,
    description: listing.description,
    contentLocale: listing.deliveredLocale,
    city: address.city,
    postalCode: address.postalCode,
    address: [address.street, `${address.postalCode} ${address.city}`.trim()]
      .filter((part) => part !== undefined && part !== '')
      .join(', '),
    listingType: listing.listingType,
    offers: listing.offers.map((offer) => toOfferView(offer, locale, display)),
    facts,
    actions,
    sections,
    media: listing.media,
    tours: listing.tours,
  };
}
