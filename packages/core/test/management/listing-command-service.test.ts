import {
  contentRules,
  customIdBlocklistKey,
  InMemoryAgencyStore,
  InMemoryAuditService,
  InMemoryDeletionBlocklistCheck,
  InMemoryListingKeyStore,
  InMemoryListingVersionStore,
  InMemoryManagedListingStore,
  InMemoryMetricCounterStore,
  InMemorySnapshotStore,
  InMemoryTransactor,
  ListingCommandService,
  manualContentSchema,
  VersionedListingWriter,
  type AgencyRecord,
} from '@open-estate/core';
import {
  assertValidTaxonomy,
  ManualContentInput,
  publicDetailUrl,
  type ApiError,
  type ListingContent,
  type Permission,
  type Principal,
  type Result,
  type Taxonomy,
} from '@open-estate/shared';

const ORIGIN = 'https://estate.example';
const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const TAXONOMY: Taxonomy = assertValidTaxonomy({
  groups: [{ code: 'residential', types: ['apartment_unit', 'house'] }],
});

const member: Principal = {
  kind: 'user',
  userId: 'u1',
  displayName: 'Ada',
  role: 'AGENCY_MEMBER',
  agencyId: 'a1',
};
const admin: Principal = {
  kind: 'user',
  userId: 'pa',
  displayName: 'Root',
  role: 'PLATFORM_ADMIN',
};
const machine = (permissions: Permission[]): Principal => ({
  kind: 'machine',
  keyId: 'k1',
  label: 'CRM',
  agencyId: 'a1',
  permissions,
});

const agency = (agencyId: string): AgencyRecord => ({
  agencyId,
  displayName: agencyId,
  state: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00.000Z',
  agencyAdmins: 1,
});

/** Listing_Inhalt in the API representation. */
const content = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  originalLocale: 'de',
  title: 'Altbau',
  description: '',
  translations: [],
  offers: [{ offerType: 'SALE', price: '250000.00', currency: 'EUR' }],
  listingType: 'apartment_unit',
  rooms: 3,
  area: '75.5',
  address: { city: 'Berlin', postalCode: '10115', country: 'DE' },
  media: [],
  tours: [],
  ...overrides,
});

function setup(taxonomy: Taxonomy = TAXONOMY) {
  let ids = 0;
  const stores = {
    listings: new InMemoryManagedListingStore(),
    versions: new InMemoryListingVersionStore(),
    keys: new InMemoryListingKeyStore(),
    blocklist: new InMemoryDeletionBlocklistCheck(),
    counters: new InMemoryMetricCounterStore(),
    snapshots: new InMemorySnapshotStore(),
  };
  const writer = new VersionedListingWriter({
    ...stores,
    transactor: new InMemoryTransactor(),
    clock: () => T0,
  });
  const audit = new InMemoryAuditService();
  const agencies = new InMemoryAgencyStore([agency('a1'), agency('a2')]);
  const service = (schemaTaxonomy: Taxonomy = taxonomy) =>
    new ListingCommandService({
      listings: stores.listings,
      versions: stores.versions,
      snapshots: stores.snapshots,
      agencies,
      writer,
      audit,
      frontendOrigin: ORIGIN,
      contentSchema: manualContentSchema(schemaTaxonomy),
      rules: contentRules({ tourProviders: { providers: [] } }),
      newId: () => `l${++ids}`,
    });
  return { ...stores, writer, audit, svc: service(), service };
}

function value<T>(result: Result<T, ApiError[]>): T {
  if (!result.ok) throw new Error(`Unexpected errors: ${JSON.stringify(result.error)}`);
  return result.value;
}

function errors<T>(result: Result<T, ApiError[]>): ApiError[] {
  if (result.ok) throw new Error('Expected errors');
  return result.error;
}

const lastAudit = (audit: InMemoryAuditService) => audit.entries.at(-1);

async function created(s: ReturnType<typeof setup>, body: Record<string, unknown> = {}) {
  return value(await s.svc.create(member, { content: content(), ...body }));
}

