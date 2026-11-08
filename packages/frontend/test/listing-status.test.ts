import type { MeResponse } from '@open-estate/shared';
import de from '../public/i18n/de.json';
import en from '../public/i18n/en.json';
import {
  clearSignedIn,
  markSignedIn,
  wasSignedIn,
  type KeyValueStorage,
} from '../src/app/auth/portal-auth-model';
import { manageRights, worthAsking } from '../src/app/listing/listing-manage-model';
import {
  isVersionConflict,
  nextStatus,
  setListingStatus,
  statusChangedKey,
  statusNoticeKey,
  statusRequest,
  toggleLabelKey,
  toggleListingKey,
  toggleNamedKey,
} from '../src/app/portal/shared/listing-status';

// Activating and deactivating listings (Req 6.2): portal table and workspace, and the manage bar
// of the public detail view for signed-in agency users and Plattform_Admins.

const STATUSES = ['ACTIVE', 'INACTIVE'] as const;

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  kind: 'user',
  id: 'u1',
  displayName: 'Anna',
  role: 'AGENCY_ADMIN',
  agencyId: 'agency-a',
  permissions: ['listing:read', 'listing:write', 'listing:status'],
  ...overrides,
});

describe('listing status model', () => {
  it('toggles between ACTIVE and INACTIVE', () => {
    expect(nextStatus('ACTIVE')).toBe('INACTIVE');
    expect(nextStatus('INACTIVE')).toBe('ACTIVE');
  });

  it('labels the action by what it does', () => {
    expect(toggleLabelKey('ACTIVE')).toBe('portal.status.deactivate');
    expect(toggleLabelKey('INACTIVE')).toBe('portal.status.activate');
    expect(toggleNamedKey('ACTIVE')).toBe('portal.status.deactivateNamed');
    expect(toggleListingKey('INACTIVE')).toBe('portal.status.activateListing');
  });

  it('has every text in every language', () => {
    const keys = STATUSES.flatMap((status) => [
      toggleLabelKey(status),
      toggleNamedKey(status),
      toggleListingKey(status),
      statusChangedKey(status),
      statusNoticeKey(status),
      `listingManage.state.${status}`,
    ]);
    keys.push('portal.status.saving', 'listingManage.title', 'listingManage.open');
    for (const translations of [en, de] as Record<string, string>[]) {
      for (const key of keys) expect(translations[key]).toEqual(expect.any(String));
    }
  });

  it('sends the Bezugsversion only if known', () => {
    expect(statusRequest('INACTIVE', 4)).toEqual({ status: 'INACTIVE', baseVersion: 4 });
    expect(statusRequest('ACTIVE', undefined)).toEqual({ status: 'ACTIVE' });
  });

  it('calls PUT /listings/{id}/status with an encoded id', async () => {
    const put = jest.fn().mockResolvedValue({ ok: false, error: { kind: 'aborted' } });
    await setListingStatus({ put }, 'a/b', 'INACTIVE', 2);
    expect(put).toHaveBeenCalledWith(
      '/listings/a%2Fb/status',
      { status: 'INACTIVE', baseVersion: 2 },
      expect.objectContaining({ parse: expect.any(Function) }),
    );
  });

  it('recognizes a version conflict', () => {
    expect(
      isVersionConflict({
        kind: 'api',
        status: 409,
        errors: [{ code: 'VERSION_CONFLICT', message: 'changed' }],
      }),
    ).toBe(true);
    expect(isVersionConflict({ kind: 'api', status: 403, errors: [] })).toBe(false);
    expect(isVersionConflict({ kind: 'network', message: 'offline' })).toBe(false);
  });
});

describe('manage bar of the public detail view', () => {
  const manual = (agencyId: string) => ({ source: `agency:${agencyId}` });
  const imported = { source: 'nordlicht-crm' };

  it('derives the controls from the permissions', () => {
    expect(manageRights(me())).toEqual({ edit: true, status: true });
    expect(manageRights(me({ permissions: ['listing:read'] }))).toEqual({
      edit: false,
      status: false,
    });
    expect(manageRights(undefined)).toEqual({ edit: false, status: false });
  });

  it('asks the Management API only where it can answer yes', () => {
    // Anonymous visitors: never.
    expect(worthAsking(undefined, manual('agency-a'))).toBe(false);
    // Own manual listing, and imports (the connector does not name the agency): ask.
    expect(worthAsking(me(), manual('agency-a'))).toBe(true);
    expect(worthAsking(me(), imported)).toBe(true);
    // A manual listing of another agency: no.
    expect(worthAsking(me(), manual('agency-b'))).toBe(false);
    // Platform admins manage every listing.
    expect(
      worthAsking(me({ role: 'PLATFORM_ADMIN', agencyId: undefined }), manual('agency-b')),
    ).toBe(true);
    // Without a manage permission (e.g. a read-only machine access): no.
    expect(worthAsking(me({ permissions: ['listing:read'] }), manual('agency-a'))).toBe(false);
  });
});

describe('sign-in flag of the tab', () => {
  const storage = (): KeyValueStorage => {
    const values = new Map<string, string>();
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    };
  };

  it('is set on sign-in and cleared on sign-out', () => {
    const tab = storage();
    expect(wasSignedIn(tab)).toBe(false);
    markSignedIn(tab);
    expect(wasSignedIn(tab)).toBe(true);
    clearSignedIn(tab);
    expect(wasSignedIn(tab)).toBe(false);
  });
});
