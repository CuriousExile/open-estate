import {
  blockKeys,
  buildProfile,
  isOlder,
  limitCandidates,
  lookupKeys,
  scoreMatch,
  type DuplicateConfig,
  type DuplicateMatch,
  type ListingContent,
  type MatchProfile,
  type MatchReason,
  type Taxonomy,
} from '@open-estate/shared';
import type { CandidateRef, DuplicateIndexStore, StoredProfile } from './duplicate-index-store';

// Duplikat_Prüfung (duplicate-detection design: "DuplicateDetector", Req 4, 5.1, 5.7, 5.8, 6.1):
// finds the Treffer of one listing inside its Prüfbereich. The detector only reads; what follows
// from the result (status on creation, Markierung) is decided by the callers with the pure
// `duplicateFlag`, so the Management_API, the import pipeline and the Duplikat_Abgleich agree.

/** The Duplikat_Index could not be read in time; nothing may be written (Req 5.8, 5.9). */
export class DuplicateIndexUnavailable extends Error {
  constructor(cause: unknown) {
    super('Duplicate index unavailable', { cause });
    this.name = 'DuplicateIndexUnavailable';
  }
}

export interface AssessInput {
  listingId: string;
  /** Prüfbereich of the listing after the write: `agencyScope(agencyId)` (Req 4.1). */
  scope: string;
  /** Anlagezeitpunkt; for a new listing the time of the creation (Req 4.3). */
  createdAt: string;
  /** Listing_Inhalt after the write, internal representation. */
  content: ListingContent;
  /** Öffentliche_Detail_URL of the listing, so a derived source URL is ignored (Req 3.1). */
  derivedSourceUrl?: string;
  /**
   * Listings this listing was released against (Req 8.3). Absent: read from the listing's stored
   * profile (the Management_API and the import); the Duplikat_Abgleich passes it.
   */
  dismissed?: readonly string[];
}

export interface DuplicateAssessment {
  profile: MatchProfile;
  /** `blockKeys(profile)`, what the writer stores. */
  blockKeys: string[];
  /** Treffer in the Prüfbereich: by descending score, ties by listing id. */
  matches: DuplicateMatch[];
  /** Oldest Treffer older than the listing (the Original), `null` = not a duplicate (Req 4.3). */
  original: string | null;
  /** Owner of the profile's exact key in the Prüfbereich, strongly consistent; may be the listing. */
  exactOwner: string | null;
  /** More candidates than `maxCandidates` were found; the weakest evidence was dropped. */
  truncated: boolean;
}

/** A duplicate in another Prüfbereich: the candidate of an Agenturübergreifender_Treffer. */
export interface CrossMatch {
  listingId: string;
  scope: string;
  score: number;
  reasons: MatchReason[];
}

/** Result of {@link DuplicateDetector.assessAcross}. */
export interface SweepAssessment {
  assessment: DuplicateAssessment;
  /** Duplicates outside the Prüfbereich, by listing id. */
  crossMatches: CrossMatch[];
  /** Listings of the Prüfbereich with the same exact key (including released pairs). */
  exactPeers: { listingId: string; createdAt: string }[];
  /** A candidate limit was reached within or outside the Prüfbereich (Req 5.7). */
  truncated: boolean;
}

export interface DuplicateDetectorDeps {
  index: Pick<
    DuplicateIndexStore<unknown>,
    'candidates' | 'getProfiles' | 'exactOwner' | 'getProfile'
  >;
  taxonomy: Taxonomy;
  config: DuplicateConfig;
}

/** Throws once the caller's deadline passed, so no write starts on a stale assessment. */
function ensureActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DuplicateIndexUnavailable(signal.reason);
}

export class DuplicateDetector {
  private readonly deps: DuplicateDetectorDeps;

  constructor(deps: DuplicateDetectorDeps) {
    this.deps = deps;
  }

  /** Configuration the assessments use (the writer needs the same block keys). */
  get config(): DuplicateConfig {
    return this.deps.config;
  }

  /** Merkmalsprofil of a content under the detector's rules. */
  profileOf(content: ListingContent, derivedSourceUrl?: string): MatchProfile {
    return buildProfile(content, {
      taxonomy: this.deps.taxonomy,
      config: this.deps.config,
      ...(derivedSourceUrl !== undefined && { derivedSourceUrl }),
    });
  }

  async assess(input: AssessInput, signal?: AbortSignal): Promise<DuplicateAssessment> {
    return (await this.evaluate(input, false, signal)).assessment;
  }

  /**
   * The assessment of {@link assess} plus what only the Duplikat_Abgleich needs (Req 10.3, 11.1):
   * duplicates in *other* Prüfbereiche (from the same block queries without the Prüfbereich
   * condition) and every listing of the Prüfbereich with the same exact key, Verwerfungen
   * included (the oldest of them owns the key).
   */
  async assessAcross(input: AssessInput, signal?: AbortSignal): Promise<SweepAssessment> {
    return this.evaluate(input, true, signal);
  }

