import * as z from 'zod';
import { canonicalJson } from '../cursor';
import { sha256Hex } from '../sha256';
import { WEIGHTED_REASONS, type MatchReason } from './reasons';

// Duplikat_Konfiguration (duplicate-detection Req 3.8, 3.9): weights, tolerances, threshold,
// normalization aliases and the schedule of the Duplikat_Abgleich. The file
// `config/duplicate-detection.json` holds the defaults; a deployment may override it. An invalid
// file aborts the start with one issue per field (Req 3.9), like every other config file.

/** Name of the optional configuration file in the config directory and the config bucket. */
export const DUPLICATE_CONFIG_FILE = 'duplicate-detection.json';

/** Radius of the geo Ortsanker in metres (Req 3.4); fixed, because the block grid matches it. */
export const ANCHOR_RADIUS_METERS = 50;

const percent = (fallback: number) => z.number().min(0).max(100).default(fallback);

const DEFAULT_WEIGHTS: Readonly<Record<Exclude<MatchReason, 'EXACT'>, number>> = {
  SAME_SOURCE_URL: 0.6,
  SAME_PARCEL: 0.45,
  SAME_ADDRESS: 0.35,
  GEO_NEAR: 0.3,
  GEO_ANCHOR: 0.15,
  SAME_UNIT: 0.1,
  AREA_CLOSE: 0.2,
  AREA_NEAR: 0.1,
  AREA_DIFFERS: -0.4,
  ROOMS_EQUAL: 0.1,
  ROOMS_DIFFER: -0.3,
  ATTRIBUTES_EQUAL: 0.03,
  ATTRIBUTES_DIFFER: -0.25,
  PRICE_CLOSE: 0.05,
  TITLE_NEAR: 0.1,
  DESCRIPTION_NEAR: 0.15,
  MEDIA_SHARED: 0.15,
  MEDIA_SHARED_2: 0.3,
};

/** Every weight optional; missing ones keep their default, unknown codes are rejected. */
const Weights = z
  .strictObject(
    Object.fromEntries(
      WEIGHTED_REASONS.map((reason) => [reason, z.number().min(-1).max(1).optional()]),
    ) as Record<Exclude<MatchReason, 'EXACT'>, z.ZodOptional<z.ZodNumber>>,
  )
  .prefault({})
  .transform((configured): Record<Exclude<MatchReason, 'EXACT'>, number> => {
    const merged = { ...DEFAULT_WEIGHTS };
    for (const reason of WEIGHTED_REASONS) {
      const value = configured[reason];
      if (value !== undefined) merged[reason] = value;
    }
    return merged;
  });

const Tolerances = z
  .strictObject({
    /** Living areas within this percentage count as equal (`AREA_CLOSE`). */
    areaClosePercent: percent(2),
    /** Living areas within this percentage still count as similar (`AREA_NEAR`). */
    areaNearPercent: percent(5),
    /** Above this percentage the living areas contradict each other (`AREA_DIFFERS`). */
    areaDiffersPercent: percent(10),
    /** Prices of the same offer type and currency within this percentage (`PRICE_CLOSE`). */
    pricePercent: percent(5),
    /** Plot areas within this percentage count as equal. */
    plotAreaClosePercent: percent(2),
    /** Above this percentage the plot areas contradict each other. */
    plotAreaDiffersPercent: percent(5),
  })
  .prefault({})
  .refine((t) => t.areaClosePercent <= t.areaNearPercent, {
    path: ['areaClosePercent'],
    message: 'areaClosePercent must not be greater than areaNearPercent',
  })
  .refine((t) => t.areaNearPercent <= t.areaDiffersPercent, {
    path: ['areaNearPercent'],
    message: 'areaNearPercent must not be greater than areaDiffersPercent',
  })
  .refine((t) => t.plotAreaClosePercent <= t.plotAreaDiffersPercent, {
    path: ['plotAreaClosePercent'],
    message: 'plotAreaClosePercent must not be greater than plotAreaDiffersPercent',
  });

