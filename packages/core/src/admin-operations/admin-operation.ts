import { type ActorRef, type ApiError, type Result } from '@open-estate/shared';
import { auditActorId } from '../management/audit-service';

/**
 * Who runs an admin operation: an IAM identity (Admin_API) or a Plattform_Admin (Management_API,
 * Req 10.7).
 */
export type AdminActor = Extract<ActorRef, { kind: 'iam' } | { kind: 'user' }>;

/** Actor as stored in audit entries and `requestedBy`: the IAM `userArn` or the user id. */
export const adminActorId = (actor: AdminActor): string => auditActorId(actor);

/** Error codes an admin operation rejects with; each maps to the catalog's HTTP status. */
export type AdminOperationErrorCode =
  'INVALID_PARAMETER' | 'NOT_FOUND' | 'DELETION_TARGET_NOT_FOUND';

/**
 * Rejection of an admin operation. `code` selects the response status; `errors` is the response
 * body (validation errors may carry `INVALID_RATE_LIMIT` with status 400).
 */
export interface AdminOperationError {
  code: AdminOperationErrorCode;
  errors: ApiError[];
}

export type AdminResult<T> = Result<T, AdminOperationError>;

export const invalidInput = (errors: ApiError[]): AdminOperationError => ({
  code: 'INVALID_PARAMETER',
  errors,
});

export const notFoundError = (message: string): AdminOperationError => ({
  code: 'NOT_FOUND',
  errors: [{ code: 'NOT_FOUND', message }],
});