describe('ListingCommandService.create', () => {
  it('creates a MANUAL listing v1 in the actor agency, INACTIVE, with derived source URL', async () => {
    const s = setup();
    const view = await created(s, {
      content: content({ contact: { email: 'ada@example.org' } }),
      customId: 'C-1',
    });
    expect(view).toMatchObject({
      id: 'l1',
      origin: 'MANUAL',
      version: 1,
      status: 'INACTIVE',
      agencyId: 'a1',
      customId: 'C-1',
      sourceUrlDerived: true,
      source: 'agency:a1',
      lastRunId: 'PORTAL#1',
      droppedFields: ['contact.email'],
    });
    expect(view.content).toMatchObject({
      sourceUrl: publicDetailUrl(ORIGIN, 'l1'),
      offers: [{ offerType: 'SALE', price: '250000.00', currency: 'EUR' }],
      area: '75.50',
    });
    expect(view.content.contact).toEqual({});
    expect(view.fieldSources['title']).toMatchObject({ channel: 'PORTAL', version: 1 });
    // The view's content is a valid Management_API input again.
    expect(ManualContentInput.safeParse(view.content).success).toBe(true);
    expect(lastAudit(s.audit)).toMatchObject({
      category: 'management',
      action: 'listing.create',
      target: 'listing/l1',
      agencyId: 'a1',
      result: 'SUCCESS',
      channel: 'PORTAL',
    });
  });

  it('keeps a given source URL and status', async () => {
    const s = setup();
    const view = await created(s, {
      content: content({ sourceUrl: 'https://agency.example/1' }),
      status: 'ACTIVE',
    });
    expect(view).toMatchObject({ status: 'ACTIVE', sourceUrlDerived: false });
    expect(view.content.sourceUrl).toBe('https://agency.example/1');
    expect(view.droppedFields).toBeUndefined();
  });

  it('rejects invalid content with one error per field and stores nothing', async () => {
    const s = setup();
    const result = await s.svc.create(member, {
      content: content({ title: '', listingType: 'castle', area: 'x' }),
      unknown: true,
    });
    const fields = errors(result).map((e) => e.field ?? '');
    expect(fields).toEqual(
      expect.arrayContaining(['content.title', 'content.listingType', 'content.area']),
    );
    expect(errors(result).every((e) => e.code === 'INVALID_PARAMETER')).toBe(true);
    expect(s.listings.all()).toEqual([]);
    expect(lastAudit(s.audit)).toMatchObject({ result: 'INVALID_PARAMETER', target: 'listing' });
  });

  it('requires an existing agency for Plattform_Admins and writes channel ADMIN', async () => {
    const s = setup();
    expect(errors(await s.svc.create(admin, { content: content() }))).toEqual([
      expect.objectContaining({ code: 'INVALID_PARAMETER', field: 'agencyId' }),
    ]);
    expect(errors(await s.svc.create(admin, { content: content(), agencyId: 'zz' }))).toEqual([
      expect.objectContaining({ code: 'NOT_FOUND', field: 'agencyId' }),
    ]);
    const view = value(await s.svc.create(admin, { content: content(), agencyId: 'a2' }));
    expect(view).toMatchObject({ agencyId: 'a2', lastRunId: 'ADMIN#1' });
  });

  it('hides foreign agencies and checks the permission (machine channel API)', async () => {
    const s = setup();
    expect(
      errors(await s.svc.create(member, { content: content(), agencyId: 'a2' }))[0]?.code,
    ).toBe('NOT_FOUND');
    expect(errors(await s.svc.create(machine(['listing:read']), { content: content() }))).toEqual([
      expect.objectContaining({ code: 'FORBIDDEN' }),
    ]);
    expect(lastAudit(s.audit)).toMatchObject({ category: 'access-denied', result: 'FORBIDDEN' });
    const view = value(await s.svc.create(machine(['listing:write']), { content: content() }));
    expect(view.lastRunId).toBe('API#1');
  });

  it('maps Custom_Id conflicts and the deletion blocklist to 409', async () => {
    const s = setup();
    await created(s, { customId: 'C-1' });
    expect(errors(await s.svc.create(member, { content: content(), customId: 'C-1' }))).toEqual([
      expect.objectContaining({ code: 'CUSTOM_ID_TAKEN', field: 'customId' }),
    ]);
    s.blocklist.add(customIdBlocklistKey('a1', 'C-9'));
    expect(errors(await s.svc.create(member, { content: content(), customId: 'C-9' }))).toEqual([
      expect.objectContaining({ code: 'DELETION_BLOCKED', message: 'Löschsperre' }),
    ]);
    expect(lastAudit(s.audit)).toMatchObject({ result: 'DELETION_BLOCKED' });
  });
});

