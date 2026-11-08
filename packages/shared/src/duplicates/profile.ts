import { canonicalJson } from '../cursor';
import type { ListingContent } from '../content';
import type { OfferType } from '../schema/listing';
import { sha256Hex } from '../sha256';
import { groupOfType, type Taxonomy } from '../taxonomy';
import { profileRulesHash, type DuplicateConfig } from './config';
import { addressParts, normalizeParcelId, normalizePostalCode, normalizeUnit } from './normalize';
import { simhash } from './simhash';

// Merkmalsprofil (duplicate-detection design: "Normalisierung und Merkmalsprofil"): the
// normalized, comparison-ready form of a Listing_Inhalt. It depends on the content and the
// configuration alone — never on id, status, Custom_Id, agency, flags or provenance (Req 3.1) —
// and it holds no clear values of street, house number, unit, parcel, URLs or texts (Req 12.1).

/** Hash of a value for equality comparisons; the domain keeps the hash spaces apart. */
const hash = (domain: string, value: string): string =>
  sha256Hex(new TextEncoder().encode(`${domain}|${value}`));

/** Short hash for media URLs, of which a listing may have up to 50. */
const shortHash = (domain: string, value: string): string => hash(domain, value).slice(0, 16);

export interface ProfileOffer {
  type: OfferType;
  /** Purchase price or cold rent in minor units. */
  amountMinor: number;
  currency: string;
}

export interface MatchProfile {
  /** Hash of the profile-relevant configuration ({@link profileRulesHash}). */
  rules: string;
  country: string;
  postalCode: string;
  /** Taxonomy group of the Listing_Typ; `type:{code}` for a type outside the taxonomy. */
  group: string;
  listingType: string;
  /** One entry per offer type, sorted, so the comparison is order-independent. */
  offers: ProfileOffer[];
  areaMinor: number;
  rooms: number;
  /** Only set when street *and* house number are known. */
  addressHash?: string;
  unitHash?: string;
  parcelHash?: string;
  floor?: number;
  totalFloors?: number;
  yearBuilt?: number;
  plotAreaMinor?: number;
  bedrooms?: number;
  bathrooms?: number;
  geo?: { lat: number; lon: number };
  /** Only set when the source URL is not the derived Öffentliche_Detail_URL. */
  sourceUrlHash?: string;
  /** Sorted, duplicate-free short hashes of the media URLs. */
  mediaHashes: string[];
  titleSig: string;
  descriptionSig: string;
  /** Hash over every comparison part above; equal keys mean Exakt_Duplikate (Req 3.6). */
  exactKey: string;
}

export interface ProfileContext {
  taxonomy: Taxonomy;
  config: DuplicateConfig;
  /**
   * Öffentliche_Detail_URL of this listing. A `sourceUrl` equal to it is derived and therefore
   * no evidence of a shared source (Req 3.1).
   */
  derivedSourceUrl?: string | undefined;
}

/** Offers of a listing as profile offers, sorted by offer type. */
function profileOffers(content: ListingContent): ProfileOffer[] {
  return content.offers
    .map((offer): ProfileOffer =>
      offer.offerType === 'SALE'
        ? { type: 'SALE', amountMinor: offer.price, currency: offer.currency }
        : { type: 'RENT', amountMinor: offer.coldRent, currency: offer.currency },
    )
    .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
}

/** The parts that decide Exakt_Duplikate: the whole profile except `rules` and `exactKey`. */
function exactKeyOf(profile: Omit<MatchProfile, 'exactKey' | 'rules'>): string {
  return sha256Hex(new TextEncoder().encode(canonicalJson(profile) ?? ''));
}

/**
 * Merkmalsprofil of a Listing_Inhalt (internal representation). Pure: same content and
 * configuration always give the same profile.
 */
export function buildProfile(content: ListingContent, context: ProfileContext): MatchProfile {
  const { taxonomy, config } = context;
  const address = addressParts(content.address, config);
  const unit =
    content.address.unit === undefined ? '' : normalizeUnit(content.address.unit, config);
  const parcel = content.parcelId === undefined ? '' : normalizeParcelId(content.parcelId);
  const group = groupOfType(taxonomy, content.listingType) ?? `type:${content.listingType}`;
  const derived = context.derivedSourceUrl;

  const core: Omit<MatchProfile, 'exactKey' | 'rules'> = {
    country: content.address.country.toUpperCase(),
    postalCode: normalizePostalCode(content.address.postalCode),
    group,
    listingType: content.listingType,
    offers: profileOffers(content),
    areaMinor: content.area,
    rooms: content.rooms,
    ...(address.street !== '' &&
      address.houseNumber !== undefined && {
        addressHash: hash(
          'addr',
          `${content.address.country.toUpperCase()}|${normalizePostalCode(content.address.postalCode)}|${address.street}|${address.houseNumber}`,
        ),
      }),
    ...(unit !== '' && { unitHash: hash('unit', unit) }),
    ...(parcel !== '' && {
      parcelHash: hash('parcel', `${content.address.country.toUpperCase()}|${parcel}`),
    }),
    ...(content.floor !== undefined && { floor: content.floor }),
    ...(content.totalFloors !== undefined && { totalFloors: content.totalFloors }),
    ...(content.yearBuilt !== undefined && { yearBuilt: content.yearBuilt }),
    ...(content.plotArea !== undefined && { plotAreaMinor: content.plotArea }),
    ...(content.bedrooms !== undefined && { bedrooms: content.bedrooms }),
    ...(content.bathrooms !== undefined && { bathrooms: content.bathrooms }),
    ...(content.geo !== undefined && { geo: { lat: content.geo.lat, lon: content.geo.lon } }),
    ...(content.sourceUrl !== derived && { sourceUrlHash: hash('url', content.sourceUrl) }),
    mediaHashes: [...new Set(content.media.map((medium) => shortHash('media', medium.url)))].sort(),
    titleSig: simhash(content.title),
    descriptionSig: simhash(content.description),
  };

  return { rules: profileRulesHash(config), ...core, exactKey: exactKeyOf(core) };
}
