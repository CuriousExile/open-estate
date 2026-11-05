import de from '../public/i18n/de.json';
import en from '../public/i18n/en.json';
import { errorFields } from '../src/app/portal/shared/management-caller';
import {
  addMember,
  changeRole,
  EMPTY_INVITE,
  fetchMembers,
  inviteErrorsFromApi,
  MEMBER_ROLES,
  previewRemoval,
  removalImpact,
  removeMember,
  roleKey,
  upsertMember,
  validateInvite,
  type Member,
} from '../src/app/portal/team/team-model';
import { fakeCaller } from './portal-fake-caller';

const T = '2026-11-05T12:00:00.000Z';
const member = (userId: string, role: Member['role'] = 'AGENCY_MEMBER'): Member => ({
  userId,
  email: `${userId}@example.com`,
  displayName: `User ${userId}`,
  role,
  agencyId: 'ag-1',
  createdAt: T,
});

describe('team invitation (Req 1.5)', () => {
  it('sends the trimmed email and the chosen role', () => {
    expect(validateInvite({ email: ' new@example.com ', role: 'AGENCY_ADMIN' })).toEqual({
      ok: true,
      request: { email: 'new@example.com', role: 'AGENCY_ADMIN' },
    });
  });

  it('rejects an invalid email and a role outside the agency roles, one error per field', () => {
    expect(validateInvite({ email: 'no-at-sign', role: 'PLATFORM_ADMIN' })).toEqual({
      ok: false,
      errors: [
        { field: 'email', messageKey: 'portal.team.error.email' },
        { field: 'role', messageKey: 'portal.team.error.role' },
      ],
    });
    expect(validateInvite(EMPTY_INVITE)).toMatchObject({ ok: false, errors: [{ field: 'email' }] });
  });

  it('maps fields of a 400 answer to the form', () => {
    expect(
      inviteErrorsFromApi(
        errorFields({
          kind: 'api',
          status: 400,
          errors: [{ code: 'INVALID_PARAMETER', message: 'x', field: 'email' }],
        }),
      ),
    ).toEqual([{ field: 'email', messageKey: 'portal.team.error.email' }]);
  });
});

describe('team Management_API calls (Req 1.5–1.7)', () => {
  it('lists, adds, changes and removes members under the agency path', async () => {
    const { api, calls } = fakeCaller((call) =>
      call.method === 'GET'
        ? { items: [member('u1', 'AGENCY_ADMIN')], nextPageToken: 'n' }
        : call.method === 'DELETE' && call.query?.['dryRun'] === true
          ? { dryRun: true, affectedUsers: 1, affectedListings: 0 }
          : call.method === 'DELETE'
            ? undefined
            : member('u 2', 'AGENCY_ADMIN'),
    );

    const listed = await fetchMembers(api, 'ag/1', { pageToken: 'p' });
    expect(listed).toEqual({
      ok: true,
      value: { items: [member('u1', 'AGENCY_ADMIN')], nextPageToken: 'n' },
    });
    await addMember(api, 'ag/1', { email: 'a@example.com', role: 'AGENCY_MEMBER' });
    await changeRole(api, 'ag/1', 'u 2', { role: 'AGENCY_ADMIN' });
    const preview = await previewRemoval(api, 'ag/1', 'u 2');
    await removeMember(api, 'ag/1', 'u 2');

    expect(calls).toEqual([
      { method: 'GET', path: '/agencies/ag%2F1/members', query: { pageToken: 'p' } },
      {
        method: 'POST',
        path: '/agencies/ag%2F1/members',
        body: { email: 'a@example.com', role: 'AGENCY_MEMBER' },
      },
      {
        method: 'PATCH',
        path: '/agencies/ag%2F1/members/u%202',
        body: { role: 'AGENCY_ADMIN' },
      },
      { method: 'DELETE', path: '/agencies/ag%2F1/members/u%202', query: { dryRun: true } },
      { method: 'DELETE', path: '/agencies/ag%2F1/members/u%202' },
    ]);
    expect(preview.ok && removalImpact(preview.value)).toEqual([
      { key: 'portal.team.remove.affectedUsers', params: { count: 1 } },
      { key: 'portal.team.remove.affectedListings', params: { count: 0 } },
    ]);
  });

  it('replaces a changed member in place and appends a new one', () => {
    const list = [member('u1'), member('u2')];
    expect(upsertMember(list, member('u2', 'AGENCY_ADMIN')).map((m) => m.role)).toEqual([
      'AGENCY_MEMBER',
      'AGENCY_ADMIN',
    ]);
    expect(upsertMember(list, member('u3')).map((m) => m.userId)).toEqual(['u1', 'u2', 'u3']);
  });
});

describe('team translations (Req 5.7)', () => {
  it('has a label for every agency role in both languages', () => {
    for (const role of MEMBER_ROLES) {
      expect((en as Record<string, string>)[roleKey(role)]).toBeTruthy();
      expect((de as Record<string, string>)[roleKey(role)]).toBeTruthy();
    }
    expect(
      Object.keys(en)
        .filter((k) => k.startsWith('portal.team.'))
        .sort(),
    ).toEqual(
      Object.keys(de)
        .filter((k) => k.startsWith('portal.team.'))
        .sort(),
    );
  });
});
