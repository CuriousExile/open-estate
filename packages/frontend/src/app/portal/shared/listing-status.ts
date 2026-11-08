import { ListingView, type ListingStatus } from '@open-estate/shared';
import type { z } from 'zod';
import type { ManagementApiClient } from '../../management/management-api-client.service';
import type { ManagementError, ManagementResult } from '../../management/management-client';

/** A listing as the Management_API returns it (parsed). */
export type ManagedListing = z.output<typeof ListingView>;

// Activating and deactivating a listing (Req 6.2, 6.3, 6.5) — one model for the portal's listing
// table, the workspace and the manage bar of the public detail view. Deactivated listings leave
// every public result; activated ones come back with their current content. The Management_API
// checks `listing:status` and the agency (own listings; Plattform_Admins: all).

/** The status a toggle sets. */
export function nextStatus(current: ListingStatus): ListingStatus {
  return current === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
}

/** Label of the toggle for a listing in `current` ("Deactivate" / "Activate"). */
export function toggleLabelKey(current: ListingStatus): string {
  return current === 'ACTIVE' ? 'portal.status.deactivate' : 'portal.status.activate';
}

/** Accessible name of a toggle in a list, with the listing title as `{{title}}`. */
export function toggleNamedKey(current: ListingStatus): string {
  return current === 'ACTIVE' ? 'portal.status.deactivateNamed' : 'portal.status.activateNamed';
}

/** Label of the toggle in the workspace header ("Deactivate listing" / "Activate listing"). */
export function toggleListingKey(current: ListingStatus): string {
  return current === 'ACTIVE' ? 'portal.status.deactivateListing' : 'portal.status.activateListing';
}

/** Notice of the workspace after a change to `status`, with the new version as `{{version}}`. */
export function statusNoticeKey(status: ListingStatus): string {
  return status === 'ACTIVE' ? 'portal.status.changed.ACTIVE' : 'portal.status.changed.INACTIVE';
}

/** Confirmation after a change to `status`, with the listing title as `{{title}}`. */
export function statusChangedKey(status: ListingStatus): string {
  return status === 'ACTIVE' ? 'portal.status.activated' : 'portal.status.deactivated';
}

/** Body of `PUT /listings/{id}/status`; `baseVersion` detects a change in the meantime. */
export function statusRequest(
  status: ListingStatus,
  baseVersion: number | undefined,
): { status: ListingStatus; baseVersion?: number } {
  return { status, ...(baseVersion !== undefined && { baseVersion }) };
}

/** `PUT /listings/{id}/status`; resolves to the new state of the listing. */
export function setListingStatus(
  api: Pick<ManagementApiClient, 'put'>,
  id: string,
  status: ListingStatus,
  baseVersion: number | undefined,
  signal?: AbortSignal,
): Promise<ManagementResult<ManagedListing>> {
  return api.put(`/listings/${encodeURIComponent(id)}/status`, statusRequest(status, baseVersion), {
    ...(signal !== undefined && { signal }),
    parse: (value) => ListingView.parse(value),
  });
}

/** The listing was changed in the meantime (409 `VERSION_CONFLICT`): reload before retrying. */
export function isVersionConflict(error: ManagementError): boolean {
  return error.kind === 'api' && error.errors.some((e) => e.code === 'VERSION_CONFLICT');
}
