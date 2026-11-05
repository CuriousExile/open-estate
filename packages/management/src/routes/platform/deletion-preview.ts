import {
  describeCriterion,
  parseDeletionCriterion,
  type DeletionCriterion,
  type DeletionListingStore,
} from '@open-estate/core';
import { err, ok, type ApiError, type DryRunResponse, type Result } from '@open-estate/shared';

/** Targets read per page while counting a source's listings. */
export const DELETION_PREVIEW_PAGE_SIZE = 1000;

type TargetReader = Pick<DeletionListingStore, 'find' | 'listBySource'>;

async function countTargets(
  targets: TargetReader,
  criterion: DeletionCriterion,
  signal: AbortSignal,
): Promise<number> {
  if ('listingId' in criterion) return (await targets.find(criterion.listingId)) === null ? 0 : 1;
  let count = 0;
  let cursor: string | undefined;
  do {
    signal.throwIfAborted();
    const page = await targets.listBySource(criterion.source, {
      limit: DELETION_PREVIEW_PAGE_SIZE,
      ...(cursor !== undefined && { cursor }),
    });
    count += page.targets.length;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return count;
}

/**
 * `POST /platform/deletions?dryRun=true` (Req 10.8): validates the body exactly like
 * `requestDeletion` and counts the affected listings without writing or auditing anything. A
 * criterion without listings yields the same `DELETION_TARGET_NOT_FOUND` the real request would,
 * so the preview predicts its outcome.
 */
export async function previewDeletion(
  targets: TargetReader,
  input: unknown,
  signal: AbortSignal,
): Promise<Result<DryRunResponse, ApiError[]>> {
  const parsed = parseDeletionCriterion(input);
  if (!parsed.ok) return parsed;
  const criterion = parsed.value;
  const affectedListings = await countTargets(targets, criterion, signal);
  if (affectedListings === 0) {
    return err([
      {
        code: 'DELETION_TARGET_NOT_FOUND',
        message: `No listing found for ${describeCriterion(criterion)}`,
        field: 'listingId' in criterion ? 'listingId' : 'source',
        details: { criterion },
      },
    ]);
  }
  return ok({ dryRun: true, affectedListings });
}
