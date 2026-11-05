import {
  customIdBlocklistKey,
  listingKey,
  NO_AGENCY_SCOPE_ID,
  type ListingManagement,
  type ManagedListing,
} from '@open-estate/core';
import {
  DELETION_BLOCK_REASON,
  InMemoryDeletionBlocklist,
  resolveImportTarget,
  type ImportConnectorScope,
  type ImportTargetReader,
} from '@open-estate/ingestion';
import { exampleListing } from '../../shared/test/arbitraries';

const CONNECTOR: ImportConnectorScope = { connectorId: 'conn-1', agencyId: 'agy-1' };
const NO_AGENCY: ImportConnectorScope = { connectorId: 'conn-1' };

function managed(
  id: string,
  {
    agencyId = 'agy-1',
    ...management
  }: Partial<Omit<ListingManagement, 'agencyId'>> & {
    agencyId?: string | null;
  } = {},
  source = 'conn-1',
): ManagedListing {
  return {
    listing: exampleListing(id, { source }),
    management: {
      status: 'ACTIVE',
      origin: 'IMPORT',
      version: 3,
      contentHash: '0'.repeat(64),
      fieldSources: {},
      updatedAt: '2026-01-01T10:00:00+01:00',
      ...management,
      // `agencyId: null` marks an agency-less listing (the key is then absent).
      ...(agencyId === null ? {} : { agencyId }),
    },
  };
}

/** Read-only fake: listings by id, Custom_Id keys `owner#customId` → listing id, blocklist. */
function reader(
  listings: ManagedListing[] = [],
  keys: Record<string, string> = {},
  blocked: string[] = [],
): ImportTargetReader {
  const byId = new Map(listings.map((l) => [l.listing.id, l]));
  return {
    listings: { get: (id) => Promise.resolve(byId.get(id) ?? null) },
    keys: { get: (owner, customId) => Promise.resolve(keys[listingKey(owner, customId)] ?? null) },
    blocklist: new InMemoryDeletionBlocklist(blocked),
  };
}

const newId = () => 'generated-id';

