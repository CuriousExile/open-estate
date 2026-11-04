// Framework-free logic of the detail view (design: ListingDetailComponent; Req 7.5, 12.13).
// Kept free of Angular imports so it can be unit-tested with plain Jest.
import type { LocalizedListing, OfferType } from '@open-estate/shared';
import { codeLabelKey } from '../locale/text-fallback';
import { formatMoney, formatNumber, type ListingOffer } from './listing-format';

/** Translation key of an offer amount label. */
export type OfferAmountKey =
  | 'detail.offer.price'
  | 'detail.offer.coldRent'
  | 'detail.offer.additionalCosts'
  | 'detail.offer.warmRent';

export interface OfferAmountView {
  readonly key: OfferAmountKey;
  /** Amount with the offer's currency, formatted for the active locale. */
  readonly value: string;
}

export interface OfferView {
  /** Label via `offerType.<code>`. */
  readonly offerType: OfferType;
  /** `SALE`: price. `RENT`: cold rent, then additional costs and warm rent only if stored (Req 12.13). */
  readonly amounts: readonly OfferAmountView[];
}

/** One offer of the detail view with all of its stored amounts (Req 12.13). */
export function toOfferView(offer: ListingOffer, locale: string): OfferView {
  const money = (key: OfferAmountKey, amount: string): OfferAmountView => ({
    key,
    value: formatMoney(amount, offer.currency, locale),
  });
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

/** All fields of a listing, formatted for the active locale (Req 7.5). */
export interface ListingDetail {
  readonly listing: LocalizedListing;
  readonly title: string;
  readonly description: string;
  /** Locale of title and description (Req 14.7); set as `lang` on them. */
  readonly contentLocale: string;
  readonly city: string;
  readonly postalCode: string;
  /** Listing type code; label via `taxonomy.type.<code>`. */
  readonly listingType: string;
  /** All offers in stored order — both for listings with `SALE` + `RENT` (Req 12.13). */
  readonly offers: readonly OfferView[];
  /** All remaining fields; rows of values that are not stored are omitted. */
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

export function toListingDetail(listing: LocalizedListing, locale: string): ListingDetail {
  const { address, geo, contact } = listing;
  const sourceHref = httpUrl(listing.sourceUrl);
  const sections = [
    section('facts', [
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
    ]),
    section('location', [
      address.street !== undefined && { key: 'detail.street', text: address.street },
      { key: 'detail.postalCode', text: address.postalCode },
      { key: 'detail.city', text: address.city },
      { key: 'detail.country', text: displayName(address.country, 'region', locale) },
      geo && {
        key: 'detail.coordinates',
        textKey: 'detail.coordinatesValue',
        params: { lat: formatNumber(geo.lat, locale, 6), lon: formatNumber(geo.lon, locale, 6) },
      },
    ]),
    // Only contact fields that survived the PII filter are delivered (Req 18.1).
    section('contact', [
      contact?.name !== undefined && { key: 'detail.contactName', text: contact.name },
      contact?.phone !== undefined && {
        key: 'detail.contactPhone',
        text: contact.phone,
        href: `tel:${contact.phone.replace(/[^\d+]/g, '')}`,
      },
      contact?.email !== undefined && {
        key: 'detail.contactEmail',
        text: contact.email,
        href: `mailto:${contact.email}`,
      },
    ]),
    section('about', [
      sourceHref === undefined
        ? { key: 'detail.sourceUrl', text: listing.sourceUrl }
        : {
            key: 'detail.sourceUrl',
            textKey: 'detail.sourceLink',
            href: sourceHref,
            external: true,
          },
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
  ].filter((s) => s.rows.length > 0);

  return {
    listing,
    title: listing.title,
    description: listing.description,
    contentLocale: listing.deliveredLocale,
    city: address.city,
    postalCode: address.postalCode,
    listingType: listing.listingType,
    offers: listing.offers.map((offer) => toOfferView(offer, locale)),
    sections,
    media: listing.media,
    tours: listing.tours,
  };
}
