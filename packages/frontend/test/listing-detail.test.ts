import type { LocalizedListing } from '@open-estate/shared';
import {
  DETAIL_ROWS_HIDDEN_BY_DEFAULT,
  displayName,
  formatDateTime,
  httpUrl,
  toListingDetail,
  toOfferView,
} from '../src/app/listing/listing-detail-model';

/** Intl uses (narrow) no-break spaces in some locales; compare with plain spaces. */
const plain = (text: string) => text.replace(/\s/g, ' ');

function listing(overrides: Partial<LocalizedListing> = {}): LocalizedListing {
  return {
    id: 'l-1',
    originalLocale: 'de',
    deliveredLocale: 'en',
    title: 'Loft by the river',
    description: 'Bright loft.',
    offers: [{ offerType: 'SALE', price: '450000.00', currency: 'EUR' }],
    listingType: 'loft',
    group: 'apartment',
    rooms: 3.5,
    area: '98.50',
    address: { city: 'Berlin', postalCode: '10115', country: 'DE', street: 'Spreeweg 1' },
    geo: { lat: 52.520008, lon: 13.404954 },
    sourceUrl: 'https://example.com/listing/1',
    media: [],
    tours: [],
    source: 'seed',
    lastImportedAt: '2026-01-02T10:30:00.000Z',
    lastRunId: 'run-1',
    ...overrides,
  };
}

describe('toOfferView (Req 12.13)', () => {
  it('shows the purchase price of a SALE offer', () => {
    const view = toOfferView({ offerType: 'SALE', price: '450000.00', currency: 'EUR' }, 'de');
    expect(view.offerType).toBe('SALE');
    expect(view.amounts.map((a) => ({ ...a, value: plain(a.value) }))).toEqual([
      { key: 'detail.offer.price', value: '450.000 €' },
    ]);
  });

  it('shows cold rent, additional costs and warm rent of a RENT offer when all are stored', () => {
    const view = toOfferView(
      {
        offerType: 'RENT',
        coldRent: '1250.50',
        additionalCosts: '200.00',
        warmRent: '1450.50',
        currency: 'CHF',
      },
      'en',
    );
    expect(view.amounts.map((a) => a.key)).toEqual([
      'detail.offer.coldRent',
      'detail.offer.additionalCosts',
      'detail.offer.warmRent',
    ]);
    expect(view.amounts.map((a) => plain(a.value))).toEqual([
      'CHF 1,250.50',
      'CHF 200',
      'CHF 1,450.50',
    ]);
  });

  it.each([
    ['only cold rent', {}, ['detail.offer.coldRent']],
    [
      'cold rent + additional costs',
      { additionalCosts: '150.00' },
      ['detail.offer.coldRent', 'detail.offer.additionalCosts'],
    ],
    [
      'cold rent + warm rent',
      { warmRent: '1100.00' },
      ['detail.offer.coldRent', 'detail.offer.warmRent'],
    ],
  ])('shows optional RENT amounts only when stored: %s', (_, extra, keys) => {
    const view = toOfferView(
      { offerType: 'RENT', coldRent: '950.00', currency: 'EUR', ...extra },
      'de',
    );
    expect(view.amounts.map((a) => a.key)).toEqual(keys);
  });
});

