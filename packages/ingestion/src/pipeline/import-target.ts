import {
  customIdBlocklistKey,
  NO_AGENCY_SCOPE_ID,
  type ListingKeyStore,
  type ManagedListing,
  type ManagedListingStore,
} from '@open-estate/core';
import type { DeletionBlocklist } from './deletion-blocklist';

// Step 2 of `ImportPipeline.process` (design: "Import-Pipeline", Req 12.2–12.5, 12.12–12.14):
// determines the target listing of an Import_Datensatz. Reads only; writes nothing.

/** Read interface of the identity resolution; the stores' write operations are not needed. */
export interface ImportTargetReader {
  readonly listings: Pick<ManagedListingStore<unknown>, 'get'>;
  readonly keys: Pick<ListingKeyStore<unknown>, 'get'>;
  /** Holds listing ids and Custom_Id keys (`custom#{owner}#{customId}`) in one key space. */
  readonly blocklist: DeletionBlocklist;
}

/** Identity fields of a mapped Import_Datensatz. */
export interface ImportIdentity {
  readonly id?: string;
  readonly customId?: string;
}

/** The connector the record comes from (Req 12.1: at most one agency). */
export interface ImportConnectorScope {
  readonly connectorId: string;
  readonly agencyId?: string;
}

export type ImportTargetRejectionCode =
  'IDENTITY_MISSING' | 'IDENTITY_CONFLICT' | 'DELETION_BLOCKED' | 'FOREIGN_AGENCY';

/** Log reasons as named by the requirements. */
export const IMPORT_TARGET_REJECTION_REASONS: Readonly<Record<ImportTargetRejectionCode, string>> =
  {
    IDENTITY_MISSING: 'Identität fehlt',
    IDENTITY_CONFLICT: 'Identitätskonflikt',
    // Equals `DELETION_BLOCK_REASON` (import-pipeline); literal to avoid an import cycle once the
    // pipeline calls this function.
    DELETION_BLOCKED: 'Löschsperre',
    FOREIGN_AGENCY: 'Fremde Agentur',
  };

export type ImportTarget =
  /** Existing listing; write with `expectedVersion`. `claimAgency`: set the connector's agency (Req 12.13). */
  | {
      readonly kind: 'update';
      readonly listing: ManagedListing;
      readonly expectedVersion: number;
      readonly claimAgency: boolean;
    }
  /** No target: create a listing with this id (Req 12.5). */
  | { readonly kind: 'create'; readonly id: string }
  /** `listingId`: the id the rejection is attributed to, if any (Req 12.3, 12.12). */
  | {
      readonly kind: 'reject';
      readonly code: ImportTargetRejectionCode;
      readonly reason: string;
      readonly listingId?: string;
    };

const reject = (code: ImportTargetRejectionCode, listingId?: string): ImportTarget => ({
  kind: 'reject',
  code,
  reason: IMPORT_TARGET_REJECTION_REASONS[code],
  ...(listingId === undefined ? {} : { listingId }),
});

/**
 * `resolveImportTarget` (design: "Import-Pipeline", step 2). Order:
 * 1. neither `id` nor `customId` → „Identität fehlt“ (Req 12.4);
 * 2. `byId` = listing with `id`; `byCustom` = listing id assigned to `customId` within the
 *    connector's agency (agency-less connectors: owner `_none`, as the writer keys them);
 * 3. both present and different → „Identitätskonflikt“ (Req 12.3, 12.14);
 * 4. target = `byId ?? byCustom` (Req 12.2);
 * 5. `id` or `custom#{owner}#{customId}` blocked → „Löschsperre“ (Req 12.14);
 * 6. no target → create with `id ?? newId()` (Req 12.5);
 * 7. target of another agency, or agency-less connector vs. listing with agency → „Fremde
 *    Agentur“ (Req 12.12); agency-less target of the same source and connector with agency →
 *    update with `claimAgency` (Req 12.13).
 *
 * A Custom_Id key whose listing no longer exists counts as the id of the listing to create, so
 * the writer's key assignment cannot fail; a different supplied `id` is then a conflict.
 * An agency-less listing of another source is not taken over by an agency connector („Fremde
 * Agentur“): it stays managed by Plattform_Admins only (Req 12.1).
 */
export async function resolveImportTarget(
  record: ImportIdentity,
  connector: ImportConnectorScope,
  reader: ImportTargetReader,
  newId: () => string,
): Promise<ImportTarget> {
  const { id, customId } = record;
  if (id === undefined && customId === undefined) return reject('IDENTITY_MISSING');

  const owner = connector.agencyId ?? NO_AGENCY_SCOPE_ID;
  const [byId, byCustomId] = await Promise.all([
    id === undefined ? null : reader.listings.get(id),
    customId === undefined ? null : reader.keys.get(owner, customId),
  ]);
  const byCustom =
    byId === null && byCustomId !== null ? await reader.listings.get(byCustomId) : null;

  // `byCustom` is only read without `byId`, so `byCustom === null` here means: `id` names an
  // existing listing, or the Custom_Id key is dangling. Either way `id` and the Custom_Id point
  // to two different listings.
  if (id !== undefined && byCustomId !== null && byCustomId !== id && byCustom === null)
    return reject('IDENTITY_CONFLICT', id);

  const target = byId ?? byCustom;
  const blocked = await Promise.all([
    id === undefined ? false : reader.blocklist.has(id),
    customId === undefined ? false : reader.blocklist.has(customIdBlocklistKey(owner, customId)),
  ]);
  if (blocked.some(Boolean)) return reject('DELETION_BLOCKED', target?.listing.id ?? id);

  if (target === null) return { kind: 'create', id: id ?? byCustomId ?? newId() };

  const targetAgency = target.management.agencyId;
  const update = (claimAgency: boolean): ImportTarget => ({
    kind: 'update',
    listing: target,
    expectedVersion: target.management.version,
    claimAgency,
  });
  if (targetAgency === connector.agencyId) return update(false);
  if (
    targetAgency === undefined &&
    connector.agencyId !== undefined &&
    target.listing.source === connector.connectorId
  )
    return update(true);
  return reject('FOREIGN_AGENCY', target.listing.id);
}
