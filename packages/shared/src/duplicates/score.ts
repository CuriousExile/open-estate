import { ANCHOR_RADIUS_METERS, type DuplicateConfig } from './config';
import type { MatchProfile } from './profile';
import { sortReasons, type MatchExclusion, type MatchReason } from './reasons';
import { hamming } from './simhash';

// Duplikat_Bewertung (duplicate-detection Req 3.3–3.7): pure, symmetric and deterministic.
//
// Order of the decision:
//   1. Ausschlusskriterien  — contradicting facts make two listings different properties.
//   2. Exakt_Duplikat       — equal Merkmalsprofile score 1.
//   3. Ortsanker            — without one, similar values are not enough (two flats of the same
//                             size in the same city are not a duplicate).
//   4. Weighted sum of all signals, clamped to [0, 1], compared with the threshold.

export interface MatchResult {
  /** `true` iff no exclusion applies, an anchor exists and `score ≥ threshold` (Req 3.5). */
  duplicate: boolean;
  /** Übereinstimmungswert in [0, 1]. */
  score: number;
  /** Contributing signals in catalog order (Req 3.10). */
  reasons: MatchReason[];
  /** Set when an exclusion or the missing Ortsanker decided the result (never published). */
  excludedBy?: MatchExclusion;
}

/** Both values present and different. */
const conflicts = <T>(a: T | undefined, b: T | undefined): boolean =>
  a !== undefined && b !== undefined && a !== b;

/** Relative difference of two positive values in percent; `undefined` if one is missing. */
function differencePercent(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined || b === undefined) return undefined;
  const larger = Math.max(Math.abs(a), Math.abs(b));
  if (larger === 0) return 0;
  return (Math.abs(a - b) / larger) * 100;
}

const EARTH_RADIUS_METERS = 6_371_008.8;
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance of two coordinates in metres (haversine). */
export function distanceMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const latA = toRadians(a.lat);
  const latB = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Offer types both listings offer. */
const sharedOfferTypes = (a: MatchProfile, b: MatchProfile): string[] =>
  a.offers.map((offer) => offer.type).filter((type) => b.offers.some((o) => o.type === type));

/** Objektmerkmale compared value by value once both listings carry them. */
function attributeAgreement(
  a: MatchProfile,
  b: MatchProfile,
  config: DuplicateConfig,
): { equal: number; differs: boolean } {
  const scalars: [number | undefined, number | undefined][] = [
    [a.totalFloors, b.totalFloors],
    [a.yearBuilt, b.yearBuilt],
    [a.bedrooms, b.bedrooms],
    [a.bathrooms, b.bathrooms],
  ];
  let equal = 0;
  let differs = false;
  for (const [left, right] of scalars) {
    if (left === undefined || right === undefined) continue;
    if (left === right) equal += 1;
    else differs = true;
  }
  const plotDifference = differencePercent(a.plotAreaMinor, b.plotAreaMinor);
  if (plotDifference !== undefined) {
    if (plotDifference <= config.tolerances.plotAreaClosePercent) equal += 1;
    else if (plotDifference > config.tolerances.plotAreaDiffersPercent) differs = true;
  }
  return { equal, differs };
}

/** Lowest price difference over the offer types both listings share, in percent. */
function priceDifference(a: MatchProfile, b: MatchProfile): number | undefined {
  const differences = a.offers.flatMap((offer) => {
    const other = b.offers.find((o) => o.type === offer.type && o.currency === offer.currency);
    const difference =
      other === undefined ? undefined : differencePercent(offer.amountMinor, other.amountMinor);
    return difference === undefined ? [] : [difference];
  });
  return differences.length === 0 ? undefined : Math.min(...differences);
}

/** First exclusion criterion that applies (Req 3.3). */
function exclusion(a: MatchProfile, b: MatchProfile): MatchExclusion | undefined {
  if (a.country !== b.country) return 'COUNTRY';
  if (a.group !== b.group) return 'GROUP';
  if (sharedOfferTypes(a, b).length === 0) return 'OFFER_TYPE';
  if (conflicts(a.addressHash, b.addressHash)) return 'ADDRESS';
  if (conflicts(a.unitHash, b.unitHash)) return 'UNIT';
  if (conflicts(a.floor, b.floor)) return 'FLOOR';
  if (conflicts(a.parcelHash, b.parcelHash)) return 'PARCEL';
  return undefined;
}

