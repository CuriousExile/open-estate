import type { SSMClient } from '@aws-sdk/client-ssm';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AuditService, Clock, DuplicateDetectionSetting } from '@open-estate/core';
import type { Route } from '../router';

// Contract between the Lambda init and the route groups (identity/agencies, listings,
// monitoring, platform). Each group lives in its own file under `routes/` and wires its own use
// cases from the environment, so groups can be added without touching the init or each other.

/** Dependencies every group receives. */
export interface SharedRouteDeps {
  /** Validated frontend origin (SSM `/open-estate/{env}/frontend-origin`) for detail URLs (Req 4.5). */
  frontendOrigin: string;
  /** Audit_Log write side (`management` / `access-denied` entries). */
  audit: AuditService;
  clock: Clock;
  /**
   * Ein/Aus of the Duplikat-Erkennung (one instance, so a switch is seen at once by the listing
   * commands of this Lambda). Absent (tests): always on and not switchable.
   */
  duplicateDetection?: DuplicateDetectionSetting;
}

/** AWS clients shared by all groups (one instance per Lambda). */
export interface ManagementClients {
  dynamo: DynamoDBDocumentClient;
  ssm: SSMClient;
}

/** What a group gets at Lambda init. */
export interface RouteGroupContext {
  /** Lambda environment; read required names with `readEnv` (throws `ConfigError`). */
  env: Readonly<Record<string, string | undefined>>;
  clients: ManagementClients;
  shared: SharedRouteDeps;
}

export interface RouteGroup {
  /** Stable group name, e.g. `listings`. */
  name: string;
  /**
   * Builds the group's routes from the environment; throws `ConfigError` on missing config.
   * `registered`: routes of the groups registered before this one (e.g. for `/openapi.json`).
   */
  create(context: RouteGroupContext, registered?: readonly Route[]): Route[];
}