describe('toListingDetail (Req 7.5)', () => {
  it('lists both offers of a SALE + RENT listing in stored order', () => {
    const detail = toListingDetail(
      listing({
        offers: [
          { offerType: 'SALE', price: '450000.00', currency: 'EUR' },
          { offerType: 'RENT', coldRent: '1250.00', currency: 'EUR', warmRent: '1500.00' },
        ],
      }),
      'de',
    );
    expect(detail.offers.map((o) => o.offerType)).toEqual(['SALE', 'RENT']);
    expect(detail.offers[1]?.amounts.map((a) => plain(a.value))).toEqual(['1.250 €', '1.500 €']);
  });

  it('contains all fields formatted for the locale', () => {
    const source = listing({
      media: [{ url: 'https://img.example.com/1.jpg' }],
      tours: [{ url: 'https://tour.example.com/1', providerCode: 'matterport' }],
      contact: { name: 'Agency', phone: '+49 30 123', email: 'info@example.com' },
    });
    const detail = toListingDetail(source, 'de', { showRows: DETAIL_ROWS_HIDDEN_BY_DEFAULT });
    expect(detail).toMatchObject({
      listing: source,
      title: 'Loft by the river',
      description: 'Bright loft.',
      contentLocale: 'en',
      city: 'Berlin',
      postalCode: '10115',
      listingType: 'loft',
      media: source.media,
      tours: source.tours,
    });
    expect(detail.offers.map((o) => o.offerType)).toEqual(['SALE']);
    expect(detail.sections).toEqual([
      {
        id: 'detail-facts',
        key: 'detail.facts',
        rows: [
          { key: 'detail.type', textKey: 'taxonomy.type.loft' },
          { key: 'detail.group', textKey: 'taxonomy.group.apartment' },
          { key: 'detail.rooms', text: '3,5' },
          { key: 'detail.area', textKey: 'detail.areaValue', params: { value: '98,5' } },
        ],
      },
      {
        id: 'detail-location',
        key: 'detail.location',
        rows: [
          { key: 'detail.street', text: 'Spreeweg 1' },
          { key: 'detail.postalCode', text: '10115' },
          { key: 'detail.city', text: 'Berlin' },
          { key: 'detail.country', text: 'Deutschland' },
          {
            key: 'detail.coordinates',
            textKey: 'detail.coordinatesValue',
            params: { lat: '52,520008', lon: '13,404954' },
          },
        ],
      },
      {
        id: 'detail-contact',
        key: 'detail.contact',
        rows: [
          { key: 'detail.contactName', text: 'Agency' },
          { key: 'detail.contactPhone', text: '+49 30 123', href: 'tel:+4930123' },
          { key: 'detail.contactEmail', text: 'info@example.com', href: 'mailto:info@example.com' },
        ],
      },
      {
        id: 'detail-about',
        key: 'detail.about',
        rows: [
          {
            key: 'detail.sourceUrl',
            textKey: 'detail.sourceLink',
            href: 'https://example.com/listing/1',
            external: true,
          },
          { key: 'detail.language', text: 'Englisch' },
          { key: 'detail.originalLanguage', text: 'Deutsch' },
          { key: 'detail.id', text: 'l-1' },
          { key: 'detail.source', text: 'seed' },
          { key: 'detail.importedAt', text: formatDateTime('2026-01-02T10:30:00.000Z', 'de') },
          { key: 'detail.runId', text: 'run-1' },
        ],
      },
    ]);
  });

  it('hides technical and provenance rows by default', () => {
    const detail = toListingDetail(listing({ contact: {} }), 'de');
    const keys = detail.sections.flatMap((s) => s.rows.map((row) => row.key));
    for (const hidden of DETAIL_ROWS_HIDDEN_BY_DEFAULT) expect(keys).not.toContain(hidden);
    expect(keys).toEqual(expect.arrayContaining(['detail.city', 'detail.sourceUrl']));
    // Single rows can be switched on.
    const withId = toListingDetail(listing({ contact: {} }), 'de', {
      showRows: new Set(['detail.id']),
    });
    expect(withId.sections.flatMap((s) => s.rows)).toContainEqual({
      key: 'detail.id',
      text: 'l-1',
    });
  });

  it('omits rows and sections of values that are not stored', () => {
    const address = { city: 'Berlin', postalCode: '10115', country: 'DE' };
    const detail = toListingDetail(
      listing({ address, geo: undefined, group: undefined, contact: {} }),
      'en',
    );
    const keys = detail.sections.flatMap((s) => s.rows.map((row) => row.key));
    expect(detail.sections.map((s) => s.id)).not.toContain('detail-contact');
    expect(keys).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^detail\.(street|coordinates|group|contact)/),
      ]),
    );
    expect(keys).toContain('detail.city');
  });

  it('shows a source URL that is no http(s) link as text', () => {
    const detail = toListingDetail(listing({ sourceUrl: 'javascript:alert(1)' }), 'en');
    const about = detail.sections.find((s) => s.id === 'detail-about');
    expect(about?.rows[0]).toEqual({ key: 'detail.sourceUrl', text: 'javascript:alert(1)' });
  });
});

describe('detail helpers', () => {
  it('falls back to the code or the delivered value when Intl cannot format', () => {
    expect(displayName('XX', 'region', 'en')).toBe('XX');
    expect(displayName('not a code', 'language', 'en')).toBe('not a code');
    expect(formatDateTime('not a date', 'en')).toBe('not a date');
  });

  it('accepts only http(s) URLs as link target', () => {
    expect(httpUrl('http://example.com/a')).toBe('http://example.com/a');
    expect(httpUrl('javascript:alert(1)')).toBeUndefined();
    expect(httpUrl('relative/path')).toBeUndefined();
  });
});
