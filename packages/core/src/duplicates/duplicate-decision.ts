import {
  duplicateFlag,
  duplicateFlagOf,
  withDuplicateFlag,
  type DuplicateFlag,
  type FlagAuditDetails,
  type ListingFlag,
} from '@open-estate/shared';
import type { DuplicateAssessment } from './duplicate-detector';

// What follows from a Duplikat_Prüfung (duplicate-detection Req 4.3, 5.2, 6.1, 6.3, 9.1). Pure,
// and shared by the Management_API and the import pipeline, so both channels decide alike.

/** Same Original and the same Treffer with the same values: the Markierung did not change. */
export function sameFlag(
  a: DuplicateFlag | undefined | null,
  b: DuplicateFlag | undefined | null,
): boolean {
  if (a === undefined || a === null || b === undefined || b === null) return a === b;
  const key = (flag: DuplicateFlag) =>
    JSON.stringify([flag.originalId, flag.matches.map((m) => [m.listingId, m.score, m.reasons])]);
  return key(a) === key(b);
}

/**
 * Markierungen of a listing after a creation or a change: the Duplikat_Markierung follows the
 * assessment (Req 4.3); a Markierung the write leaves as it was keeps its state, including
 * `detectedBy` and `updatedAt` (Req 6.3); other Markierungscodes stay untouched.
 */
export function flagsAfterCheck(
  kind: 'CREATE' | 'UPDATE',
  listing: { listingId: string; createdAt: string },
  assessment: Pick<DuplicateAssessment, 'matches'>,
  currentFlags: readonly ListingFlag[],
  now: string,
): { flags: ListingFlag[]; flag: DuplicateFlag | null } {
  const current = duplicateFlagOf(currentFlags);
  const computed = duplicateFlag(listing, assessment.matches, kind, now);
  const flag = sameFlag(current, computed) ? (current ?? null) : computed;
  return { flags: withDuplicateFlag(currentFlags, flag), flag };
}

/**
 * Anlagezeitpunkt of a new listing (Req 4.3, 9.1): the time of the write attempt, but after the
 * owner of the exact key if that listing was written first — its clock may have run ahead.
 */
export function creationTimeAfterCheck(
  now: string,
  assessment: Pick<DuplicateAssessment, 'matches' | 'exactOwner'>,
): string {
  const owner = assessment.matches.find((match) => match.listingId === assessment.exactOwner);
  if (owner === undefined || Date.parse(owner.createdAt) < Date.parse(now)) return now;
  return new Date(Date.parse(owner.createdAt) + 1).toISOString();
}

/** Audit details of a Duplikat_Markierung: codes and ids only (Req 7.7, 12.2). */
export function flagDetails(flag: DuplicateFlag): FlagAuditDetails {
  const reasons = flag.matches.find((match) => match.listingId === flag.originalId)?.reasons;
  return {
    flag: 'DUPLICATE',
    originalId: flag.originalId,
    ...(reasons !== undefined && { reasons }),
  };
}
