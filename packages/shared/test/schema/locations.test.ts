import { LocationsDocument } from '../../src';

describe('LocationsDocument', () => {
  it('accepts countries and cities with positive counts', () => {
    const doc = {
      countries: [{ code: 'TH', count: 2 }],
      cities: [{ name: 'Bangkok', country: 'TH', count: 1 }],
    };
    expect(LocationsDocument.parse(doc)).toEqual(doc);
  });

  it.each([
    { countries: [{ code: 'th', count: 1 }], cities: [] },
    { countries: [{ code: 'TH', count: 0 }], cities: [] },
    { countries: [], cities: [{ name: '', country: 'TH', count: 1 }] },
    { countries: [] },
  ])('rejects %j', (doc) => {
    expect(LocationsDocument.safeParse(doc).success).toBe(false);
  });
});
