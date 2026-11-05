import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  DynamoDbManagedListingStore,
  encodeKeyCursor,
  InMemoryAuditService,
  InMemoryDeletionBlocklistCheck,
  InMemoryListingKeyStore,
  InMemoryListingVersionStore,
  InMemoryManagedListingStore,
  InMemoryMetricCounterStore,
  InMemorySnapshotStore,
  InMemoryTransactor,
  InvalidCursorError,
  LISTING_QUERY_BATCH,
  LISTINGS_BY_AGENCY_INDEX,
  ListingQueryService,
  toManagedListingItem,
  VersionedListingWriter,
  VersionService,
  type AgencyActor,
  type ListingManagement,
  type StateChange,
} from '@open-estate/core';
import {
  applyDiff,
  CONTENT_FIELDS,
  contentHash,
  publicDetailUrl,
  type ActorRef,
  type Listing,
  type ListingContent,
  type Principal,
  type VersionedState,
} from '@open-estate/shared';
import { exampleListing } from '../../../shared/test/arbitraries';

const ORIGIN = 'https://www.example.org';
const USER: ActorRef = { kind: 'user', userId: 'u1', displayName: 'Ada' };
const CONNECTOR: ActorRef = { kind: 'connector', connectorId: 'crm', runId: 'run-1' };
const T0 = Date.parse('2026-03-01T10:00:00.000Z');

const actor = (principal: Principal, channel: AgencyActor['channel'] = 'PORTAL'): AgencyActor => ({
  principal,
  channel,
});
const member = (agencyId = 'agy-1') =>
  actor({ kind: 'user', userId: 'm1', displayName: 'M', role: 'AGENCY_MEMBER', agencyId });
const admin = actor(
  { kind: 'user', userId: 'pa', displayName: 'Root', role: 'PLATFORM_ADMIN' },
  'ADMIN',
);
const machineWithout = actor(
  { kind: 'machine', keyId: 'k1', label: 'CRM', agencyId: 'agy-1', permissions: ['listing:write'] },
  'API',
);

const toContent = (listing: Listing): ListingContent =>
  Object.fromEntries(
    CONTENT_FIELDS.flatMap((field) => (field in listing ? [[field, listing[field]]] : [])),
  ) as ListingContent;

const content = (id: string, overrides: Partial<Listing> = {}) =>
  toContent(exampleListing(id, overrides));

function setup() {
  let now = T0;
  const stores = {
    listings: new InMemoryManagedListingStore(),
    versions: new InMemoryListingVersionStore(),
    keys: new InMemoryListingKeyStore(),
    snapshots: new InMemorySnapshotStore(),
  };
  const writer = new VersionedListingWriter({
    ...stores,
    blocklist: new InMemoryDeletionBlocklistCheck(),
    counters: new InMemoryMetricCounterStore(),
    transactor: new InMemoryTransactor(),
    clock: () => now,
  });
  const audit = new InMemoryAuditService();
  const queries = new ListingQueryService({ ...stores, audit, frontendOrigin: ORIGIN });
  const versions = new VersionService({ ...stores, audit });

  /** Writes the next version of `listingId`; each write one minute after the previous one. */
  const write = async (listingId: string, next: VersionedState, imported = false) => {
    const current = await stores.listings.get(listingId);
    const change: StateChange = {
      listingId,
      expectedVersion: current?.management.version ?? null,
      next,
      changeType: imported ? 'IMPORT' : current === null ? 'CREATE' : 'UPDATE',
      channel: imported ? 'IMPORT' : 'PORTAL',
      actor: imported ? CONNECTOR : USER,
    };
    const result = await writer.write(change);
    if (!result.ok) throw new Error(`write failed: ${JSON.stringify(result.error)}`);
    now += 60_000;
  };
  return { ...stores, audit, queries, versions, write };
}

/** Cursor of a page that must have a next page. */
const nextOf = (page: { nextCursor?: string }): string => {
  if (page.nextCursor === undefined) throw new Error('expected a next page');
  return page.nextCursor;
};

