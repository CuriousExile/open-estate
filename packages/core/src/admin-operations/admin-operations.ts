import type { AccessConfigWriter } from '../access/access-config';
import type { ApiKeyAdminStore } from '../access/api-key-store';
import { systemClock, type Clock } from '../access/ttl-cache';
import {
  createAccessOperations,
  type AccessOperations,
  type GeneratedApiKey,
} from './access-operations';
import type { AdminAuditLog } from './admin-audit-log';
import {
  createDeletionOperations,
  type DeletionOperations,
  type DeletionOperationsDeps,
} from './deletion-operations';

export interface AdminOperationsDeps {
  apiKeys: ApiKeyAdminStore;
  accessConfig: AccessConfigWriter;
  audit: AdminAuditLog;
  /** Deletion requests and blocklist (Req 18.4–18.9). */
  deletions: DeletionOperationsDeps;
  clock?: Clock;
  generateKey?: () => GeneratedApiKey;
}

/**
 * Use cases of the Admin_API, shared with the Management_API's `/platform/*` (Req 10.7): same
 * schemas, error codes and audit entries; only the actor differs (IAM identity vs. user). Reload
 * is `reloadFunctions` (needs a Lambda client, not these stores).
 */
export type AdminOperations = AccessOperations & DeletionOperations;

export function createAdminOperations(deps: AdminOperationsDeps): AdminOperations {
  const clock = deps.clock ?? systemClock;
  return {
    ...createAccessOperations({
      apiKeys: deps.apiKeys,
      accessConfig: deps.accessConfig,
      audit: deps.audit,
      clock,
      ...(deps.generateKey !== undefined && { generateKey: deps.generateKey }),
    }),
    ...createDeletionOperations({ ...deps.deletions, audit: deps.audit, clock }),
  };
}
