import de from '../public/i18n/de.json';
import en from '../public/i18n/en.json';
import {
  actorDisplay,
  EMPTY_AUDIT_FILTERS,
  fetchAuditLog,
  isFailureResult,
  validateAuditFilters,
} from '../src/app/portal/audit/audit-model';
import { fakeCaller } from './portal-fake-caller';

describe('audit-log filters (Req 11.4, 11.5)', () => {
  it('sends only set filters, with the period as whole UTC days', () => {
    expect(
      validateAuditFilters({
        actor: ' u1 ',
        action: 'member.add',
        from: '2026-11-01',
        to: '2026-11-05',
      }),
    ).toEqual({
      ok: true,
      query: {
        actor: 'u1',
        action: 'member.add',
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-11-05T23:59:59.999Z',
      },
    });
    expect(validateAuditFilters(EMPTY_AUDIT_FILTERS)).toEqual({ ok: true, query: {} });
  });

  it('rejects malformed dates, a reversed period and overlong texts', () => {
    expect(validateAuditFilters({ ...EMPTY_AUDIT_FILTERS, from: '2026-02-31' })).toEqual({
      ok: false,
      errors: [{ field: 'from', messageKey: 'portal.audit.error.date' }],
    });
    expect(
      validateAuditFilters({ ...EMPTY_AUDIT_FILTERS, from: '2026-11-05', to: '2026-11-04' }),
    ).toEqual({
      ok: false,
      errors: [{ field: 'from', messageKey: 'portal.audit.error.reversed' }],
    });
    expect(validateAuditFilters({ ...EMPTY_AUDIT_FILTERS, action: 'a'.repeat(101) })).toEqual({
      ok: false,
      errors: [
        { field: 'action', messageKey: 'portal.audit.error.text', params: { min: 1, max: 100 } },
      ],
    });
  });

  it('a single day is a valid period', () => {
    expect(
      validateAuditFilters({ ...EMPTY_AUDIT_FILTERS, from: '2026-11-05', to: '2026-11-05' }),
    ).toMatchObject({ ok: true });
  });
});

describe('audit-log Management_API call (Req 11.5)', () => {
  it('queries /audit-log with filters and page token and parses the page', async () => {
    const entry = {
      id: 'e1',
      timestamp: '2026-11-05T10:00:00Z',
      actor: { kind: 'user', userId: 'u1', displayName: 'Ada' },
      channel: 'PORTAL',
      action: 'member.add',
      target: 'user/u2',
      agencyId: 'ag-1',
      result: 'success',
    };
    const { api, calls } = fakeCaller(() => ({ items: [entry], nextPageToken: 'n2' }));

    const result = await fetchAuditLog(api, { action: 'member.add' }, { pageToken: 'n1' });

    expect(calls).toEqual([
      { method: 'GET', path: '/audit-log', query: { action: 'member.add', pageToken: 'n1' } },
    ]);
    expect(result).toEqual({ ok: true, value: { items: [entry], nextPageToken: 'n2' } });
  });
});

describe('audit-log display', () => {
  it('names every kind of actor', () => {
    expect(actorDisplay({ kind: 'user', userId: 'u1', displayName: 'Ada' })).toEqual({
      kindKey: 'portal.audit.actorKind.user',
      name: 'Ada',
      id: 'u1',
    });
    expect(actorDisplay({ kind: 'machine', keyId: 'k1', label: 'CRM' })).toMatchObject({
      name: 'CRM',
      id: 'k1',
    });
    expect(actorDisplay({ kind: 'connector', connectorId: 'c1', runId: 'r1' })).toMatchObject({
      name: 'c1',
      id: 'r1',
    });
    expect(actorDisplay({ kind: 'iam', userArn: 'arn:aws:iam::1:user/x' })).toMatchObject({
      id: undefined,
    });
    expect(actorDisplay(undefined)).toBeUndefined();
  });

  it('highlights every result other than success', () => {
    expect(isFailureResult('success')).toBe(false);
    expect(isFailureResult('FORBIDDEN')).toBe(true);
  });

  it('has the same audit keys in both languages', () => {
    const keys = (catalog: object) =>
      Object.keys(catalog)
        .filter((k) => k.startsWith('portal.audit.'))
        .sort();
    expect(keys(en)).toEqual(keys(de));
    for (const kind of ['user', 'machine', 'connector', 'iam']) {
      expect((en as Record<string, string>)[`portal.audit.actorKind.${kind}`]).toBeTruthy();
    }
  });
});
