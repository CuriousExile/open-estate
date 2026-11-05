import {
  createCachedSuspendedAgencies,
  InMemoryAgencyStore,
  ServiceUnavailableError,
  SUSPENDED_AGENCIES_PAGE_LIMIT,
  type AgencyRecord,
} from '@open-estate/core';

const agency = (agencyId: string, state: AgencyRecord['state']): AgencyRecord => ({
  agencyId,
  displayName: `Agency ${agencyId}`,
  state,
  createdAt: '2024-01-01T00:00:00Z',
  agencyAdmins: 1,
});

describe('createCachedSuspendedAgencies (Req 1.9)', () => {
  it('loads all suspended agencies over every page', async () => {
    const records = Array.from({ length: SUSPENDED_AGENCIES_PAGE_LIMIT + 2 }, (_, i) =>
      agency(`s-${String(i).padStart(5, '0')}`, 'SUSPENDED'),
    );
    const store = new InMemoryAgencyStore([...records, agency('active', 'ACTIVE')]);
    const listByState = jest.spyOn(store, 'listByState');
    const set = await createCachedSuspendedAgencies({ store }).current();
    expect([...set].sort()).toEqual(records.map((r) => r.agencyId));
    expect(listByState).toHaveBeenCalledTimes(2);
    expect(listByState.mock.calls.every(([state]) => state === 'SUSPENDED')).toBe(true);
  });

  it('serves the cached set for 60 s and reloads afterwards', async () => {
    let now = 0;
    const store = new InMemoryAgencyStore([agency('a', 'ACTIVE')]);
    const suspended = createCachedSuspendedAgencies({ store, clock: () => now });
    expect(await suspended.current()).toEqual(new Set());

    await store.update('a', { state: 'SUSPENDED' });
    now = 59_999;
    expect(await suspended.current()).toEqual(new Set());
    now = 60_000;
    expect(await suspended.current()).toEqual(new Set(['a']));
  });

  it('maps load failures and deadline overruns to ServiceUnavailableError without caching', async () => {
    const failing = { listByState: jest.fn().mockRejectedValueOnce(new Error('boom')) };
    failing.listByState.mockResolvedValue({ items: [agency('a', 'SUSPENDED')] });
    const suspended = createCachedSuspendedAgencies({ store: failing });
    await expect(suspended.current()).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(suspended.current()).resolves.toEqual(new Set(['a']));

    const hanging = { listByState: () => new Promise<never>(() => undefined) };
    await expect(
      createCachedSuspendedAgencies({ store: hanging, deadlineMs: 5 }).current(),
    ).rejects.toThrow('Suspended agencies could not be loaded');
  });
});