describe('resolveImportTarget', () => {
  it('rejects a record without id and Custom_Id („Identität fehlt“, Req 12.4)', async () => {
    await expect(resolveImportTarget({}, CONNECTOR, reader(), newId)).resolves.toEqual({
      kind: 'reject',
      code: 'IDENTITY_MISSING',
      reason: 'Identität fehlt',
    });
  });

  it('targets the listing with the supplied id first (Req 12.2)', async () => {
    const target = managed('lst-1', { customId: 'C-1' });
    const result = await resolveImportTarget(
      { id: 'lst-1', customId: 'C-1' },
      CONNECTOR,
      reader([target], { 'agy-1#C-1': 'lst-1' }),
      newId,
    );
    expect(result).toEqual({
      kind: 'update',
      listing: target,
      expectedVersion: 3,
      claimAgency: false,
    });
  });

  it('falls back to the Custom_Id within the connector agency (Req 12.2)', async () => {
    const target = managed('lst-2', { customId: 'C-1' });
    const keys = { 'agy-1#C-1': 'lst-2' };
    for (const record of [{ customId: 'C-1' }, { id: 'lst-unknown', customId: 'C-1' }]) {
      const result = await resolveImportTarget(record, CONNECTOR, reader([target], keys), newId);
      expect(result).toMatchObject({ kind: 'update', listing: target, expectedVersion: 3 });
    }
  });

  it('looks up Custom_Ids of agency-less connectors under `_none`', async () => {
    const target = managed('lst-2', { agencyId: null, customId: 'C-1' });
    const result = await resolveImportTarget(
      { customId: 'C-1' },
      NO_AGENCY,
      reader([target], { [listingKey(NO_AGENCY_SCOPE_ID, 'C-1')]: 'lst-2' }),
      newId,
    );
    expect(result).toMatchObject({ kind: 'update', listing: target, claimAgency: false });
  });

  it('rejects id and Custom_Id pointing to two listings („Identitätskonflikt“, Req 12.3, 12.14)', async () => {
    const result = await resolveImportTarget(
      { id: 'lst-1', customId: 'C-2' },
      CONNECTOR,
      reader([managed('lst-1'), managed('lst-2', { customId: 'C-2' })], { 'agy-1#C-2': 'lst-2' }),
      newId,
    );
    expect(result).toEqual({
      kind: 'reject',
      code: 'IDENTITY_CONFLICT',
      reason: 'Identitätskonflikt',
      listingId: 'lst-1',
    });
  });

  it('treats a dangling Custom_Id key as the id to create; another id conflicts', async () => {
    const keys = { 'agy-1#C-1': 'lst-gone' };
    await expect(
      resolveImportTarget({ customId: 'C-1' }, CONNECTOR, reader([], keys), newId),
    ).resolves.toEqual({ kind: 'create', id: 'lst-gone' });
    await expect(
      resolveImportTarget({ id: 'lst-new', customId: 'C-1' }, CONNECTOR, reader([], keys), newId),
    ).resolves.toMatchObject({ kind: 'reject', code: 'IDENTITY_CONFLICT' });
  });

  it('creates with the supplied id, otherwise with a new id (Req 12.5)', async () => {
    await expect(
      resolveImportTarget({ id: 'lst-new', customId: 'C-9' }, CONNECTOR, reader(), newId),
    ).resolves.toEqual({ kind: 'create', id: 'lst-new' });
    await expect(
      resolveImportTarget({ customId: 'C-9' }, CONNECTOR, reader(), newId),
    ).resolves.toEqual({ kind: 'create', id: 'generated-id' });
  });

  it('rejects a blocked id or Custom_Id („Löschsperre“, Req 12.14)', async () => {
    const blockedId = await resolveImportTarget(
      { id: 'lst-del' },
      CONNECTOR,
      reader([], {}, ['lst-del']),
      newId,
    );
    expect(blockedId).toEqual({
      kind: 'reject',
      code: 'DELETION_BLOCKED',
      reason: DELETION_BLOCK_REASON,
      listingId: 'lst-del',
    });
    const blockedCustom = await resolveImportTarget(
      { customId: 'C-del' },
      CONNECTOR,
      reader([], {}, [customIdBlocklistKey('agy-1', 'C-del')]),
      newId,
    );
    expect(blockedCustom).toMatchObject({ kind: 'reject', code: 'DELETION_BLOCKED' });
    // The key is agency-scoped: another agency's block does not apply.
    await expect(
      resolveImportTarget(
        { customId: 'C-del' },
        CONNECTOR,
        reader([], {}, [customIdBlocklistKey('agy-2', 'C-del')]),
        newId,
      ),
    ).resolves.toEqual({ kind: 'create', id: 'generated-id' });
  });

  it('rejects listings of another agency or agency listings for agency-less connectors (Req 12.12)', async () => {
    const foreign = managed('lst-1', { agencyId: 'agy-2' });
    await expect(
      resolveImportTarget({ id: 'lst-1' }, CONNECTOR, reader([foreign]), newId),
    ).resolves.toEqual({
      kind: 'reject',
      code: 'FOREIGN_AGENCY',
      reason: 'Fremde Agentur',
      listingId: 'lst-1',
    });
    await expect(
      resolveImportTarget({ id: 'lst-1' }, NO_AGENCY, reader([managed('lst-1')]), newId),
    ).resolves.toMatchObject({ kind: 'reject', code: 'FOREIGN_AGENCY' });
  });

  it('claims an agency-less listing of the same source (Req 12.13), not of another source', async () => {
    const own = managed('lst-1', { agencyId: null });
    await expect(
      resolveImportTarget({ id: 'lst-1' }, CONNECTOR, reader([own]), newId),
    ).resolves.toEqual({ kind: 'update', listing: own, expectedVersion: 3, claimAgency: true });
    const other = managed('lst-1', { agencyId: null }, 'conn-other');
    await expect(
      resolveImportTarget({ id: 'lst-1' }, CONNECTOR, reader([other]), newId),
    ).resolves.toMatchObject({ kind: 'reject', code: 'FOREIGN_AGENCY' });
  });

  it('updates agency-less listings from agency-less connectors', async () => {
    const target = managed('lst-1', { agencyId: null }, 'conn-other');
    await expect(
      resolveImportTarget({ id: 'lst-1' }, NO_AGENCY, reader([target]), newId),
    ).resolves.toMatchObject({ kind: 'update', claimAgency: false });
  });
});
