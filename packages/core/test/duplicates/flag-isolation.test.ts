import { ListingQueryService, VersionService } from '@open-estate/core';
import { duplicateFlagOf } from '@open-estate/shared';
import { duplicatePlatform, member, ORIGIN, platformAdmin } from './support/duplicate-harness';

// Markierungen and Statusbegründungen never show listings of another agency to agency actors
// (duplicate-detection Req 7.6), also after a Treffer moved to another agency and before the next
// write or Duplikat_Abgleich renews the stored Markierung.

const content = (overrides: Record<string, unknown> = {}) => ({
  originalLocale: 'de',
  title: 'Helle Altbauwohnung mit Balkon',
  description: 'Drei Zimmer, Blick in den Hof.',
  translations: [],
  offers: [{ offerType: 'SALE', price: '350000.00', currency: 'EUR' }],
  listingType: 'apartment_unit',
  rooms: 3,
  area: '85.50',
  address: { city: 'Berlin', postalCode: '10115', country: 'DE', street: 'Hauptstraße 12' },
  media: [],
  tours: [],
  ...overrides,
});

async function setup() {
  const p = duplicatePlatform();
  const ids: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const created = await p.commands.create(member('agy-a'), { content: content() });
    if (!created.ok) throw new Error('create failed');
    ids.push(created.value.id);
  }
  const [first, second, third] = ids as [string, string, string];
  const queries = new ListingQueryService({
    listings: p.listings,
    keys: p.keys,
    audit: p.audit,
    frontendOrigin: ORIGIN,
  });
  const versions = new VersionService({
    listings: p.listings,
    versions: p.versions,
    snapshots: p.snapshots,
    audit: p.audit,
  });
  const move = async (id: string) => {
    const current = await p.get(id);
    const moved = await p.commands.assignAgency(platformAdmin, id, {
      agencyId: 'agy-b',
      baseVersion: current?.management.version,
    });
    if (!moved.ok) throw new Error('assign failed');
  };
  const view = async (id: string, principal = member('agy-a')) => {
    const result = await queries.get({ principal, channel: 'PORTAL' }, id);
    if (!result.ok) throw new Error('get failed');
    return result.value;
  };
  return { p, first, second, third, move, view, versions };
}

describe('Markierungen across a change of agency (Req 7.6)', () => {
  it('names the oldest remaining Treffer when the Original moved away', async () => {
    const { first, second, third, move, view } = await setup();
    expect(duplicateFlagOf((await view(third)).flags)?.originalId).toBe(first);
    await move(first);
    const flag = duplicateFlagOf((await view(third)).flags);
    expect(flag?.originalId).toBe(second);
    expect(flag?.matches.map((m) => m.listingId)).toEqual([second]);
    expect(JSON.stringify(await view(third))).not.toContain(first);
    // Plattform_Admins see the stored Markierung.
    expect(duplicateFlagOf((await view(third, platformAdmin)).flags)?.originalId).toBe(first);
  });

  it('shows no Markierung when every Treffer moved away', async () => {
    const { first, second, move, view } = await setup();
    await move(first);
    // `second` named only `first`.
    const shown = await view(second);
    expect(shown.flags).toEqual([]);
    expect(JSON.stringify(shown)).not.toContain(first);
  });

  it('hides a Statusbegründung naming a listing of another agency', async () => {
    const { first, second, move, versions } = await setup();
    const entries = async () => {
      const result = await versions.list(
        { principal: member('agy-a'), channel: 'PORTAL' },
        second,
        { limit: 10 },
      );
      if (!result.ok) throw new Error('versions failed');
      return result.value.items;
    };
    expect((await entries()).at(-1)?.statusReason).toEqual({
      code: 'DUPLICATE',
      originalId: first,
    });
    await move(first);
    expect((await entries()).at(-1)?.statusReason).toBeUndefined();
    const detail = await versions.get({ principal: member('agy-a'), channel: 'PORTAL' }, second, 1);
    expect(detail.ok && detail.value.statusReason).toBeUndefined();
  });
});
