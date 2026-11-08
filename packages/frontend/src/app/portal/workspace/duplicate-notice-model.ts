// Framework-free model of the Duplikat-Hinweis of the listing workspace (duplicate-detection
// design: DuplicateNoticeComponent; Req 8.5, 13.2). Kept free of Angular imports so it can be
// unit-tested with plain Jest.
import {
  duplicateFlagOf,
  type ListingFlag,
  type ListingStatus,
  type Permission,
} from '@open-estate/shared';

/** What the Hinweis needs of a listing (parsed view or raw response). */
export interface FlaggedView {
  readonly flags: readonly ListingFlag[];
  readonly status: ListingStatus;
}

/** One Treffer of the Markierung as shown. */
export interface DuplicateMatchView {
  readonly listingId: string;
  /** Übereinstimmungswert in percent, rounded. */
  readonly percent: number;
  /** Translation keys of the Übereinstimmungsgründe (`duplicate.reasons.<CODE>`). */
  readonly reasonKeys: readonly string[];
}

export interface DuplicateNotice {
  /** The listing that stays online (Req 4.4). */
  readonly originalId: string;
  /** The Original's Treffer first, then the others by descending value. */
  readonly matches: readonly DuplicateMatchView[];
  readonly detectedBy: 'CREATE' | 'UPDATE' | 'SWEEP';
  readonly updatedAt: string;
  /** „Trotzdem aktivieren“: inactive and allowed to change the status (Req 8.1, 8.5). */
  readonly canActivate: boolean;
  /** „Markierung verwerfen“ (Req 8.2). */
  readonly canDismiss: boolean;
}

export const reasonKey = (code: string): string => `duplicate.reasons.${code}`;

/** Rounded percent of an Übereinstimmungswert (0…1). */
export const scorePercent = (score: number): number => Math.round(score * 100);

/**
 * The Hinweis of a listing with Duplikat_Markierung, or `undefined` without one. `can` is the
 * session's permission check for the listing's agency.
 */
export function toDuplicateNotice(
  view: FlaggedView,
  can: (permission: Permission) => boolean,
): DuplicateNotice | undefined {
  const flag = duplicateFlagOf(view.flags);
  if (flag === undefined) return undefined;
  const ordered = [
    ...flag.matches.filter((m) => m.listingId === flag.originalId),
    ...flag.matches.filter((m) => m.listingId !== flag.originalId),
  ];
  const mayChangeStatus = can('listing:status');
  return {
    originalId: flag.originalId,
    matches: ordered.map((m) => ({
      listingId: m.listingId,
      percent: scorePercent(m.score),
      reasonKeys: m.reasons.map(reasonKey),
    })),
    detectedBy: flag.detectedBy,
    updatedAt: flag.updatedAt,
    canActivate: mayChangeStatus && view.status !== 'ACTIVE',
    canDismiss: mayChangeStatus,
  };
}

/** Lines of the confirmation before activating (Req 8.5): the Original's reasons. */
export function activationLines(
  notice: DuplicateNotice,
): { key: string; params: Record<string, number> }[] {
  const original =
    notice.matches.find((m) => m.listingId === notice.originalId) ?? notice.matches[0];
  return (original?.reasonKeys ?? []).map((key) => ({ key, params: {} }));
}

/** Notice key the workspace shows after a creation stored as a possible duplicate (Req 13.3). */
export const DUPLICATE_CREATED_NOTICE = 'portal.duplicates.createdNotice';

/** Does a just-created listing carry a Duplikat_Markierung (post-create Hinweis, Req 13.3)? */
export const createdAsDuplicate = (view: Pick<FlaggedView, 'flags'>): boolean =>
  duplicateFlagOf(view.flags) !== undefined;
