import type { ContentPath, ListingContent } from './content';

// Management types of the listing management (design: "Data Models", "Authenticator und
// Principal", "Berechtigungsmodell"). Pure types and enumerations, usable by the frontend.

/** Listing_Status (Req 6.1). */
export const LISTING_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/** Änderungskanal: `API` = Maschinenzugang, `ADMIN` = Admin_Modus or Admin_API. */
export const CHANNELS = ['PORTAL', 'API', 'IMPORT', 'ADMIN'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Importmodus; default `MERGE` (Req 12.16). */
export const IMPORT_MODES = ['MERGE', 'REPLACE'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

/** Herkunft: created by a connector (`IMPORT`) or via the Management_API (`MANUAL`). */
export const ORIGINS = ['IMPORT', 'MANUAL'] as const;
export type Origin = (typeof ORIGINS)[number];

/** Änderungsart of a version (Req 7.1). */
export const CHANGE_TYPES = ['CREATE', 'UPDATE', 'STATUS', 'RESTORE', 'IMPORT'] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

/** Agency state (Req 1.1). */
export const AGENCY_STATES = ['ACTIVE', 'SUSPENDED'] as const;
export type AgencyState = (typeof AGENCY_STATES)[number];

/** Roles within one agency (Req 1.2). */
export const AGENCY_ROLES = ['AGENCY_MEMBER', 'AGENCY_ADMIN'] as const;
export type AgencyRole = (typeof AGENCY_ROLES)[number];

export const ROLES = [...AGENCY_ROLES, 'PLATFORM_ADMIN'] as const;
export type Role = (typeof ROLES)[number];

/** All permissions (design: "Berechtigungsmodell"); role mapping lives in `permissions.ts`. */
export const PERMISSIONS = [
  'listing:read',
  'listing:write',
  'listing:status',
  'version:restore',
  'monitoring:read',
  'audit:read',
  'member:manage',
  'machine-access:manage',
  'agency:manage',
  'platform:operate',
  'monitoring:platform',
  'listing:assign',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Akteur of a change (Req 7.9). */
export type ActorRef =
  | { kind: 'user'; userId: string; displayName: string }
  | { kind: 'machine'; keyId: string; label: string }
  | { kind: 'connector'; connectorId: string; runId: string }
  | { kind: 'iam'; userArn: string };

/** Feldherkunft of one Inhaltsfeld: channel, actor and version of its last change (Req 7.2). */
export interface FieldSource {
  channel: Channel;
  actor: ActorRef;
  version: number;
}

/** Field sources keyed by content path; keys = `contentPaths(content)` after every write. */
export type FieldSources = Record<ContentPath, FieldSource>;

/** Versioned part of a listing: content plus status, Custom_Id and owning agency (Req 7.1). */
export interface VersionedState {
  content: ListingContent;
  status: ListingStatus;
  customId?: string;
  agencyId?: string;
}

/**
 * Deep subset where every field may be `null` ("remove field", only `MERGE`, Req 12.6). Objects
 * are resolved recursively, lists stay whole (they are one Inhaltsfeld each).
 */
export type DeepPartialNullable<T> = {
  [K in keyof T]?:
    | (T[K] extends readonly unknown[]
        ? T[K]
        : T[K] extends object
          ? DeepPartialNullable<T[K]>
          : T[K])
    | null;
};

/** Import_Datensatz after mapping: optional identity, status and any subset of Inhaltsfelder. */
export type ImportRecord = DeepPartialNullable<ListingContent> & {
  id?: string;
  customId?: string;
  status?: ListingStatus;
};

/** Authenticated actor of a Management_API call (Req 1.2, 1.3, 3.4). */
export type Principal =
  | {
      kind: 'user';
      userId: string;
      displayName: string;
      role: AgencyRole;
      agencyId: string;
    }
  | { kind: 'user'; userId: string; displayName: string; role: 'PLATFORM_ADMIN' }
  | { kind: 'machine'; keyId: string; label: string; agencyId: string; permissions: Permission[] };