const state = (c: ListingContent, overrides: Partial<VersionedState> = {}): VersionedState => ({
  content: c,
  status: 'ACTIVE',
  agencyId: 'agy-1',
  ...overrides,
});

describe('InMemoryManagedListingStore.query', () => {
  async function seeded() {
    const s = setup();
    await s.write('a', state(content('a', { title: 'Helle Wohnung' }), { customId: 'C-a' }));
    await s.write(
      'b',
      state(
        content('b', {
          title: 'Haus',
          translations: [{ locale: 'en', title: 'Bright HOUSE', description: '' }],
          offers: [{ offerType: 'RENT', coldRent: 900_00, currency: 'EUR' }],
          listingType: 'house',
        }),
        { status: 'INACTIVE' },
      ),
    );
    await s.write('c', state(content('c'), { agencyId: 'agy-2' }));
    await s.write('d', state(content('d')));
    // Without agency: only imported listings can have none (MANUAL needs an owner).
    await s.write('n', { content: content('n'), status: 'ACTIVE' }, true);
    return s;
  }

  it('lists only the agency, newest change first, and pages without gaps', async () => {
    const { listings } = await seeded();
    const first = await listings.query({ agencyId: 'agy-1' }, { limit: 2 });
    expect(first.items.map((m) => m.listing.id)).toEqual(['d', 'b']);
    expect(first.nextCursor).toBeDefined();
    const second = await listings.query({ agencyId: 'agy-1' }, { limit: 2, cursor: nextOf(first) });
    expect(second.items.map((m) => m.listing.id)).toEqual(['a']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('applies every filter; the title filter is case-insensitive over all language versions', async () => {
    const { listings } = await seeded();
    const ids = async (filter: Parameters<typeof listings.query>[0]) =>
      (await listings.query({ agencyId: 'agy-1', ...filter }, { limit: 10 })).items.map(
        (m) => m.listing.id,
      );
    expect(await ids({ status: 'INACTIVE' })).toEqual(['b']);
    expect(await ids({ origin: 'IMPORT' })).toEqual([]);
    expect((await listings.query({ origin: 'IMPORT' }, { limit: 10 })).items).toHaveLength(1);
    expect(await ids({ origin: 'MANUAL' })).toEqual(['d', 'b', 'a']);
    expect(await ids({ offerType: 'RENT' })).toEqual(['b']);
    expect(await ids({ listingType: 'house' })).toEqual(['b']);
    expect(await ids({ customId: 'C-a' })).toEqual(['a']);
    expect(await ids({ titleQuery: 'house' })).toEqual(['b']);
    expect(await ids({ titleQuery: 'HELLE' })).toEqual(['a']);
  });

  it('lists all listings, including those without agency, without agency filter', async () => {
    const { listings } = await seeded();
    const page = await listings.query({}, { limit: 10 });
    expect(page.items.map((m) => m.listing.id)).toEqual(['a', 'b', 'c', 'd', 'n']);
  });

  it('rejects cursors of another agency or another mode', async () => {
    const { listings } = await seeded();
    const page = await listings.query({ agencyId: 'agy-1' }, { limit: 1 });
    await expect(
      listings.query({ agencyId: 'agy-2' }, { limit: 1, cursor: nextOf(page) }),
    ).rejects.toThrow(InvalidCursorError);
    await expect(listings.query({}, { limit: 1, cursor: nextOf(page) })).rejects.toThrow(
      InvalidCursorError,
    );
  });
});

describe('DynamoDbManagedListingStore.query', () => {
  const client = () => DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
  const item = (id: string, overrides: Partial<ListingManagement> = {}, withAgency = true) => {
    const listing = exampleListing(id);
    const managed = toManagedListingItem(listing, {
      status: 'ACTIVE',
      agencyId: 'agy-1',
      origin: 'MANUAL',
      version: 1,
      contentHash: contentHash(listing),
      fieldSources: {},
      updatedAt: `2026-01-01T10:00:00.000Z`,
      ...overrides,
    });
    if (!withAgency) delete managed.agencyId;
    return managed;
  };

  it('queries the agency index with the agency in the key condition and equality filters', async () => {
    const c = client();
    const send = jest.spyOn(c, 'send').mockImplementation(async () => ({ Items: [item('a')] }));
    const store = new DynamoDbManagedListingStore({ client: c, tableName: 'Listings' });

    const page = await store.query({ agencyId: 'agy-1', status: 'ACTIVE' }, { limit: 20 });

    expect(page.items.map((m) => m.listing.id)).toEqual(['a']);
    expect(page.nextCursor).toBeUndefined();
    const command = send.mock.calls[0]?.[0] as QueryCommand;
    expect(command).toBeInstanceOf(QueryCommand);
    expect(command.input).toEqual({
      TableName: 'Listings',
      IndexName: LISTINGS_BY_AGENCY_INDEX,
      KeyConditionExpression: '#pk = :pk',
      FilterExpression: '#f_status = :f_status',
      ExpressionAttributeNames: { '#pk': 'agencyId', '#f_status': 'status' },
      ExpressionAttributeValues: { ':pk': 'agy-1', ':f_status': 'ACTIVE' },
      ScanIndexForward: false,
      Limit: LISTING_QUERY_BATCH,
    });
  });

  it('fills a page across reads and continues after the last returned item', async () => {
    const c = client();
    const lastKey = { id: 'b', agencyId: 'agy-1', updatedAt: '2026-01-01T10:00:00.000Z' };
    const send = jest
      .spyOn(c, 'send')
      .mockImplementationOnce(async () => ({ Items: [item('a')], LastEvaluatedKey: lastKey }))
      .mockImplementationOnce(async () => ({
        Items: [item('x', { status: 'INACTIVE' }), item('c'), item('d')],
        LastEvaluatedKey: { ...lastKey, id: 'd' },
      }));
    const store = new DynamoDbManagedListingStore({ client: c, tableName: 'Listings' });

    // `status` is also re-checked after parsing, so `x` is dropped even if DynamoDB returned it.
    const page = await store.query({ agencyId: 'agy-1', status: 'ACTIVE' }, { limit: 2 });

    expect(page.items.map((m) => m.listing.id)).toEqual(['a', 'c']);
    expect((send.mock.calls[1]?.[0] as QueryCommand).input.ExclusiveStartKey).toEqual(lastKey);
    expect(page.nextCursor).toBe(encodeKeyCursor({ ...lastKey, id: 'c' }));
  });

  it('matches the title filter after parsing and scans without agency', async () => {
    const c = client();
    const send = jest.spyOn(c, 'send').mockImplementation(async () => ({
      Items: [item('a'), item('b', {}, false)],
    }));
    const store = new DynamoDbManagedListingStore({ client: c, tableName: 'Listings' });

    const page = await store.query({ titleQuery: 'LISTING B' }, { limit: 20 });

    expect(page.items.map((m) => m.listing.id)).toEqual(['b']);
    const command = send.mock.calls[0]?.[0] as ScanCommand;
    expect(command).toBeInstanceOf(ScanCommand);
    expect(command.input).toEqual({ TableName: 'Listings', Limit: LISTING_QUERY_BATCH });
  });

  it('rejects a cursor of another agency before reading', async () => {
    const c = client();
    const send = jest.spyOn(c, 'send');
    const store = new DynamoDbManagedListingStore({ client: c, tableName: 'Listings' });
    const cursor = encodeKeyCursor({ id: 'a', agencyId: 'agy-2', updatedAt: 'x' });
    await expect(store.query({ agencyId: 'agy-1' }, { limit: 1, cursor })).rejects.toThrow(
      InvalidCursorError,
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe('ListingQueryService', () => {
  it('returns the full view by id regardless of status, with sourceUrlDerived', async () => {
    const s = setup();
    await s.write(
      'a',
      state(content('a', { sourceUrl: publicDetailUrl(ORIGIN, 'a') }), {
        status: 'INACTIVE',
        customId: 'C-a',
      }),
    );
    const result = await s.queries.get(member(), 'a');
    expect(result.ok && result.value).toMatchObject({
      id: 'a',
      status: 'INACTIVE',
      customId: 'C-a',
      origin: 'MANUAL',
      version: 1,
      sourceUrlDerived: true,
      content: { area: '75.00', offers: [{ price: '100000.00' }] },
    });
    expect(s.audit.entries).toEqual([]);
  });

  it('answers foreign and unknown listings alike with NOT_FOUND and audits the rejection', async () => {
    const s = setup();
    await s.write('a', state(content('a')));
    const foreign = await s.queries.get(member('agy-2'), 'a');
    const unknown = await s.queries.get(member('agy-2'), 'zzz');
    expect(foreign).toEqual(unknown);
    expect(foreign.ok || foreign.error[0]?.code).toBe('NOT_FOUND');
    expect(s.audit.entries.map((e) => [e.category, e.action, e.result])).toEqual([
      ['management', 'listing.get', 'NOT_FOUND'],
      ['management', 'listing.get', 'NOT_FOUND'],
    ]);
  });

  it('rejects actors without listing:read with FORBIDDEN as access-denied', async () => {
    const s = setup();
    await s.write('a', state(content('a')));
    const result = await s.queries.get(machineWithout, 'a');
    expect(result.ok || result.error[0]?.code).toBe('FORBIDDEN');
    expect(s.audit.entries[0]).toMatchObject({
      category: 'access-denied',
      action: 'listing.get',
      target: 'listing/a',
      result: 'FORBIDDEN',
    });
  });

  it('resolves a Custom_Id within the own agency; admins name the agency', async () => {
    const s = setup();
    await s.write('a', state(content('a'), { customId: 'C-1' }));
    await s.write('b', state(content('b'), { agencyId: 'agy-2', customId: 'C-1' }));

    const own = await s.queries.getByCustomId(member('agy-2'), 'C-1');
    expect(own.ok && own.value.id).toBe('b');
    const byAdmin = await s.queries.getByCustomId(admin, 'C-1', 'agy-1');
    expect(byAdmin.ok && byAdmin.value.id).toBe('a');
    const foreign = await s.queries.getByCustomId(member('agy-2'), 'C-1', 'agy-1');
    expect(foreign.ok || foreign.error[0]?.code).toBe('NOT_FOUND');
    const unknown = await s.queries.getByCustomId(member(), 'C-9');
    expect(unknown.ok || unknown.error[0]?.code).toBe('NOT_FOUND');
  });

  it('lists only the own agency for agency actors; admins filter by agency or list all', async () => {
    const s = setup();
    await s.write('a', state(content('a')));
    await s.write('b', state(content('b'), { agencyId: 'agy-2' }));
    const ids = (r: Awaited<ReturnType<typeof s.queries.list>>) =>
      r.ok ? r.value.items.map((i) => i.id) : r.error.map((e) => e.code);

    expect(ids(await s.queries.list(member(), {}, { limit: 10 }))).toEqual(['a']);
    expect(ids(await s.queries.list(member(), { agencyId: 'agy-2' }, { limit: 10 }))).toEqual([
      'NOT_FOUND',
    ]);
    expect(ids(await s.queries.list(admin, { agencyId: 'agy-2' }, { limit: 10 }))).toEqual(['b']);
    expect(ids(await s.queries.list(admin, {}, { limit: 10 }))).toEqual(['a', 'b']);

    const summary = await s.queries.list(member(), {}, { limit: 10 });
    expect(summary.ok && summary.value.items[0]).toEqual({
      id: 'a',
      title: 'Listing a',
      status: 'ACTIVE',
      origin: 'MANUAL',
      agencyId: 'agy-1',
      offerTypes: ['SALE'],
      listingType: 'apartment_unit',
      version: 1,
      updatedAt: '2026-03-01T10:00:00.000Z',
    });
  });
});

describe('VersionService', () => {
  async function history() {
    const s = setup();
    const v1 = content('a');
    await s.write('a', state(v1, { customId: 'C-1' }));
    await s.write('a', state(v1, { customId: 'C-1', status: 'INACTIVE' }));
    await s.write(
      'a',
      state(content('a', { offers: [{ offerType: 'SALE', price: 120_000_50, currency: 'EUR' }] }), {
        status: 'INACTIVE',
      }),
    );
    return s;
  }

  it('pages the history newest first with metadata and changed paths', async () => {
    const s = await history();
    const first = await s.versions.list(member(), 'a', { limit: 2 });
    expect(first.ok && first.value.items.map((v) => [v.version, v.status])).toEqual([
      [3, 'INACTIVE'],
      [2, 'INACTIVE'],
    ]);
    expect(first.ok && first.value.items[0]?.changedPaths.map((p) => p.path)).toEqual(['offers']);
    if (!first.ok) throw new Error('unexpected failure');
    const cursor = nextOf(first.value);
    const second = await s.versions.list(member(), 'a', { limit: 2, cursor });
    expect(second.ok && second.value.items).toMatchObject([
      { version: 1, changeType: 'CREATE', channel: 'PORTAL', actor: USER, customId: 'C-1' },
    ]);
  });

  it('returns a version with its snapshot content in the API representation', async () => {
    const s = await history();
    const result = await s.versions.get(member(), 'a', 3);
    expect(result.ok && result.value).toMatchObject({
      version: 3,
      changeType: 'UPDATE',
      content: { offers: [{ offerType: 'SALE', price: '120000.50', currency: 'EUR' }] },
    });
  });

  it('diffs any two versions in API values; applying the diff yields the target state', async () => {
    const s = await history();
    const result = await s.versions.diff(member(), 'a', 1, 3);
    expect(result.ok && result.value).toEqual({
      from: 1,
      to: 3,
      entries: [
        {
          op: 'change',
          path: ['content', 'offers', 0, 'price'],
          oldValue: '100000.00',
          value: '120000.50',
        },
        { op: 'remove', path: ['customId'], oldValue: 'C-1' },
        { op: 'change', path: ['status'], oldValue: 'ACTIVE', value: 'INACTIVE' },
      ],
    });

    const v1 = await s.versions.get(member(), 'a', 1);
    const v3 = await s.versions.get(member(), 'a', 3);
    if (!result.ok || !v1.ok || !v3.ok) throw new Error('unexpected failure');
    const asState = (v: typeof v1.value) =>
      ({
        content: v.content,
        status: v.status,
        ...(v.customId !== undefined && { customId: v.customId }),
        ...(v.agencyId !== undefined && { agencyId: v.agencyId }),
      }) as unknown as VersionedState;
    expect(applyDiff(asState(v1.value), result.value.entries)).toEqual(asState(v3.value));
  });

  it('answers unknown versions and foreign listings with NOT_FOUND and audits them', async () => {
    const s = await history();
    const missing = await s.versions.diff(member(), 'a', 1, 9);
    expect(missing.ok || missing.error[0]?.code).toBe('NOT_FOUND');
    const foreign = await s.versions.list(member('agy-2'), 'a', { limit: 10 });
    expect(foreign.ok || foreign.error[0]?.code).toBe('NOT_FOUND');
    const denied = await s.versions.get(machineWithout, 'a', 1);
    expect(denied.ok || denied.error[0]?.code).toBe('FORBIDDEN');
    expect(s.audit.entries.map((e) => [e.category, e.action, e.target])).toEqual([
      ['management', 'version.diff', 'listing/a/diff'],
      ['management', 'version.list', 'listing/a'],
      ['access-denied', 'version.get', 'listing/a/version/1'],
    ]);
  });
});
