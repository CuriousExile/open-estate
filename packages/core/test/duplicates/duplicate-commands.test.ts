import { DuplicateIndexUnavailable, LISTING_COUNTER_CODES, agencyScope } from '@open-estate/core';
import type { ListingView } from '@open-estate/shared';
import { duplicatePlatform, machine, member, platformAdmin } from './support/duplicate-harness';

// Duplikat_Prüfung in the listing commands (duplicate-detection Req 5, 6, 7, 8, 9).

/** Listing_Inhalt of a manual creation (API representation, without source URL). */
const content = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
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

const AGENCY = 'agy-a';
const agent = member(AGENCY);

async function created(
  platform: ReturnType<typeof duplicatePlatform>,
  body: unknown,
): Promise<ListingView> {
  const result = await platform.commands.create(agent, body);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

describe('creation of a duplicate', () => {
  it('stores it INACTIVE with a Duplikat_Markierung; the first one stays online', async () => {
    const p = duplicatePlatform();
    const first = await created(p, { content: content(), status: 'ACTIVE' });
    // Same listing again, typed differently, without a source URL (derived per listing).
    const second = await created(p, {
      content: content({
        address: { city: 'Berlin', postalCode: '10115', country: 'DE', street: 'Haupt Str. 12' },
      }),
      status: 'ACTIVE',
    });

    expect(first.status).toBe('ACTIVE');
    expect(first.flags ?? []).toEqual([]);
    expect(second.status).toBe('INACTIVE');
    const [flag] = second.flags ?? [];
    expect(flag).toMatchObject({
      code: 'DUPLICATE',
      detectedBy: 'CREATE',
      originalId: first.id,
      matches: [{ listingId: first.id, reasons: ['EXACT'] }],
    });

    // Version 1 records why the status differs from the request (Req 5.4).
    const v1 = await p.versions.get(second.id, 1);
    expect(v1?.status).toBe('INACTIVE');
    expect(v1?.statusReason).toEqual({ code: 'DUPLICATE', originalId: first.id });
    expect((await p.versions.get(first.id, 1))?.statusReason).toBeUndefined();

    // Audit and counter (Req 7.7, 14.5).
    expect(p.audit.entries.map((e) => [e.action, e.details])).toContainEqual([
      'listing.flag.set',
      { flag: 'DUPLICATE', originalId: first.id, reasons: ['EXACT'] },
    ]);
    expect(await p.counters.get(agencyScope(AGENCY), LISTING_COUNTER_CODES.duplicateFlags)).toBe(1);
  });

  it('checks machine accesses and platform admins alike (Req 5.1)', async () => {
    const p = duplicatePlatform();
    await created(p, { content: content() });
    const viaMachine = await p.commands.create(machine(AGENCY), { content: content() });
    const viaAdmin = await p.commands.create(platformAdmin, {
      content: content(),
      agencyId: AGENCY,
    });
    expect(viaMachine.ok && viaMachine.value.flags?.[0]?.code).toBe('DUPLICATE');
    expect(viaAdmin.ok && viaAdmin.value.flags?.[0]?.code).toBe('DUPLICATE');
  });

  it('does not compare with listings of another agency (Req 4.1)', async () => {
    const p = duplicatePlatform();
    await created(p, { content: content() });
    const other = await p.commands.create(member('agy-b'), {
      content: content(),
      status: 'ACTIVE',
    });
    expect(other.ok && other.value.status).toBe('ACTIVE');
    expect(other.ok && other.value.flags).toEqual([]);
  });

  it('answers 503 and writes nothing when the Duplikat_Index is unavailable (Req 5.8)', async () => {
    const p = duplicatePlatform();
    jest.spyOn(p.detector, 'assess').mockRejectedValueOnce(new DuplicateIndexUnavailable('down'));
    const result = await p.commands.create(agent, { content: content() });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error[0]?.code).toBe('SERVICE_UNAVAILABLE');
    expect(p.listings.all()).toEqual([]);
  });
});