describe('ListingCommandService.replaceContent', () => {
  it('replaces the content as new version; Custom_Id absent = keep, null = remove', async () => {
    const s = setup();
    await created(s, { customId: 'C-1', status: 'ACTIVE' });
    const v2 = value(
      await s.svc.replaceContent(member, 'l1', {
        content: content({ title: 'Neubau' }),
        baseVersion: 1,
      }),
    );
    expect(v2).toMatchObject({ version: 2, customId: 'C-1', status: 'ACTIVE' });
    expect(v2.content.title).toBe('Neubau');
    expect(v2.content.sourceUrl).toBe(publicDetailUrl(ORIGIN, 'l1'));
    const v3 = value(
      await s.svc.replaceContent(member, 'l1', {
        content: content({ title: 'Neubau' }),
        customId: null,
        baseVersion: 2,
      }),
    );
    expect(v3.version).toBe(3);
    expect(v3.customId).toBeUndefined();
  });

  it('answers an unchanged content without a new version (audit UNCHANGED)', async () => {
    const s = setup();
    await created(s, { customId: 'C-1' });
    const view = value(
      await s.svc.replaceContent(member, 'l1', { content: content(), baseVersion: 1 }),
    );
    expect(view.version).toBe(1);
    expect(s.versions.all()).toHaveLength(1);
    expect(lastAudit(s.audit)).toMatchObject({ action: 'listing.update', result: 'UNCHANGED' });
  });

  it('rejects a stale base version with the current version (409)', async () => {
    const s = setup();
    await created(s);
    await s.svc.replaceContent(member, 'l1', { content: content({ title: 'B' }), baseVersion: 1 });
    expect(
      errors(
        await s.svc.replaceContent(member, 'l1', {
          content: content({ title: 'C' }),
          baseVersion: 1,
        }),
      ),
    ).toEqual([
      expect.objectContaining({ code: 'VERSION_CONFLICT', details: { currentVersion: 2 } }),
    ]);
  });

  it('returns 404 for unknown and foreign listings, 400 before 409', async () => {
    const s = setup();
    value(await s.svc.create(admin, { content: content(), agencyId: 'a2' }));
    const body = { content: content(), baseVersion: 1 };
    expect(errors(await s.svc.replaceContent(member, 'nope', body))[0]?.code).toBe('NOT_FOUND');
    expect(errors(await s.svc.replaceContent(member, 'l1', body))[0]?.code).toBe('NOT_FOUND');
    expect(
      errors(
        await s.svc.replaceContent(admin, 'l1', {
          content: content({ rooms: -1 }),
          baseVersion: 9,
        }),
      ),
    ).toEqual([expect.objectContaining({ code: 'INVALID_PARAMETER', field: 'content.rooms' })]);
    // Plattform_Admin may edit any agency's listing (Req 10.2).
    expect(
      value(
        await s.svc.replaceContent(admin, 'l1', {
          content: content({ title: 'X' }),
          baseVersion: 1,
        }),
      ).version,
    ).toBe(2);
  });

  it('keeps sourceUrl mandatory for IMPORT listings', async () => {
    const s = setup();
    const imported = await s.writer.write({
      listingId: 'imp-1',
      expectedVersion: null,
      next: {
        content: ManualContentInput.parse(
          content({ sourceUrl: 'https://crm.example/1' }),
        ) as ListingContent,
        status: 'ACTIVE',
        agencyId: 'a1',
      },
      changeType: 'IMPORT',
      channel: 'IMPORT',
      actor: { kind: 'connector', connectorId: 'crm', runId: 'r1' },
    });
    expect(imported.ok).toBe(true);
    expect(
      errors(await s.svc.replaceContent(member, 'imp-1', { content: content(), baseVersion: 1 })),
    ).toEqual([expect.objectContaining({ code: 'INVALID_PARAMETER', field: 'content.sourceUrl' })]);
  });
});

