import { mergeImport, resolveImportMode, type ImportRecord, type ListingContent } from '../src';

// Focused unit tests for the import merge (design: "Import-Pipeline", step 4; Req 12.6–12.8).

/** Structural content subset; the merge does not validate. */
const content = (value: Record<string, unknown>): ListingContent =>
  value as unknown as ListingContent;
const record = (value: Record<string, unknown>): ImportRecord => value as ImportRecord;

const existing = content({
  title: 'Altbau',
  description: 'Schön',
  rooms: 3,
  address: { city: 'Berlin', postalCode: '10115', street: 'Hauptstr. 1', countryCode: 'DE' },
  geo: { lat: 52.5, lon: 13.4 },
  contact: { email: 'a@example.org' },
  offers: [{ offerType: 'RENT', coldRent: { amount: 120000, currency: 'EUR' } }],
  media: [{ url: 'https://example.org/a.jpg' }, { url: 'https://example.org/b.jpg' }],
});

describe('mergeImport MERGE (Req 12.6)', () => {
  it('overwrites delivered scalars and keeps the rest', () => {
    const merged = mergeImport(existing, record({ title: 'Neubau' }), 'MERGE');
    expect(merged).toEqual({ ...existing, title: 'Neubau' });
  });

  it('merges nested objects key by key', () => {
    const merged = mergeImport(existing, record({ address: { city: 'Hamburg' } }), 'MERGE');
    expect(merged.address).toEqual({
      city: 'Hamburg',
      postalCode: '10115',
      street: 'Hauptstr. 1',
      countryCode: 'DE',
    });
  });

  it('replaces lists as a whole in delivered order', () => {
    const media = [{ url: 'https://example.org/c.jpg' }];
    const merged = mergeImport(existing, record({ media }), 'MERGE');
    expect(merged.media).toEqual(media);
    expect(merged.offers).toEqual(existing.offers);
  });

  it('removes fields with null on every level', () => {
    const merged = mergeImport(
      existing,
      record({ address: { street: null }, geo: null, contact: { email: null } }),
      'MERGE',
    );
    expect(merged.address).toEqual({ city: 'Berlin', postalCode: '10115', countryCode: 'DE' });
    expect(merged).not.toHaveProperty('geo');
    expect(merged).not.toHaveProperty('contact');
  });

  it('ignores identity and status and does not mutate inputs', () => {
    const before = structuredClone(existing);
    const input = record({ id: 'x', customId: 'C-1', status: 'INACTIVE', rooms: 4 });
    const merged = mergeImport(existing, input, 'MERGE');
    expect(merged).toEqual({ ...before, rooms: 4 });
    expect(existing).toEqual(before);
  });
});

describe('mergeImport REPLACE (Req 12.7)', () => {
  it('yields exactly the delivered content, null counts as missing', () => {
    const merged = mergeImport(
      existing,
      record({ id: 'x', title: 'Neu', address: { city: 'Köln', street: null }, geo: null }),
      'REPLACE',
    );
    expect(merged).toEqual({ title: 'Neu', address: { city: 'Köln' } });
  });
});

describe('mergeImport creation (Req 12.8)', () => {
  it.each(['MERGE', 'REPLACE'] as const)(
    'uses the delivered fields, missing optional fields stay absent (%s)',
    (mode) => {
      const merged = mergeImport(
        undefined,
        record({ title: 'Neu', geo: null, address: { city: 'Köln', street: null } }),
        mode,
      );
      expect(merged).toEqual({ title: 'Neu', address: { city: 'Köln' } });
    },
  );
});

describe('resolveImportMode (Req 12.16)', () => {
  it('prefers configuration, then module default, then MERGE', () => {
    expect(resolveImportMode({ importMode: 'MERGE' }, { defaultImportMode: 'REPLACE' })).toBe(
      'MERGE',
    );
    expect(resolveImportMode({}, { defaultImportMode: 'REPLACE' })).toBe('REPLACE');
    expect(resolveImportMode({}, {})).toBe('MERGE');
  });
});