/** Shared media URLs. */
const sharedMedia = (a: MatchProfile, b: MatchProfile): number => {
  const other = new Set(b.mediaHashes);
  return a.mediaHashes.filter((media) => other.has(media)).length;
};

/**
 * Übereinstimmungswert and Übereinstimmungsgründe of two Merkmalsprofile. Symmetric: every
 * signal is symmetric, and the reasons are reported in catalog order.
 */
export function scoreMatch(a: MatchProfile, b: MatchProfile, config: DuplicateConfig): MatchResult {
  const excluded = exclusion(a, b);
  if (excluded !== undefined)
    return { duplicate: false, score: 0, reasons: [], excludedBy: excluded };

  if (a.exactKey === b.exactKey) return { duplicate: true, score: 1, reasons: ['EXACT'] };

  const reasons = new Set<MatchReason>();
  const sameAddress = a.addressHash !== undefined && a.addressHash === b.addressHash;
  if (sameAddress) reasons.add('SAME_ADDRESS');
  if (a.parcelHash !== undefined && a.parcelHash === b.parcelHash) reasons.add('SAME_PARCEL');
  if (a.sourceUrlHash !== undefined && a.sourceUrlHash === b.sourceUrlHash) {
    reasons.add('SAME_SOURCE_URL');
  }
  if (a.unitHash !== undefined && a.unitHash === b.unitHash) reasons.add('SAME_UNIT');

  const distance =
    a.geo !== undefined && b.geo !== undefined ? distanceMeters(a.geo, b.geo) : undefined;
  if (distance !== undefined && distance <= config.geoNearMeters) reasons.add('GEO_NEAR');
  else if (distance !== undefined && distance <= ANCHOR_RADIUS_METERS) reasons.add('GEO_ANCHOR');

  const areaDifference = differencePercent(a.areaMinor, b.areaMinor) ?? 0;
  if (areaDifference <= config.tolerances.areaClosePercent) reasons.add('AREA_CLOSE');
  else if (areaDifference <= config.tolerances.areaNearPercent) reasons.add('AREA_NEAR');
  else if (areaDifference > config.tolerances.areaDiffersPercent) reasons.add('AREA_DIFFERS');

  if (a.rooms === b.rooms) reasons.add('ROOMS_EQUAL');
  else if (Math.abs(a.rooms - b.rooms) >= 1) reasons.add('ROOMS_DIFFER');

  const attributes = attributeAgreement(a, b, config);
  if (attributes.differs) reasons.add('ATTRIBUTES_DIFFER');
  else if (attributes.equal > 0) reasons.add('ATTRIBUTES_EQUAL');

  const price = priceDifference(a, b);
  if (price !== undefined && price <= config.tolerances.pricePercent) reasons.add('PRICE_CLOSE');

  const titleNear = hamming(a.titleSig, b.titleSig) <= config.textNearHamming;
  const descriptionNear = hamming(a.descriptionSig, b.descriptionSig) <= config.textNearHamming;
  if (titleNear) reasons.add('TITLE_NEAR');
  if (descriptionNear) reasons.add('DESCRIPTION_NEAR');

  const media = sharedMedia(a, b);
  if (media >= 2) reasons.add('MEDIA_SHARED_2');
  else if (media === 1) reasons.add('MEDIA_SHARED');

  // Ortsanker (Req 3.4): without one the pair is not compared further.
  const anchored =
    sameAddress ||
    (distance !== undefined && distance <= ANCHOR_RADIUS_METERS) ||
    reasons.has('SAME_PARCEL') ||
    reasons.has('SAME_SOURCE_URL') ||
    (a.postalCode === b.postalCode && titleNear && descriptionNear);
  if (!anchored) {
    return { duplicate: false, score: 0, reasons: [], excludedBy: 'NO_ANCHOR' };
  }

  // `ATTRIBUTES_EQUAL` counts once per agreeing merkmal, every other reason once.
  const weights = config.weights;
  const sum = [...reasons].reduce((total, reason) => {
    const factor = reason === 'ATTRIBUTES_EQUAL' ? attributes.equal : 1;
    return total + weights[reason as Exclude<MatchReason, 'EXACT'>] * factor;
  }, 0);
  const score = Math.min(1, Math.max(0, sum));
  return { duplicate: score >= config.threshold, score, reasons: sortReasons(reasons) };
}
