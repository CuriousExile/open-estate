import { ListingView, VersionEntry, type Taxonomy } from '@open-estate/shared';
import { toListingDetail } from '../src/app/listing/listing-detail-model';
import {
  fieldProvenanceRows,
  missingImportVersions,
} from '../src/app/portal/workspace/field-provenance-model';
import {
  formatDiffPath,
  formatDiffValue,
  restoreDiffRows,
  toDiffRows,
} from '../src/app/portal/workspace/version-diff-model';
import {
  canRestore,
  comparePair,
  mergeVersionPages,
  toggleCompare,
  toTimelineItem,
} from '../src/app/portal/workspace/version-timeline-model';
import {
  toActorView,
  toPublicDetailModel,
  type ParsedVersionEntry,
} from '../src/app/portal/workspace/workspace-model';

const taxonomy: Taxonomy = { groups: [{ code: 'apartment', types: ['loft'] }] };

const portalUser = { kind: 'user', userId: 'u-1', displayName: 'Mia Member' } as const;
const connector = { kind: 'connector', connectorId: 'crm-feed', runId: 'run-7' } as const;

/** `GET /listings/{id}` as sent (API representation), parsed like the workspace does. */
function view(overrides: Partial<ListingView> = {}) {
  return ListingView.parse({
    id: 'l-1',
    content: {
      originalLocale: 'de',
      title: 'Loft am Fluss',
      description: 'Helles Loft.',
      translations: [{ locale: 'en', title: 'Loft by the river', description: 'Bright loft.' }],
      offers: [{ offerType: 'SALE', price: '450000.00', currency: 'EUR' }],
      listingType: 'loft',
      rooms: 3.5,
      area: '98.50',
      address: { city: 'Berlin', postalCode: '10115', country: 'DE' },
      sourceUrl: 'https://example.com/listing/1',
      media: [],
      tours: [],
    },
    status: 'INACTIVE',
    origin: 'IMPORT',
    version: 4,
    updatedAt: '2026-03-01T10:00:00.000Z',
    fieldSources: {
      title: { channel: 'IMPORT', actor: connector, version: 4 },
      description: { channel: 'PORTAL', actor: portalUser, version: 2 },
      'address.city': { channel: 'IMPORT', actor: connector, version: 1 },
    },
    sourceUrlDerived: false,
    source: 'crm-feed',
    lastImportedAt: '2026-03-01T10:00:00.000Z',
    lastRunId: 'run-7',
    ...overrides,
  });
}

function entry(overrides: Partial<VersionEntry> & { version: number }): ParsedVersionEntry {
  return VersionEntry.parse({
    changeType: 'UPDATE',
    channel: 'PORTAL',
    actor: portalUser,
    createdAt: '2026-03-01T10:00:00.000Z',
    status: 'INACTIVE',
    changedPaths: [],
    ...overrides,
  });
}

describe('toPublicDetailModel (Req 5.8)', () => {
  it('is the public API representation of the listing in the language version for the locale', () => {
    const preview = toPublicDetailModel(view(), 'en', taxonomy);

    expect(preview).toMatchObject({
      id: 'l-1',
      title: 'Loft by the river',
      description: 'Bright loft.',
      deliveredLocale: 'en',
      originalLocale: 'de',
      group: 'apartment',
      area: '98.50',
      offers: [{ offerType: 'SALE', price: '450000.00', currency: 'EUR' }],
      source: 'crm-feed',
      lastRunId: 'run-7',
    });
    expect(preview).not.toHaveProperty('translations');
    // Management data never reaches the public model.
    expect(preview).not.toHaveProperty('status');
    expect(preview).not.toHaveProperty('fieldSources');
  });

  it('falls back to the original language like the Search_API', () => {
    const preview = toPublicDetailModel(view(), 'fr', taxonomy);
    expect(preview.title).toBe('Loft am Fluss');
    expect(preview.deliveredLocale).toBe('de');
  });

  it('renders an inactive listing exactly like the same listing when active', () => {
    const inactive = toPublicDetailModel(view({ status: 'INACTIVE' }), 'de', taxonomy);
    const active = toPublicDetailModel(view({ status: 'ACTIVE' }), 'de', taxonomy);
    expect(inactive).toEqual(active);
    expect(toListingDetail(inactive, 'de')).toEqual(toListingDetail(active, 'de'));
  });
});

describe('fieldProvenanceRows (Req 12.11, 12.15)', () => {
  const history = new Map([
    [
      4,
      entry({
        version: 4,
        channel: 'IMPORT',
        changeType: 'IMPORT',
        actor: connector,
        changedPaths: [
          {
            path: 'title',
            overwrittenByImport: true,
            previous: { channel: 'PORTAL', actor: portalUser, version: 3 },
          },
        ],
      }),
    ],
  ]);

  it('lists every content path with its provenance and highlights import overwrites', () => {
    const rows = fieldProvenanceRows(view(), history);
    const byPath = new Map(rows.map((r) => [r.path, r]));

    expect(rows.map((r) => r.path)).toEqual([...rows.map((r) => r.path)].sort());
    expect(byPath.get('title')).toMatchObject({
      source: { channel: 'IMPORT', version: 4, actor: { name: 'crm-feed', runId: 'run-7' } },
      overwrittenByImport: true,
      previous: { channel: 'PORTAL', version: 3, actor: { name: 'Mia Member' } },
    });
    expect(byPath.get('description')).toMatchObject({
      source: { channel: 'PORTAL', version: 2 },
      overwrittenByImport: false,
    });
    // Import version not loaded yet: highlighting still undecided.
    expect(byPath.get('address.city')?.overwrittenByImport).toBeUndefined();
    // Present paths without provenance are listed too.
    expect(byPath.get('rooms')).toEqual({ path: 'rooms', overwrittenByImport: false });
  });

  it('does not highlight an import that did not overwrite a manual change', () => {
    const plain = new Map([
      [
        4,
        entry({
          version: 4,
          channel: 'IMPORT',
          changedPaths: [{ path: 'title', overwrittenByImport: false }],
        }),
      ],
    ]);
    const title = fieldProvenanceRows(view(), plain).find((r) => r.path === 'title');
    expect(title?.overwrittenByImport).toBe(false);
    expect(title).not.toHaveProperty('previous');
  });

  it('names the import versions that still have to be loaded', () => {
    expect(missingImportVersions(view().fieldSources, history)).toEqual([1]);
    expect(missingImportVersions(view().fieldSources, new Map())).toEqual([1, 4]);
  });
});