describe('ListingCommandService.setStatus', () => {
  it('creates a STATUS version and keeps content; same status = unchanged', async () => {
    const s = setup();
    await created(s);
    const view = value(await s.svc.setStatus(member, 'l1', { status: 'ACTIVE' }));
    expect(view).toMatchObject({ status: 'ACTIVE', version: 2 });
    expect(s.versions.all().map((v) => v.changeType)).toEqual(['CREATE', 'STATUS']);
    const again = value(await s.svc.setStatus(member, 'l1', { status: 'ACTIVE', baseVersion: 2 }));
    expect(again.version).toBe(2);
    expect(
      errors(await s.svc.setStatus(member, 'l1', { status: 'INACTIVE', baseVersion: 1 }))[0]?.code,
    ).toBe('VERSION_CONFLICT');
    expect(errors(await s.svc.setStatus(member, 'l1', { status: 'DRAFT' }))[0]).toMatchObject({
      code: 'INVALID_PARAMETER',
      field: 'status',
    });
  });
});

describe('ListingCommandService.assignAgency', () => {
  it('lets a Plattform_Admin move a listing; agency actors are refused', async () => {
    const s = setup();
    await created(s, { customId: 'C-1' });
    expect(
      errors(await s.svc.assignAgency(member, 'l1', { agencyId: 'a2', baseVersion: 1 }))[0]?.code,
    ).toBe('FORBIDDEN');
    expect(
      errors(await s.svc.assignAgency(admin, 'l1', { agencyId: 'zz', baseVersion: 1 }))[0],
    ).toMatchObject({ code: 'NOT_FOUND', field: 'agencyId' });
    const view = value(await s.svc.assignAgency(admin, 'l1', { agencyId: 'a2', baseVersion: 1 }));
    expect(view).toMatchObject({
      agencyId: 'a2',
      source: 'agency:a2',
      version: 2,
      customId: 'C-1',
    });
    expect(s.versions.all().at(-1)).toMatchObject({ changeType: 'UPDATE', channel: 'ADMIN' });
    expect(lastAudit(s.audit)).toMatchObject({ action: 'listing.assign', agencyId: 'a2' });
  });
});

describe('ListingCommandService.restore', () => {
  async function history(s: ReturnType<typeof setup>) {
    await created(s, { customId: 'C-1' });
    await s.svc.replaceContent(member, 'l1', {
      content: content({ title: 'Neu', listingType: 'house' }),
      baseVersion: 1,
    });
    await s.svc.setStatus(member, 'l1', { status: 'ACTIVE', baseVersion: 2 });
  }

  it('restores the content of a version and keeps status, Custom_Id and agency', async () => {
    const s = setup();
    await history(s);
    const view = value(await s.svc.restore(member, 'l1', { version: 1, baseVersion: 3 }));
    expect(view).toMatchObject({ version: 4, status: 'ACTIVE', customId: 'C-1', agencyId: 'a1' });
    expect(view.content).toMatchObject({ title: 'Altbau', listingType: 'apartment_unit' });
    expect(s.versions.all().at(-1)).toMatchObject({ changeType: 'RESTORE', restoredFrom: 1 });
    expect(s.versions.all()[0]?.contentHash).toBe(s.versions.all().at(-1)?.contentHash);
  });

  it('rejects unknown versions, stale base versions and content invalid under current rules', async () => {
    const s = setup();
    await history(s);
    expect(
      errors(await s.svc.restore(member, 'l1', { version: 9, baseVersion: 3 }))[0],
    ).toMatchObject({
      code: 'NOT_FOUND',
      field: 'version',
    });
    expect(errors(await s.svc.restore(member, 'l1', { version: 1, baseVersion: 2 }))[0]?.code).toBe(
      'VERSION_CONFLICT',
    );
    const narrowed = s.service(
      assertValidTaxonomy({ groups: [{ code: 'residential', types: ['house'] }] }),
    );
    expect(errors(await narrowed.restore(member, 'l1', { version: 1, baseVersion: 3 }))).toEqual([
      expect.objectContaining({ code: 'INVALID_PARAMETER', field: 'content.listingType' }),
    ]);
    expect(s.versions.all()).toHaveLength(3);
  });

  it('requires version:restore', async () => {
    const s = setup();
    await created(s);
    const reader = machine(['listing:read', 'listing:write']);
    expect(errors(await s.svc.restore(reader, 'l1', { version: 1, baseVersion: 1 }))[0]?.code).toBe(
      'FORBIDDEN',
    );
  });
});
