import type { Listing } from '@open-estate/shared';

// Flat search document (design: "Indexierungs-Strategie und Ordnung"). Every provider indexes the
// same fields, derived from the listing when it is written. Group and `hasTour` are deliberately
// not stored: both are resolved at query time against the currently loaded configuration.

export interface SearchDocument {
  id: string;
  /** `address.city` → NFC → locale-independent lowercase (Req 1.3). */
  cityNorm: string;
  postalCode: string;
  country: string;
  listingType: string;
  /** Purchase price in minor units; only set when the listing has a SALE offer. */
  saleAmountMinor?: number;
  saleCurrency?: string;
  /** Cold rent in minor units; only set when the listing has a RENT offer. */
  rentAmountMinor?: number;
  rentCurrency?: string;
  /** Rooms × 2 (rooms are multiples of 0.5), so range filters compare integers. */
  roomsHalf: number;
  /** Area in hundredths of m². */
  areaMinor: number;
  /** Distinct lowercase tour URL hostnames, sorted. */
  tourHosts: string[];
}

/**
 * Normalization for the case-insensitive exact city match (Req 1.3). Apply it to the indexed
 * city and to the query value alike.
 */
export function normalizeCity(city: string): string {
  return city.normalize('NFC').toLocaleLowerCase('und');
}

/** Lowercase hostname of `url`, or `undefined` if it is not a parseable URL. */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Derives the flat search document from an internal listing (pure). */
export function toSearchDocument(listing: Listing): SearchDocument {
  const doc: SearchDocument = {
    id: listing.id,
    cityNorm: normalizeCity(listing.address.city),
    postalCode: listing.address.postalCode,
    country: listing.address.country,
    listingType: listing.listingType,
    roomsHalf: Math.round(listing.rooms * 2),
    areaMinor: listing.area,
    tourHosts: [...new Set(listing.tours.flatMap((t) => hostOf(t.url) ?? []))].sort(),
  };
  // At most one offer per type (Req 12.14); SALE + RENT listings fill both field pairs.
  for (const offer of listing.offers) {
    if (offer.offerType === 'SALE') {
      doc.saleAmountMinor = offer.price;
      doc.saleCurrency = offer.currency;
    } else {
      doc.rentAmountMinor = offer.coldRent;
      doc.rentCurrency = offer.currency;
    }
  }
  return doc;
}