describe('changes and release', () => {
  it('flags an edited listing without taking it offline (Req 6.1, 6.2)', async () => {
    const p = duplicatePlatform();
    const first = await created(p, { content: content() });
    const other = await created(p, {
      content: content({
        address: { city: 'Berlin', postalCode: '10115', country: 'DE', street: 'Bahnhofstraße 3' },
      }),
      status: 'ACTIVE',
    });
    expect(other.flags).toEqual([]);

    const edited = await p.commands.replaceContent(agent, other.id, {
      content: content(),
      baseVersion: other.version,
    });

    expect(edited.ok && edited.value.status).toBe('ACTIVE');
    expect(edited.ok && edited.value.flags?.[0]).toMatchObject({
      detectedBy: 'UPDATE',
      originalId: first.id,
    });
  });

  it('releases a flagged listing on activation and never flags the pair again (Req 8.1, 8.3)', async () => {
    const p = duplicatePlatform();
    const first = await created(p, { content: content() });
    const second = await created(p, { content: content() });
    expect(second.status).toBe('INACTIVE');

    const released = await p.commands.setStatus(agent, second.id, { status: 'ACTIVE' });
    expect(released.ok && released.value.status).toBe('ACTIVE');
    expect(released.ok && released.value.flags).toEqual([]);
    expect((await p.index.getProfile(second.id))?.dismissed).toEqual([first.id]);
    expect(p.audit.entries.map((e) => e.action)).toContain('listing.flag.dismiss');

    // A later edit does not bring the Markierung back.
    const edited = await p.commands.replaceContent(agent, second.id, {
      content: content({ description: 'Drei Zimmer, Blick in den Hof. Neu gestrichen.' }),
      baseVersion: released.ok ? released.value.version : 0,
    });
    expect(edited.ok && edited.value.flags).toEqual([]);
    expect(await p.counters.get(agencyScope(AGENCY), LISTING_COUNTER_CODES.duplicateFlags)).toBe(0);
  });

  it('dismisses a Markierung without a version and without a status change (Req 8.2, 8.4)', async () => {
    const p = duplicatePlatform();
    const first = await created(p, { content: content() });
    const second = await created(p, { content: content() });

    const dismissed = await p.commands.dismissFlag(agent, second.id, 'DUPLICATE');
    expect(dismissed.ok && dismissed.value).toMatchObject({
      status: 'INACTIVE',
      version: second.version,
      flags: [],
    });
    expect((await p.index.getProfile(second.id))?.dismissed).toEqual([first.id]);

    // Without a Markierung the call succeeds without a change.
    const again = await p.commands.dismissFlag(agent, second.id, 'DUPLICATE');
    expect(again.ok && again.value.version).toBe(second.version);
    expect(p.audit.entries.at(-1)?.result).toBe('UNCHANGED');
  });

  it('leaves flags alone on status changes other than a release (Req 6.4, 8.6)', async () => {
    const p = duplicatePlatform();
    await created(p, { content: content() });
    const second = await created(p, { content: content() });
    const still = await p.commands.setStatus(agent, second.id, { status: 'INACTIVE' });
    expect(still.ok && still.value.flags?.[0]?.code).toBe('DUPLICATE');
  });
});

describe('Idempotenzschlüssel (Req 9.2-9.6)', () => {
  it('answers a repetition with the created listing and refuses another body', async () => {
    const p = duplicatePlatform();
    const body = { content: content() };
    const first = await p.commands.createWithKey(agent, body, 'crm-4711');
    const again = await p.commands.createWithKey(agent, body, 'crm-4711');
    expect(first.ok && first.value.replayed).toBe(false);
    expect(again.ok && again.value.replayed).toBe(true);
    expect(again.ok && again.value.view.id).toBe(first.ok ? first.value.view.id : '');
    expect(p.listings.all()).toHaveLength(1);

    const other = await p.commands.createWithKey(
      agent,
      { content: content({ rooms: 4 }) },
      'crm-4711',
    );
    expect(!other.ok && other.error[0]).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      field: 'Idempotency-Key',
    });
    expect(p.listings.all()).toHaveLength(1);

    // Another actor's key space is separate (Req 9.4); its listing is a flagged duplicate.
    const colleague = await p.commands.createWithKey(member(AGENCY, 'usr-2'), body, 'crm-4711');
    expect(colleague.ok && colleague.value.replayed).toBe(false);
    expect(p.listings.all()).toHaveLength(2);
  });

  it('rejects a malformed key before anything happens (Req 9.5)', async () => {
    const p = duplicatePlatform();
    const result = await p.commands.createWithKey(agent, { content: content() }, 'has space');
    expect(!result.ok && result.error[0]).toMatchObject({
      code: 'INVALID_PARAMETER',
      field: 'Idempotency-Key',
    });
    expect(p.listings.all()).toEqual([]);
  });
});
