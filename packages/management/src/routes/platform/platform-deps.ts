import type { AdminOperations, DeletionListingStore, ReloadOutcome } from '@open-estate/core';

/**
 * What the `/platform/*` routes need. Each factory gets the request's abort signal so the AWS
 * calls of a request past its deadline are cancelled.
 */
export interface PlatformDeps {
  /** The Admin_API's use cases (`AdminOperations`), bound to `signal`. */
  operations(signal: AbortSignal): AdminOperations;
  /** Read side of the deletion targets, for `POST /platform/deletions?dryRun=true`. */
  deletionTargets(signal: AbortSignal): Pick<DeletionListingStore, 'find' | 'listBySource'>;
  /** Increments `CONFIG_VERSION` of every configured reload target (API, MCP, connectors). */
  reload(signal: AbortSignal): Promise<ReloadOutcome[]>;
}
