// Catalog of Übereinstimmungsgründe (duplicate-detection Req 3.10). The codes are stable and
// part of the API: they appear in Duplikat_Markierungen, in agenturübergreifenden Treffern and in
// the Developer_Documentation, and the portal translates them.
//
// Order matters: `scoreMatch` reports the reasons of a pair in exactly this order, so two calls
// with the same inputs produce the same list (Req 3.7).

export const MATCH_REASONS = [
  /** Both Merkmalsprofile are equal in every comparison part (Req 3.6). */
  'EXACT',
  /** Same source URL, and neither is the derived Öffentliche_Detail_URL. */
  'SAME_SOURCE_URL',
  /** Same cadastral/land-registry reference. */
  'SAME_PARCEL',
  /** Same normalized street with house number. */
  'SAME_ADDRESS',
  /** Coordinates within `geoNearMeters` (default 15 m). */
  'GEO_NEAR',
  /** Coordinates within the anchor radius of 50 m, but farther apart than `geoNearMeters`. */
  'GEO_ANCHOR',
  /** Same normalized unit (flat/unit designation). */
  'SAME_UNIT',
  /** Living area within `tolerances.areaClosePercent`. */
  'AREA_CLOSE',
  /** Living area within `tolerances.areaNearPercent`, but not within `areaClosePercent`. */
  'AREA_NEAR',
  /** Living areas differ by more than `tolerances.areaDiffersPercent`. */
  'AREA_DIFFERS',
  'ROOMS_EQUAL',
  /** Room counts differ by at least one room. */
  'ROOMS_DIFFER',
  /** Every Objektmerkmal present in both listings has the same value. */
  'ATTRIBUTES_EQUAL',
  /** At least one Objektmerkmal present in both listings differs. */
  'ATTRIBUTES_DIFFER',
  /** Same offer type and currency with a price within `tolerances.pricePercent`. */
  'PRICE_CLOSE',
  /** Titles nearly equal (SimHash distance ≤ `textNearHamming`). */
  'TITLE_NEAR',
  /** Descriptions nearly equal (SimHash distance ≤ `textNearHamming`). */
  'DESCRIPTION_NEAR',
  /** At least one shared media URL. */
  'MEDIA_SHARED',
  /** At least two shared media URLs (reported instead of `MEDIA_SHARED`). */
  'MEDIA_SHARED_2',
] as const;

export type MatchReason = (typeof MATCH_REASONS)[number];

/** Reasons that carry a weight in the Duplikat_Konfiguration; `EXACT` is decided separately. */
export const WEIGHTED_REASONS = MATCH_REASONS.filter(
  (reason): reason is Exclude<MatchReason, 'EXACT'> => reason !== 'EXACT',
);

const ORDER = new Map<MatchReason, number>(MATCH_REASONS.map((reason, index) => [reason, index]));

/** Sorts reasons into catalog order (deterministic output of `scoreMatch`). */
export function sortReasons(reasons: Iterable<MatchReason>): MatchReason[] {
  return [...reasons].sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0));
}

/**
 * Why two listings are not duplicates although they were compared (Req 3.3, 3.4). Only for logs
 * and tests; an exclusion is never published as a reason.
 */
export const MATCH_EXCLUSIONS = [
  'COUNTRY',
  'GROUP',
  'OFFER_TYPE',
  'ADDRESS',
  'UNIT',
  'FLOOR',
  'PARCEL',
  /** No Ortsanker (Req 3.4): the listings may be two different properties in the same area. */
  'NO_ANCHOR',
] as const;

export type MatchExclusion = (typeof MATCH_EXCLUSIONS)[number];
