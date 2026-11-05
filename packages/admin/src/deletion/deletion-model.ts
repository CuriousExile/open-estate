// The deletion model is shared with core's `AdminOperations`.
export {
  DELETION_STATUSES,
  DeletionRequestNotFoundError,
  deletionCriterionSchema,
  deletionRequestRecordSchema,
  describeCriterion,
  type DeletionBlocklistEntry,
  type DeletionCriterion,
  type DeletionRequestRecord,
  type DeletionStatus,
  type DeletionTarget,
  type TargetPage,
} from '@open-estate/core';
