// Framework-free decisions of the manage bar of the public detail view (listing-manage.component):
// agency users and Plattform_Admins who are signed in to the portal in this tab can edit and
// (de)activate listings right from the search. Kept free of Angular for plain Jest tests.
import { MANUAL_SOURCE_PREFIX, type MeResponse } from '@open-estate/shared';

/** Manage permissions of a signed-in user. */
export interface ManageRights {
  /** "Edit listing" (`listing:write`). */
  edit: boolean;
  /** "Deactivate" / "Activate" (`listing:status`). */
  status: boolean;
}

export function manageRights(me: MeResponse | undefined): ManageRights {
  const permissions = me?.permissions ?? [];
  return {
    edit: permissions.includes('listing:write'),
    status: permissions.includes('listing:status'),
  };
}

/**
 * Whether to ask the Management_API if `me` may manage a public listing. The API decides (own
 * agency; Plattform_Admins: every agency); this only skips requests that must fail: without any
 * manage permission, and for manually created listings of another agency (their public `source`
 * names the owner, `agency:{agencyId}`). Imported listings name their connector, so they are
 * asked.
 */
export function worthAsking(me: MeResponse | undefined, listing: { source: string }): boolean {
  if (me === undefined) return false;
  const rights = manageRights(me);
  if (!rights.edit && !rights.status) return false;
  if (me.role === 'PLATFORM_ADMIN') return true;
  if (me.agencyId === undefined) return false;
  if (!listing.source.startsWith(MANUAL_SOURCE_PREFIX)) return true;
  return listing.source === `${MANUAL_SOURCE_PREFIX}${me.agencyId}`;
}
