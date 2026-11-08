import { ANCHOR_RADIUS_METERS, type DuplicateConfig } from './config';
import type { MatchProfile } from './profile';
import { bands } from './simhash';

// Blockschlüssel (duplicate-detection design: "Blockschlüssel und Verlustfreiheit"). A listing
// stores one key per Ortsanker it can serve; a lookup asks for the keys of the searched listing
// plus the geo neighbourhood. Every pair with an Ortsanker (Req 3.4) shares at least one key, so
// the candidate search misses no duplicate (Property 9).

/** Kinds of block keys, from the most to the least specific (order of the candidate limit). */
export const BLOCK_KINDS = ['U', 'P', 'A', 'G', 'T'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/** Kind of a block key (its prefix). */
export const blockKind = (key: string): BlockKind => (key.split('|')[0] ?? 'T') as BlockKind;

// Geo grid: cells of 0.001° in both directions. A row is ~111 m high, so the rows `lat ± 1`
// cover the anchor radius; the number of columns is computed per latitude, because a column
// shrinks with cos(latitude).
export const GRID_STEP_DEGREES = 0.001;
const METERS_PER_DEGREE_LAT = 111_320;
/** Beyond this latitude columns get so narrow that the ring is capped (no listings expected). */
const MAX_RING = 60;

const cellOf = (degrees: number): number => Math.floor(degrees / GRID_STEP_DEGREES);

/** Longitude cells wrap around the date line. */
const LON_CELLS = Math.round(360 / GRID_STEP_DEGREES);
const wrapLon = (cell: number): number => ((cell % LON_CELLS) + LON_CELLS) % LON_CELLS;

const geoKey = (latCell: number, lonCell: number): string => `G|${latCell}|${wrapLon(lonCell)}`;

/**
 * Columns to each side that cover {@link ANCHOR_RADIUS_METERS} at the given latitude rows.
 * Uses the largest absolute latitude of the three rows, where columns are narrowest.
 */
function lonRing(latCell: number): number {
  const latitudes = [latCell, latCell + 1].map((cell) => cell * GRID_STEP_DEGREES);
  const worstLatitude = Math.min(89.999, Math.max(...latitudes.map(Math.abs)));
  const columnMeters =
    GRID_STEP_DEGREES * METERS_PER_DEGREE_LAT * Math.cos((worstLatitude * Math.PI) / 180);
  if (columnMeters <= 0) return MAX_RING;
  return Math.min(MAX_RING, Math.ceil(ANCHOR_RADIUS_METERS / columnMeters));
}

/** Text bands of a title signature; `textNearHamming + 1` bands make the search lossless. */
const textKeys = (profile: MatchProfile, config: DuplicateConfig): string[] =>
  bands(profile.titleSig, config.textNearHamming + 1).map(
    (band, index) => `T|${profile.country}|${profile.postalCode}|${index}|${band}`,
  );

/**
 * Keys a listing is stored under: one per anchor it can serve. Every listing has the text keys,
 * so an Exakt_Duplikat is always found as well (its title signature is equal).
 */
export function blockKeys(profile: MatchProfile, config: DuplicateConfig): string[] {
  const keys: string[] = [];
  if (profile.sourceUrlHash !== undefined) keys.push(`U|${profile.sourceUrlHash}`);
  if (profile.parcelHash !== undefined) keys.push(`P|${profile.parcelHash}`);
  if (profile.addressHash !== undefined) keys.push(`A|${profile.addressHash}`);
  if (profile.geo !== undefined) {
    keys.push(geoKey(cellOf(profile.geo.lat), cellOf(profile.geo.lon)));
  }
  keys.push(...textKeys(profile, config));
  return keys;
}

/**
 * Keys a lookup asks for: the stored keys, and for the geo anchor the neighbouring cells, so
 * every listing within {@link ANCHOR_RADIUS_METERS} is found regardless of cell boundaries.
 */
export function lookupKeys(profile: MatchProfile, config: DuplicateConfig): string[] {
  const keys = new Set<string>(blockKeys(profile, config));
  if (profile.geo !== undefined) {
    const latCell = cellOf(profile.geo.lat);
    const lonCell = cellOf(profile.geo.lon);
    for (const latOffset of [-1, 0, 1]) {
      const ring = lonRing(latCell + latOffset);
      for (let lonOffset = -ring; lonOffset <= ring; lonOffset += 1) {
        keys.add(geoKey(latCell + latOffset, lonCell + lonOffset));
      }
    }
  }
  return [...keys];
}

/**
 * Candidates of a lookup, limited to `maxCandidates` (Req 5.7): the most specific keys first, so
 * the limit drops the weakest evidence (text blocks of a common title) first. `truncated` says
 * whether candidates were dropped.
 */
export function limitCandidates<T extends { listingId: string; key: string }>(
  candidates: readonly T[],
  config: DuplicateConfig,
): { candidates: T[]; truncated: boolean } {
  const byListing = new Map<string, T>();
  const rank = (candidate: T): number => BLOCK_KINDS.indexOf(blockKind(candidate.key));
  for (const candidate of candidates) {
    const known = byListing.get(candidate.listingId);
    if (known === undefined || rank(candidate) < rank(known)) {
      byListing.set(candidate.listingId, candidate);
    }
  }
  const sorted = [...byListing.values()].sort(
    (a, b) => rank(a) - rank(b) || (a.listingId < b.listingId ? -1 : 1),
  );
  return {
    candidates: sorted.slice(0, config.maxCandidates),
    truncated: sorted.length > config.maxCandidates,
  };
}
