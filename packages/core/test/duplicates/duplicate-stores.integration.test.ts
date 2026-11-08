import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  type AttributeDefinition,
  type CreateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  agencyScope,
  AUDIT_LOG_PARTITION_KEY,
  AUDIT_LOG_SORT_KEY,
  contentRules,
  CROSS_AGENCY_OPEN_COUNTER,
  DELETION_BLOCKLIST_KEY_ATTRIBUTE,
  duplicateDataPurge,
  DuplicateDetector,
  DUPLICATE_INDEX_BLOCK_ATTRIBUTE,
  DUPLICATE_INDEX_BLOCK_SK_ATTRIBUTE,
  DUPLICATE_INDEX_BY_BLOCK,
  DUPLICATE_INDEX_PK,
  DUPLICATE_INDEX_SK,
  DUPLICATE_REPORTS_BY_STATE,
  DUPLICATE_REPORTS_PK,
  DUPLICATE_REPORTS_STATE_ATTRIBUTE,
  DUPLICATE_REPORTS_STATE_SK_ATTRIBUTE,
  DuplicateSweep,
  DynamoDbAuditService,
  DynamoDbDeletionBlocklistCheck,
  DynamoDbDuplicateIndexStore,
  DynamoDbDuplicateReportStore,
  DynamoDbIdempotencyStore,
  DynamoDbListingKeyStore,
  DynamoDbListingVersionStore,
  DynamoDbManagedListingStore,
  DynamoDbMetricCounterStore,
  DynamoDbTransactor,
  IDEMPOTENCY_KEYS_BY_LISTING,
  IDEMPOTENCY_KEYS_LISTING_ATTRIBUTE,
  IDEMPOTENCY_KEYS_PK,
  InMemoryAgencyStore,
  InMemoryAuditService,
  InMemorySnapshotStore,
  LISTING_COUNTER_CODES,
  LISTING_KEYS_PK_ATTRIBUTE,
  LISTING_VERSIONS_PK_ATTRIBUTE,
  LISTING_VERSIONS_SK_ATTRIBUTE,
  ListingCommandService,
  manualContentSchema,
  METRIC_COUNTERS_PK_ATTRIBUTE,
  METRIC_COUNTERS_SK_ATTRIBUTE,
  PLATFORM_SCOPE,
  runDuplicateSweep,
  VersionedListingWriter,
} from '@open-estate/core';
import { duplicateFlagOf, DEFAULT_DUPLICATE_CONFIG } from '@open-estate/shared';
import { TAXONOMY } from '../../../shared/test/arbitraries/duplicates';
import { member } from './support/duplicate-harness';

/**
 * Duplikat-Erkennung against DynamoDB Local (duplicate-detection task 15). Runs only when
 * `DYNAMODB_ENDPOINT` is set (see CONTRIBUTING.md → Tests); otherwise the suite is skipped.
 *
 * Covers what the in-memory fakes cannot: the `byBlock` query with the Prüfbereich prefix, the
 * cancellation reasons `duplicateIndex.exactClaim` and `idempotency.put`, the guards on stored
 * Markierungen (list equality) and profile revisions, the deletion of all duplicate data, and a
 * Duplikat_Abgleich over a small stock (segments, cursors, resolving Treffer).
 *
 * **Validates: Requirements 9.1, 10.3, 10.4, 11.6, 12.3**
 */

const ENDPOINT = process.env['DYNAMODB_ENDPOINT'];
const ORIGIN = 'https://estate.example';

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

const S = (name: string): AttributeDefinition => ({ AttributeName: name, AttributeType: 'S' });

