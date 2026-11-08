import * as z from 'zod';
import { MATCH_REASONS, type MatchReason } from './duplicates/reasons';
import { IsoDateTime, LISTING_BOUNDS } from './schema/listing';

// Markierungen eines Listings (duplicate-detection Req 7). Markierungen are Verwaltungsdaten:
// they are not part of the Listing_Inhalt, do not enter the Inhalts_Hash, create no version of
// their own and are never delivered by the Öffentliche_Schnittstellen (Req 7.3, 7.4).
//
// The type is a discriminated union over `code`, so a further Markierungsart can be added later
// without changing the responses for existing codes (Req 7.8).

/** Markierungscodes; `DUPLICATE` is the only one so far. */
export const FLAG_CODES = ['DUPLICATE'] as const;
export type FlagCode = (typeof FLAG_CODES)[number];

/** Which step set or last changed a Markierung (Req 7.1). */
export const FLAG_DETECTIONS = ['CREATE', 'UPDATE', 'SWEEP'] as const;
export type FlagDetection = (typeof FLAG_DETECTIONS)[number];

/** Treffer recorded in a Duplikat_Markierung. */
export const FlagMatchSchema = z.object({
  listingId: z.string().min(LISTING_BOUNDS.id.min).max(LISTING_BOUNDS.id.max),
  score: z.number().min(0).max(1),
  reasons: z.array(z.enum(MATCH_REASONS)),
});
export type FlagMatch = z.infer<typeof FlagMatchSchema>;

/** Maximum number of Treffer a Duplikat_Markierung names (Req 7.2). */
export const MAX_FLAG_MATCHES = 5;

export const DuplicateFlagSchema = z.object({
  code: z.literal('DUPLICATE'),
  updatedAt: IsoDateTime,
  detectedBy: z.enum(FLAG_DETECTIONS),
  /** Oldest Treffer: the listing that stays online (Req 4.4). */
  originalId: z.string().min(LISTING_BOUNDS.id.min).max(LISTING_BOUNDS.id.max),
  matches: z.array(FlagMatchSchema).min(1).max(MAX_FLAG_MATCHES),
});
export type DuplicateFlag = z.infer<typeof DuplicateFlagSchema>;

/** Markierung of a listing; discriminated by `code`. */
export const ListingFlagSchema = z.discriminatedUnion('code', [DuplicateFlagSchema]);
export type ListingFlag = z.infer<typeof ListingFlagSchema>;

/** At most one Markierung per code, sorted by code (Req 7.1). */
export const ListingFlagsSchema = z
  .array(ListingFlagSchema)
  .refine((flags) => new Set(flags.map((flag) => flag.code)).size === flags.length, {
    message: 'At most one flag per code',
  });

/**
 * Zustand of an Agenturübergreifender_Treffer (Req 11): `OPEN` until a Plattform_Admin dismisses it
 * (`DISMISSED`, never reopened while both listings exist, Req 11.5) or a Duplikat_Abgleich no
 * longer finds the pair (`RESOLVED`, Req 11.6; reopened when found again).
 */
export const DUPLICATE_REPORT_STATES = ['OPEN', 'DISMISSED', 'RESOLVED'] as const;
export type DuplicateReportState = (typeof DUPLICATE_REPORT_STATES)[number];

/** Why the platform stored a status other than the requested one (Req 5.4). */
export const StatusReasonSchema = z.object({
  code: z.literal('DUPLICATE'),
  originalId: z.string().min(LISTING_BOUNDS.id.min).max(LISTING_BOUNDS.id.max),
});
export type StatusReason = z.infer<typeof StatusReasonSchema>;

/** Codes of a flag list, sorted; the stored filter attribute of the `Listings` table. */
export const flagCodes = (flags: readonly ListingFlag[]): FlagCode[] =>
  [...new Set(flags.map((flag) => flag.code))].sort();

/** A listing of the Prüfbereich that the compared listing is a duplicate of. */
export interface DuplicateMatch {
  listingId: string;
  /** Anlagezeitpunkt (ISO-8601 with offset), for the age comparison of Req 4.3. */
  createdAt: string;
  score: number;
  reasons: MatchReason[];
}

/** Listing the Markierung is computed for. */
export interface FlaggedListing {
  listingId: string;
  createdAt: string;
}

/** Älteres_Listing: earlier `createdAt`, ties broken by the smaller id (deterministic). */
export function isOlder(candidate: FlaggedListing, reference: FlaggedListing): boolean {
  const left = Date.parse(candidate.createdAt);
  const right = Date.parse(reference.createdAt);
  if (Number.isNaN(left) || Number.isNaN(right) || left === right) {
    return candidate.listingId < reference.listingId;
  }
  return left < right;
}

/**
 * Duplikat_Markierung of a listing (Req 4.3, 4.4, 7.2): `null` when no Treffer is older than the
 * listing itself. The Markierung names the oldest older Treffer as Original and up to
 * {@link MAX_FLAG_MATCHES} of them, by descending Übereinstimmungswert (ties by listing id).
 *
 * Pure, so the Management_API, the import pipeline and the Duplikat_Abgleich decide alike.
 */
export function duplicateFlag(
  listing: FlaggedListing,
  matches: readonly DuplicateMatch[],
  detectedBy: FlagDetection,
  at: string,
): DuplicateFlag | null {
  const older = matches.filter((match) => isOlder(match, listing));
  if (older.length === 0) return null;
  const oldest = older.reduce((a, b) => (isOlder(a, b) ? a : b));
  const ranked = [...older].sort(
    (a, b) => b.score - a.score || (a.listingId < b.listingId ? -1 : 1),
  );
  return {
    code: 'DUPLICATE',
    updatedAt: at,
    detectedBy,
    originalId: oldest.listingId,
    matches: ranked.slice(0, MAX_FLAG_MATCHES).map(({ listingId, score, reasons }) => ({
      listingId,
      score,
      reasons,
    })),
  };
}

/** Flags with the Duplikat_Markierung replaced or removed (`null`); other codes stay. */
export function withDuplicateFlag(
  flags: readonly ListingFlag[],
  flag: DuplicateFlag | null,
): ListingFlag[] {
  const others = flags.filter((existing) => existing.code !== 'DUPLICATE');
  return [...others, ...(flag === null ? [] : [flag])].sort((a, b) =>
    a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
}

/** The Duplikat_Markierung of a flag list, if any. */
export const duplicateFlagOf = (flags: readonly ListingFlag[]): DuplicateFlag | undefined =>
  flags.find((flag): flag is DuplicateFlag => flag.code === 'DUPLICATE');

/**
 * Audit details of a Markierung change (duplicate-detection Req 7.7): codes and listing ids only,
 * never values of Inhaltsfeldern (Req 12.2). Strict, so nothing else can enter the Audit_Log.
 */
export const FlagAuditDetailsSchema = z.strictObject({
  flag: z.enum(FLAG_CODES),
  originalId: z.string().min(LISTING_BOUNDS.id.min).max(LISTING_BOUNDS.id.max).optional(),
  reasons: z.array(z.enum(MATCH_REASONS)).optional(),
});
export type FlagAuditDetails = z.infer<typeof FlagAuditDetailsSchema>;