describe('version timeline (Req 7.8)', () => {
  it('marks list imports with connector and run', () => {
    const item = toTimelineItem(
      entry({
        version: 4,
        channel: 'IMPORT',
        changeType: 'IMPORT',
        actor: connector,
        changedPaths: [
          { path: 'title', overwrittenByImport: true },
          { path: 'rooms', overwrittenByImport: false },
        ],
      }),
      4,
    );
    expect(item).toMatchObject({
      isImport: true,
      connector: { connectorId: 'crm-feed', runId: 'run-7' },
      changedPaths: ['title', 'rooms'],
      overwrittenPaths: ['title'],
      current: true,
    });
  });

  it('does not mark manual versions as import and keeps the restore reference', () => {
    const item = toTimelineItem(entry({ version: 3, changeType: 'RESTORE', restoredFrom: 1 }), 4);
    expect(item.isImport).toBe(false);
    expect(item).not.toHaveProperty('connector');
    expect(item.restoredFrom).toBe(1);
    expect(item.current).toBe(false);
  });

  it('offers restore only for former versions and only with permission (Req 5.6)', () => {
    const current = toTimelineItem(entry({ version: 4 }), 4);
    const former = toTimelineItem(entry({ version: 2 }), 4);
    expect(canRestore(former, true)).toBe(true);
    expect(canRestore(former, false)).toBe(false);
    expect(canRestore(current, true)).toBe(false);
  });

  it('merges further pages newest first without duplicates', () => {
    const merged = mergeVersionPages(
      [entry({ version: 5 }), entry({ version: 4 })],
      [entry({ version: 4 }), entry({ version: 3 })],
    );
    expect(merged.map((e) => e.version)).toEqual([5, 4, 3]);
  });

  it('selects at most two versions and compares from the older to the newer', () => {
    expect(toggleCompare([], 3)).toEqual([3]);
    expect(toggleCompare([3], 1)).toEqual([3, 1]);
    expect(toggleCompare([3, 1], 5)).toEqual([1, 5]);
    expect(toggleCompare([3, 1], 3)).toEqual([1]);
    expect(comparePair([3])).toBeUndefined();
    expect(comparePair([5, 2])).toEqual({ from: 2, to: 5 });
  });
});

describe('version diff rendering (Req 7.8, 8.6)', () => {
  const entries = [
    {
      op: 'change' as const,
      path: ['content', 'offers', 0, 'price'],
      oldValue: '1.00',
      value: '2.00',
    },
    { op: 'add' as const, path: ['content', 'geo'], value: { lat: 1, lon: 2 } },
    { op: 'remove' as const, path: ['content', 'address', 'street'], oldValue: 'Spreeweg 1' },
    { op: 'change' as const, path: ['status'], oldValue: 'ACTIVE', value: 'INACTIVE' },
  ];

  it('shows readable paths with old and new values', () => {
    expect(toDiffRows(entries)).toEqual([
      { path: 'offers[0].price', op: 'change', oldText: '1.00', newText: '2.00' },
      { path: 'geo', op: 'add', newText: '{"lat":1,"lon":2}' },
      { path: 'address.street', op: 'remove', oldText: 'Spreeweg 1' },
      { path: 'status', op: 'change', oldText: 'ACTIVE', newText: 'INACTIVE' },
    ]);
  });

  it('restricts the restore confirmation to the Listing_Inhalt (Req 8.2)', () => {
    expect(restoreDiffRows(entries).map((r) => r.path)).toEqual([
      'offers[0].price',
      'geo',
      'address.street',
    ]);
  });

  it('formats paths and values', () => {
    expect(formatDiffPath(['content', 'media', 2])).toBe('media[2]');
    expect(formatDiffPath(['customId'])).toBe('customId');
    expect(formatDiffPath(['content'])).toBe('content');
    expect(formatDiffValue(3.5)).toBe('3.5');
    expect(formatDiffValue(null)).toBe('null');
    expect(formatDiffValue(['a', 'b'])).toBe('["a","b"]');
  });
});

describe('toActorView (Req 7.9)', () => {
  it('names every kind of actor', () => {
    expect(toActorView(portalUser)).toEqual({
      kindKey: 'portal.workspace.actorKind.user',
      name: 'Mia Member',
    });
    expect(toActorView({ kind: 'machine', keyId: 'k', label: 'CRM' }).name).toBe('CRM');
    expect(toActorView(connector)).toEqual({
      kindKey: 'portal.workspace.actorKind.connector',
      name: 'crm-feed',
      runId: 'run-7',
    });
    expect(toActorView({ kind: 'iam', userArn: 'arn:aws:iam::1:user/a' }).name).toBe(
      'arn:aws:iam::1:user/a',
    );
  });
});
