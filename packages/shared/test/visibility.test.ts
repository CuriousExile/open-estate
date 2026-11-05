import { isPublic } from '../src';

describe('isPublic', () => {
  const suspended = new Set(['ag-suspended']);

  it.each([
    [{ status: 'ACTIVE' as const }, true],
    [{ status: 'ACTIVE' as const, agencyId: 'ag-active' }, true],
    [{ status: 'ACTIVE' as const, agencyId: 'ag-suspended' }, false],
    [{ status: 'INACTIVE' as const }, false],
    [{ status: 'INACTIVE' as const, agencyId: 'ag-active' }, false],
    [{ status: 'INACTIVE' as const, agencyId: 'ag-suspended' }, false],
  ])('%j → %s', (listing, expected) => {
    expect(isPublic(listing, suspended)).toBe(expected);
  });

  it('treats every ACTIVE listing as public when no agency is suspended', () => {
    expect(isPublic({ status: 'ACTIVE', agencyId: 'ag-suspended' }, new Set())).toBe(true);
  });
});