  private async evaluate(
    input: AssessInput,
    across: boolean,
    signal: AbortSignal | undefined,
  ): Promise<SweepAssessment> {
    const { index, config } = this.deps;
    const profile = this.profileOf(input.content, input.derivedSourceUrl);
    try {
      ensureActive(signal);
      const [refs, exactOwner, dismissed] = await Promise.all([
        index.candidates(lookupKeys(profile, config), across ? undefined : input.scope),
        index.exactOwner(input.scope, profile.exactKey),
        input.dismissed ??
          index.getProfile(input.listingId).then((stored) => stored?.dismissed ?? []),
      ]);
      ensureActive(signal);
      const others = refs.filter((ref) => ref.listingId !== input.listingId);
      const limited = limitCandidates<CandidateRef>(
        others.filter((ref) => ref.scope === input.scope),
        config,
      );
      const ids = limited.candidates.map((ref) => ref.listingId);
      // The GSI may not show a just-created Exakt_Duplikat yet; the exact key is consistent.
      if (exactOwner !== null && exactOwner !== input.listingId && !ids.includes(exactOwner)) {
        ids.push(exactOwner);
      }
      const foreign = across
        ? limitCandidates<CandidateRef>(
            others.filter((ref) => ref.scope !== input.scope),
            config,
          )
        : { candidates: [], truncated: false };
      const foreignIds = foreign.candidates.map((ref) => ref.listingId);
      const profiles = await index.getProfiles([...ids, ...foreignIds]);
      ensureActive(signal);
      const own = ids.flatMap((id) => profiles.get(id) ?? []);
      const matches = this.matchesAgainst(input, profile, dismissed, own);
      return {
        assessment: {
          profile,
          blockKeys: blockKeys(profile, config),
          matches,
          original: originalOf(input, matches),
          exactOwner,
          truncated: limited.truncated,
        },
        crossMatches: this.crossMatches(
          profile,
          foreignIds.flatMap((id) => profiles.get(id) ?? []),
        ),
        exactPeers: own
          .filter((stored) => stored.profile.exactKey === profile.exactKey)
          .map(({ listingId, createdAt }) => ({ listingId, createdAt })),
        truncated: limited.truncated || foreign.truncated,
      };
    } catch (error) {
      if (error instanceof DuplicateIndexUnavailable) throw error;
      throw new DuplicateIndexUnavailable(error);
    }
  }

  /** Duplicates in other Prüfbereiche (Req 11.1); Verwerfungen do not apply across them. */
  private crossMatches(profile: MatchProfile, candidates: readonly StoredProfile[]): CrossMatch[] {
    const matches: CrossMatch[] = [];
    for (const candidate of candidates) {
      const result = scoreMatch(profile, candidate.profile, this.deps.config);
      if (!result.duplicate) continue;
      matches.push({
        listingId: candidate.listingId,
        scope: candidate.scope,
        score: result.score,
        reasons: result.reasons,
      });
    }
    return matches.sort((a, b) => (a.listingId < b.listingId ? -1 : 1));
  }

  /** Treffer among stored profiles: same Prüfbereich, no Verwerfung, duplicate by `scoreMatch`. */
  private matchesAgainst(
    input: AssessInput,
    profile: MatchProfile,
    ownDismissed: readonly string[],
    candidates: readonly StoredProfile[],
  ): DuplicateMatch[] {
    const dismissed = new Set(ownDismissed);
    const matches: DuplicateMatch[] = [];
    for (const candidate of candidates) {
      if (candidate.listingId === input.listingId || candidate.scope !== input.scope) continue;
      // A Verwerfung holds in both directions (Req 8.3).
      if (dismissed.has(candidate.listingId) || candidate.dismissed.includes(input.listingId)) {
        continue;
      }
      const result = scoreMatch(profile, candidate.profile, this.deps.config);
      if (!result.duplicate) continue;
      matches.push({
        listingId: candidate.listingId,
        createdAt: candidate.createdAt,
        score: result.score,
        reasons: result.reasons,
      });
    }
    return matches.sort((a, b) => b.score - a.score || (a.listingId < b.listingId ? -1 : 1));
  }
}

/** Oldest Treffer that is older than the listing (Req 4.3, 4.4). */
function originalOf(input: AssessInput, matches: readonly DuplicateMatch[]): string | null {
  const self = { listingId: input.listingId, createdAt: input.createdAt };
  const older = matches.filter((match) => isOlder(match, self));
  if (older.length === 0) return null;
  return older.reduce((a, b) => (isOlder(a, b) ? a : b)).listingId;
}