/**
 * Street suffixes: canonical form → spellings mapped onto it. Applied to whole tokens and to the
 * end of a token, so "Hauptstraße", "Haupt-Strasse" and "Haupt Str." normalize alike (Req 3.2).
 */
const DEFAULT_STREET_SUFFIXES: Record<string, string[]> = {
  str: ['strasse', 'straße', 'str'],
  pl: ['platz', 'pl'],
  weg: ['weg'],
  allee: ['allee', 'al'],
  gasse: ['gasse', 'g'],
  st: ['street', 'st'],
  rd: ['road', 'rd'],
  ave: ['avenue', 'ave', 'av'],
  ln: ['lane', 'ln'],
  dr: ['drive', 'dr'],
};

/** Words that carry no information in a unit designation ("Whg. 3" = "3"). */
const DEFAULT_UNIT_NOISE_WORDS: string[] = [
  'whg',
  'wohnung',
  // Wohneinheit, as in "WE 3" (calibration, task 13.2).
  'we',
  'einheit',
  'apt',
  'apartment',
  'flat',
  'unit',
  'nr',
  'no',
  'top',
];

const Normalization = z
  .strictObject({
    streetSuffixes: z
      .record(z.string().min(1), z.array(z.string().min(1)).min(1))
      .default(DEFAULT_STREET_SUFFIXES),
    unitNoiseWords: z.array(z.string().min(1)).default(DEFAULT_UNIT_NOISE_WORDS),
  })
  .prefault({});

const Sweep = z
  .strictObject({
    /** Start of the daily Duplikat_Abgleich, UTC (Req 10.1). */
    timeUtc: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Expected a UTC time "HH:MM"' })
      .default('03:00'),
    /** Parallel scan segments of one phase (Req 10.9). */
    segments: z.int().min(1).max(64).default(8),
  })
  .prefault({});

export const DuplicateConfig = z
  .strictObject({
    /** Übereinstimmungswert from which two listings count as duplicates (Req 3.5). */
    threshold: z.number().min(0.05).max(1).default(0.7),
    /** Upper bound of compared candidates per listing (Req 5.7). */
    maxCandidates: z.int().min(10).max(1000).default(200),
    /**
     * SimHash distance up to which two texts count as nearly equal. At most 7, because the
     * candidate search splits the signature into `textNearHamming + 1` bands (see `blocks.ts`).
     */
    textNearHamming: z.int().min(0).max(7).default(3),
    /** Distance in metres up to which coordinates count as the same place (`GEO_NEAR`). */
    geoNearMeters: z.number().min(1).max(ANCHOR_RADIUS_METERS).default(15),
    tolerances: Tolerances,
    weights: Weights,
    normalization: Normalization,
    sweep: Sweep,
  })
  .prefault({});

export type DuplicateConfig = z.output<typeof DuplicateConfig>;
export type DuplicateConfigInput = z.input<typeof DuplicateConfig>;

/** Defaults of every field; used when `duplicate-detection.json` is absent (Req 3.8). */
export const DEFAULT_DUPLICATE_CONFIG: DuplicateConfig = DuplicateConfig.parse(undefined);

/**
 * Hash over the parts of the configuration that change a Merkmalsprofil or its Blockschlüssel.
 * Stored with every profile, so the Duplikat_Abgleich notices that profiles were built with
 * outdated rules and rebuilds them (Req 10.4, 10.6). Weights and the threshold are not part of
 * it: they change the evaluation, not the stored profile.
 */
export function profileRulesHash(config: DuplicateConfig): string {
  const relevant = {
    normalization: config.normalization,
    textNearHamming: config.textNearHamming,
  };
  return sha256Hex(new TextEncoder().encode(canonicalJson(relevant) ?? '')).slice(0, 16);
}