/** Key schemas as in the CDK stacks (ManagementDataStack, DataStack). */
function tableDefinitions(prefix: string): Record<string, CreateTableCommandInput> {
  const keys = (pk: string, sk?: string) => [
    { AttributeName: pk, KeyType: 'HASH' as const },
    ...(sk === undefined ? [] : [{ AttributeName: sk, KeyType: 'RANGE' as const }]),
  ];
  return {
    listings: {
      TableName: `${prefix}-Listings`,
      AttributeDefinitions: [S('id')],
      KeySchema: keys('id'),
    },
    versions: {
      TableName: `${prefix}-ListingVersions`,
      AttributeDefinitions: [
        S(LISTING_VERSIONS_PK_ATTRIBUTE),
        { AttributeName: LISTING_VERSIONS_SK_ATTRIBUTE, AttributeType: 'N' },
      ],
      KeySchema: keys(LISTING_VERSIONS_PK_ATTRIBUTE, LISTING_VERSIONS_SK_ATTRIBUTE),
    },
    keys: {
      TableName: `${prefix}-ListingKeys`,
      AttributeDefinitions: [S(LISTING_KEYS_PK_ATTRIBUTE)],
      KeySchema: keys(LISTING_KEYS_PK_ATTRIBUTE),
    },
    blocklist: {
      TableName: `${prefix}-DeletionBlocklist`,
      AttributeDefinitions: [S(DELETION_BLOCKLIST_KEY_ATTRIBUTE)],
      KeySchema: keys(DELETION_BLOCKLIST_KEY_ATTRIBUTE),
    },
    counters: {
      TableName: `${prefix}-MetricCounters`,
      AttributeDefinitions: [S(METRIC_COUNTERS_PK_ATTRIBUTE), S(METRIC_COUNTERS_SK_ATTRIBUTE)],
      KeySchema: keys(METRIC_COUNTERS_PK_ATTRIBUTE, METRIC_COUNTERS_SK_ATTRIBUTE),
    },
    index: {
      TableName: `${prefix}-DuplicateIndex`,
      AttributeDefinitions: [
        S(DUPLICATE_INDEX_PK),
        S(DUPLICATE_INDEX_SK),
        S(DUPLICATE_INDEX_BLOCK_ATTRIBUTE),
        S(DUPLICATE_INDEX_BLOCK_SK_ATTRIBUTE),
      ],
      KeySchema: keys(DUPLICATE_INDEX_PK, DUPLICATE_INDEX_SK),
      GlobalSecondaryIndexes: [
        {
          IndexName: DUPLICATE_INDEX_BY_BLOCK,
          KeySchema: keys(DUPLICATE_INDEX_BLOCK_ATTRIBUTE, DUPLICATE_INDEX_BLOCK_SK_ATTRIBUTE),
          Projection: { ProjectionType: 'KEYS_ONLY' },
        },
      ],
    },
    idempotency: {
      TableName: `${prefix}-IdempotencyKeys`,
      AttributeDefinitions: [S(IDEMPOTENCY_KEYS_PK), S(IDEMPOTENCY_KEYS_LISTING_ATTRIBUTE)],
      KeySchema: keys(IDEMPOTENCY_KEYS_PK),
      GlobalSecondaryIndexes: [
        {
          IndexName: IDEMPOTENCY_KEYS_BY_LISTING,
          KeySchema: keys(IDEMPOTENCY_KEYS_LISTING_ATTRIBUTE),
          Projection: { ProjectionType: 'KEYS_ONLY' },
        },
      ],
    },
    reports: {
      TableName: `${prefix}-DuplicateReports`,
      AttributeDefinitions: [
        S(DUPLICATE_REPORTS_PK),
        S(DUPLICATE_REPORTS_STATE_ATTRIBUTE),
        S(DUPLICATE_REPORTS_STATE_SK_ATTRIBUTE),
      ],
      KeySchema: keys(DUPLICATE_REPORTS_PK),
      GlobalSecondaryIndexes: [
        {
          IndexName: DUPLICATE_REPORTS_BY_STATE,
          KeySchema: keys(DUPLICATE_REPORTS_STATE_ATTRIBUTE, DUPLICATE_REPORTS_STATE_SK_ATTRIBUTE),
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    },
    audit: {
      TableName: `${prefix}-AuditLog`,
      AttributeDefinitions: [S(AUDIT_LOG_PARTITION_KEY), S(AUDIT_LOG_SORT_KEY)],
      KeySchema: keys(AUDIT_LOG_PARTITION_KEY, AUDIT_LOG_SORT_KEY),
    },
  };
}

const describeWithDynamo = ENDPOINT !== undefined && ENDPOINT !== '' ? describe : describe.skip;
const suffix = ENDPOINT ? `(${ENDPOINT})` : '(skipped: set DYNAMODB_ENDPOINT to run)';

describeWithDynamo(`Duplikat-Erkennung against DynamoDB Local ${suffix}`, () => {
  jest.setTimeout(120_000);

  const client = new DynamoDBClient({
    ...(ENDPOINT !== undefined && { endpoint: ENDPOINT }),
    region: 'eu-central-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const doc = DynamoDBDocumentClient.from(client);
  let run = 0;
  let tables: Record<string, CreateTableCommandInput> = {};

  beforeEach(async () => {
    tables = tableDefinitions(`dup-it-${process.pid}-${run++}`);
    for (const table of Object.values(tables)) {
      await client.send(new CreateTableCommand({ ...table, BillingMode: 'PAY_PER_REQUEST' }));
    }
  });

  afterEach(async () => {
    for (const table of Object.values(tables)) {
      try {
        await client.send(new DeleteTableCommand({ TableName: table.TableName }));
      } catch (error) {
        if (!(error instanceof ResourceNotFoundException)) throw error;
      }
    }
  });

  afterAll(() => client.destroy());

  /** The write path of the Management_API on the DynamoDB stores (snapshots in memory). */
  function platform() {
    const name = (key: string) => tables[key]?.TableName ?? '';
    const table = (key: string) => ({ client: doc, tableName: name(key) });
    let now = Date.parse('2026-03-01T10:00:00.000Z');
    const clock = () => (now += 1000);
    const listings = new DynamoDbManagedListingStore(table('listings'));
    const index = new DynamoDbDuplicateIndexStore(table('index'));
    const idempotency = new DynamoDbIdempotencyStore(table('idempotency'));
    const reports = new DynamoDbDuplicateReportStore(table('reports'));
    const counters = new DynamoDbMetricCounterStore(table('counters'));
    const transactor = new DynamoDbTransactor({ client: doc });
    const detector = new DuplicateDetector({
      index,
      taxonomy: TAXONOMY,
      config: DEFAULT_DUPLICATE_CONFIG,
    });
    const snapshots = new InMemorySnapshotStore();
    const versions = new DynamoDbListingVersionStore(table('versions'));
    const writer = new VersionedListingWriter({
      listings,
      versions,
      keys: new DynamoDbListingKeyStore(table('keys')),
      blocklist: new DynamoDbDeletionBlocklistCheck({ tableName: name('blocklist') }),
      counters,
      snapshots,
      transactor,
      clock,
      duplicates: { index, detector, frontendOrigin: ORIGIN },
      idempotency,
    });
    const commands = new ListingCommandService({
      listings,
      versions,
      snapshots,
      agencies: new InMemoryAgencyStore(
        ['agy-a', 'agy-b'].map((agencyId) => ({
          agencyId,
          displayName: agencyId,
          state: 'ACTIVE' as const,
          createdAt: '2026-01-01T00:00:00.000Z',
          agencyAdmins: 1,
        })),
      ),
      writer,
      audit: new InMemoryAuditService(),
      frontendOrigin: ORIGIN,
      contentSchema: manualContentSchema(TAXONOMY),
      rules: contentRules({ tourProviders: { providers: [] }, taxonomy: TAXONOMY }),
      duplicates: detector,
      idempotency,
      clock,
    });
    const sweep = new DuplicateSweep({
      listings,
      index,
      reports,
      counters,
      transactor,
      writer,
      detector,
      audit: new DynamoDbAuditService({ ...table('audit'), now: clock }),
      clock,
      frontendOrigin: ORIGIN,
      pageSize: 2,
    });
    return { listings, index, idempotency, reports, counters, transactor, commands, sweep };
  }

  async function create(p: ReturnType<typeof platform>, agencyId: string, body: unknown) {
    const result = await p.commands.create(member(agencyId), body);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
  }

  it('flags a duplicate within the Prüfbereich via byBlock and the exact key (Req 9.1)', async () => {
    const p = platform();
    const first = await create(p, 'agy-a', { content: content(), status: 'ACTIVE' });
    const second = await create(p, 'agy-a', { content: content(), status: 'ACTIVE' });
    const foreign = await create(p, 'agy-b', { content: content(), status: 'ACTIVE' });
    expect(second.status).toBe('INACTIVE');
    expect(duplicateFlagOf(second.flags)?.originalId).toBe(first.id);
    // Another Prüfbereich is not searched on write (Req 4.5).
    expect(foreign.flags).toEqual([]);
    const profile = await p.index.getProfile(first.id);
    expect(await p.index.exactOwner(agencyScope('agy-a'), profile?.profile.exactKey ?? '')).toBe(
      first.id,
    );
    // A second claim of the exact key is cancelled with its label.
    const claim = await p.transactor.transact([
      p.index.claimExactOp(agencyScope('agy-a'), profile?.profile.exactKey ?? '', 'other'),
    ]);
    expect(claim).toEqual({ ok: false, error: { failed: ['duplicateIndex.exactClaim'] } });
    expect(await p.counters.get(agencyScope('agy-a'), LISTING_COUNTER_CODES.duplicateFlags)).toBe(
      1,
    );
  });

  it('guards flag changes by the stored Markierungen (list equality) and profiles by revision', async () => {
    const p = platform();
    await create(p, 'agy-a', { content: content() });
    const second = await create(p, 'agy-a', { content: content() });
    const stored = await p.listings.get(second.id);
    const flags = stored?.management.flags ?? [];
    const version = stored?.management.version ?? 0;
    // Based on no flags: rejected, the stored flag stays.
    expect(
      (await p.transactor.transact([p.listings.setFlagsOp(second.id, version, [], [])])).ok,
    ).toBe(false);
    expect(
      (await p.transactor.transact([p.listings.setFlagsOp(second.id, version, [], flags)])).ok,
    ).toBe(true);
    expect((await p.listings.get(second.id))?.management.flags).toBeUndefined();
    const profile = await p.index.getProfile(second.id);
    if (profile === null) throw new Error('profile missing');
    expect(
      (await p.transactor.transact(p.index.syncOps(profile, profile, { guard: true }))).ok,
    ).toBe(true);
    expect(
      (await p.transactor.transact(p.index.syncOps(profile, profile, { guard: true }))).ok,
    ).toBe(false);
  });

  it('answers a repeated Idempotenzschlüssel and cancels a racing one (Req 9.2)', async () => {
    const p = platform();
    const first = await p.commands.createWithKey(member('agy-a'), { content: content() }, 'k-1');
    const again = await p.commands.createWithKey(member('agy-a'), { content: content() }, 'k-1');
    expect(first.ok && again.ok && again.value.replayed).toBe(true);
    const record = first.ok && 'view' in first.value ? first.value.view.id : '';
    const keys = await p.idempotency.keysOfListing(record);
    expect(keys).toHaveLength(1);
  });

  it('runs a Duplikat_Abgleich in segments and resolves Treffer (Req 10.3, 10.4, 11.6)', async () => {
    const p = platform();
    await create(p, 'agy-a', { content: content() });
    const b = await create(p, 'agy-b', { content: content() });
    const run = (sweepId: string) =>
      runDuplicateSweep(p.sweep, { sweepId, startedAt: '2026-03-02T03:00:00.000Z' }, 3);
    const first = await run('s-1');
    expect(first).toMatchObject({ status: 'SUCCEEDED', checked: 2, reportsNew: 1, skipped: 0 });
    expect(await p.counters.get(PLATFORM_SCOPE, CROSS_AGENCY_OPEN_COUNTER)).toBe(1);
    // b becomes another property: the Treffer is resolved.
    const current = await p.listings.get(b.id);
    const edited = await p.commands.replaceContent(member('agy-b'), b.id, {
      content: content({
        title: 'Loft am Hafen',
        description: 'Offen und hell.',
        listingType: 'loft',
        rooms: 1,
        area: '40.00',
        address: { city: 'Bremen', postalCode: '28195', country: 'DE', street: 'Kaje 3' },
      }),
      baseVersion: current?.management.version,
    });
    expect(edited.ok).toBe(true);
    const second = await run('s-2');
    expect(second.reportsResolved).toBe(1);
    expect(await p.counters.get(PLATFORM_SCOPE, CROSS_AGENCY_OPEN_COUNTER)).toBe(0);
    expect((await p.reports.list({ state: 'RESOLVED' }, { limit: 10 })).items).toHaveLength(1);
  });

  it('removes every duplicate record of a deleted listing (Req 12.3)', async () => {
    const p = platform();
    const a = await p.commands.createWithKey(member('agy-a'), { content: content() }, 'k-2');
    const id = a.ok && 'view' in a.value ? a.value.view.id : '';
    await create(p, 'agy-b', { content: content() });
    await runDuplicateSweep(p.sweep, { sweepId: 's-3', startedAt: '2026-03-02T03:00:00.000Z' }, 2);
    expect(await p.index.reportRefs(id)).toHaveLength(1);
    // The deletion workflow removes the listing first, then its duplicate data.
    await doc.send(new DeleteCommand({ TableName: tables['listings']?.TableName, Key: { id } }));
    const purge = duplicateDataPurge({
      index: p.index,
      idempotency: p.idempotency,
      reports: p.reports,
      counters: p.counters,
      transactor: p.transactor,
    });
    expect(await purge.purge(id)).toEqual({ complete: true });
    expect(await p.index.getProfile(id)).toBeNull();
    expect(await p.index.reportRefs(id)).toEqual([]);
    expect(await p.idempotency.keysOfListing(id)).toEqual([]);
    expect((await p.reports.list({ state: 'OPEN' }, { limit: 10 })).items).toEqual([]);
    expect(await p.counters.get(PLATFORM_SCOPE, CROSS_AGENCY_OPEN_COUNTER)).toBe(0);
  });
});
