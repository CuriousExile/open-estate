import { createHash } from 'node:crypto';
import {
  canonicalJson,
  changedContentPaths,
  CONTENT_FIELDS,
  contentHash,
  contentPaths,
  ListingContent,
  type Listing,
} from '../src';
import { exampleListing } from './arbitraries';

/** Internal-representation content (minor units) of the example listing. */
function content(overrides: Partial<Listing> = {}): ListingContent {
  return Object.fromEntries(
    Object.entries(exampleListing('l-1', overrides)).filter(([key]) =>
      (CONTENT_FIELDS as readonly string[]).includes(key),
    ),
  ) as ListingContent;
}

const base = (): ListingContent =>
  content({ geo: { lat: 52.5, lon: 13.4 }, contact: { email: 'a@example.org' } });

describe('contentPaths', () => {
  it('lists paths to scalars and lists, resolving objects recursively, sorted', () => {
    expect(contentPaths(base())).toEqual([
      'address.city',
      'address.country',
      'address.postalCode',
      'area',
      'contact.email',
      'description',
      'geo.lat',
      'geo.lon',
      'listingType',
      'media',
      'offers',
      'originalLocale',
      'rooms',
      'sourceUrl',
      'title',
      'tours',
      'translations',
    ]);
  });

  it('omits absent optional fields and empty objects', () => {
    const paths = contentPaths({ ...content(), contact: {} });
    expect(paths).not.toContain('geo.lat');
    expect(paths.some((p) => p.startsWith('contact'))).toBe(false);
    expect(paths).not.toContain('address.street');
  });

  it('ignores id, provenance and management fields of a full listing', () => {
    const listing = { ...exampleListing('l-1'), status: 'ACTIVE', customId: 'c-1' };
    const paths = contentPaths(listing as unknown as ListingContent);
    for (const field of ['id', 'source', 'lastImportedAt', 'lastRunId', 'status', 'customId']) {
      expect(paths).not.toContain(field);
    }
  });
});

describe('changedContentPaths', () => {
  it('returns all paths on creation', () => {
    expect(changedContentPaths(undefined, base())).toEqual(contentPaths(base()));
  });

  it('returns nothing for equal content', () => {
    expect(changedContentPaths(base(), base())).toEqual([]);
  });

  it('reports added, removed and changed paths at leaf granularity', () => {
    const before = base();
    const after: ListingContent = {
      ...before,
      address: { ...before.address, city: 'Hamburg', street: 'Hauptstr. 1' },
      geo: undefined,
      title: 'New title',
    };
    expect(changedContentPaths(before, after)).toEqual([
      'address.city',
      'address.street',
      'geo.lat',
      'geo.lon',
      'title',
    ]);
  });

  it('treats lists as one path, including reordering', () => {
    const before = content({
      media: [{ url: 'https://a.example/1.jpg' }, { url: 'https://a.example/2.jpg' }],
    });
    const after = { ...before, media: [...before.media].reverse() };
    expect(changedContentPaths(before, after)).toEqual(['media']);
  });
});

describe('contentHash', () => {
  it('is SHA-256 over canonicalJson of the content fields', () => {
    const c = base();
    const expected = createHash('sha256')
      .update(canonicalJson(c) ?? '')
      .digest('hex');
    expect(contentHash(c)).toBe(expected);
  });

  it('is independent of key order and of the amount representation', () => {
    const c = base();
    const reversed = Object.fromEntries(Object.entries(c).reverse()) as ListingContent;
    expect(contentHash(reversed)).toBe(contentHash(c));

    // API representation (decimal strings) parsed into minor units yields the same hash.
    const fromDecimal = ListingContent.parse({
      ...c,
      area: '75.00',
      offers: [{ offerType: 'SALE', price: '100000.00', currency: 'EUR' }],
    });
    expect(contentHash(fromDecimal)).toBe(contentHash(c));
  });

  it('changes when a content field changes', () => {
    const c = base();
    expect(contentHash({ ...c, rooms: c.rooms + 0.5 })).not.toBe(contentHash(c));
    expect(contentHash({ ...c, address: { ...c.address, street: 'X' } })).not.toBe(contentHash(c));
  });

  it('ignores provenance and management fields', () => {
    const c = base();
    const withExtras = {
      ...c,
      id: 'other',
      source: 'agency:a-1',
      lastImportedAt: '2026-01-01T00:00:00.000Z',
      lastRunId: 'PORTAL#2',
      status: 'INACTIVE',
      customId: 'c-9',
      agencyId: 'a-1',
    };
    expect(contentHash(withExtras as unknown as ListingContent)).toBe(contentHash(c));
  });
});
