import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ListingView, Taxonomy } from '@open-estate/shared';
import {
  checkedListingView,
  emptyFormValues,
  emptyOffer,
  formErrorsFromApi,
  fromListingView,
  validateListingForm,
  versionConflict,
  type ListingFormValues,
} from '../src/app/portal/listings/listing-form-model';
import { DIFF_FIELD_NAMES } from '../src/app/portal/shared/diff-view/diff-view-model';

const TAXONOMY: Taxonomy = { groups: [{ code: 'apartment', types: ['condominium', 'loft'] }] };

function validValues(): ListingFormValues {
  const values = emptyFormValues({ originalLocale: 'de', currency: 'EUR' });
  return {
    ...values,
    title: 'Altbauwohnung am Park',
    description: 'Hell und ruhig.',
    listingType: 'condominium',
    offers: [{ ...emptyOffer('SALE'), price: '350000' }],
    rooms: '3,5',
    area: '92,5',
    address: { street: '', postalCode: '10115', city: 'Berlin', country: 'de' },
  };
}

const VIEW: ListingView = {
  id: 'l-1',
  content: {
    originalLocale: 'de',
    title: 'Loft',
    description: 'Groß.',
    translations: [{ locale: 'en', title: 'Loft', description: 'Large.' }],
    offers: [
      { offerType: 'RENT', coldRent: '1200.00', currency: 'EUR', warmRent: '1450.00' },
      { offerType: 'SALE', price: '480000.00', currency: 'EUR' },
    ],
    listingType: 'loft',
    rooms: 2,
    area: '80.00',
    address: { city: 'Berlin', postalCode: '10115', country: 'DE' },
    geo: { lat: 52.5, lon: 13.4 },
    sourceUrl: 'https://portal.example.org/listings/l-1',
    media: [{ url: 'https://img.example.org/1.jpg' }, { url: 'https://img.example.org/2.jpg' }],
    tours: [{ url: 'https://my.matterport.com/show/?m=abc', providerCode: 'matterport' }],
  },
  status: 'INACTIVE',
  origin: 'MANUAL',
  customId: 'CRM-7',
  version: 4,
  updatedAt: '2026-11-01T10:00:00Z',
  fieldSources: {},
  sourceUrlDerived: true,
  source: 'agency:a-1',
  lastImportedAt: '2026-11-01T10:00:00Z',
  lastRunId: 'PORTAL#4',
};

describe('validateListingForm', () => {
  it('builds the create body in API representation', () => {
    const result = validateListingForm(validValues(), { taxonomy: TAXONOMY });
    expect(result).toEqual({
      ok: true,
      body: {
        status: 'INACTIVE',
        content: expect.objectContaining({
          offers: [{ offerType: 'SALE', price: '350000', currency: 'EUR' }],
          rooms: 3.5,
          area: '92.5',
          address: { city: 'Berlin', postalCode: '10115', country: 'DE' },
          media: [],
          tours: [],
        }) as unknown,
      },
    });
    if (result.ok) {
      expect(result.body['content']).not.toHaveProperty('sourceUrl');
      expect(result.body['content']).not.toHaveProperty('geo');
      expect(result.body).not.toHaveProperty('customId');
    }
  });

  it('names every invalid field and leaves the inputs unchanged', () => {
    const values = emptyFormValues({ originalLocale: 'de' });
    const before = structuredClone(values);
    const result = validateListingForm(values, { taxonomy: TAXONOMY });
    expect(values).toEqual(before);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.errors.map((e) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'title',
        'listingType',
        'offers.0.price',
        'rooms',
        'area',
        'address.city',
        'address.postalCode',
        'address.country',
      ]),
    );
    expect(new Set(paths).size).toBe(paths.length);
    expect(result.errors.find((e) => e.path === 'offers.0.price')).toMatchObject({
      field: 'price',
      item: { list: 'offers', position: 1 },
      messageKey: 'portal.listings.error.money',
    });
  });

  it('applies the cross-field rules of the shared schema', () => {
    const values: ListingFormValues = {
      ...validValues(),
      offers: [
        { ...emptyOffer('RENT'), coldRent: '1000', warmRent: '900' },
        { ...emptyOffer('RENT'), coldRent: '1000' },
      ],
      geo: { lat: '52.5', lon: '' },
      translations: [{ locale: 'de', title: 'Doppelt', description: '' }],
    };
    const result = validateListingForm(values, { taxonomy: TAXONOMY });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const byPath = Object.fromEntries(result.errors.map((e) => [e.path, e.messageKey]));
    expect(byPath).toMatchObject({
      'offers.0.warmRent': 'portal.listings.error.warmRent',
      offers: 'portal.listings.error.duplicateOffer',
      'geo.lon': 'portal.listings.error.coordinate',
      'translations.0.locale': 'portal.listings.error.duplicateLocale',
    });
  });

  it('restricts the listing type to the taxonomy, if one is loaded', () => {
    const values = { ...validValues(), listingType: 'castle' };
    expect(validateListingForm(values, { taxonomy: TAXONOMY }).ok).toBe(false);
    expect(validateListingForm(values).ok).toBe(true);
  });

  it('accepts tours without provider code (derived by the Management_API)', () => {
    const values = { ...validValues(), tours: [{ url: 'https://my.matterport.com/show/?m=x' }] };
    expect(validateListingForm(values, { taxonomy: TAXONOMY }).ok).toBe(true);
    const invalid = { ...validValues(), media: [{ url: 'http://img.example.org/1.jpg' }] };
    const result = validateListingForm(invalid, { taxonomy: TAXONOMY });
    expect(!result.ok && result.errors.map((e) => e.path)).toEqual(['media.0.url']);
  });
});

describe('fromListingView', () => {
  it('leaves a derived source URL empty and round-trips the content', () => {
    const { values, context } = fromListingView(VIEW);
    expect(values.sourceUrl).toBe('');
    expect(values.offers.map((o) => o.offerType)).toEqual(['RENT', 'SALE']);
    expect(context).toEqual({ baseVersion: 4, hadCustomId: true });

    const result = validateListingForm(values, { context, taxonomy: TAXONOMY });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { tours, ...withSourceUrl } = VIEW.content;
    const rest: Partial<typeof withSourceUrl> = { ...withSourceUrl };
    delete rest.sourceUrl;
    expect(result.body).toEqual({
      baseVersion: 4,
      customId: 'CRM-7',
      content: { ...rest, tours: tours.map(({ url }) => ({ url })) },
    });
  });

  it('keeps an explicit source URL and removes a cleared Custom_Id', () => {
    const { values, context } = fromListingView({ ...VIEW, sourceUrlDerived: false });
    expect(values.sourceUrl).toBe(VIEW.content.sourceUrl);
    const result = validateListingForm({ ...values, customId: '' }, { context });
    expect(result.ok && result.body['customId']).toBeNull();
  });

  it('checks a response without converting amounts', () => {
    expect(checkedListingView(VIEW)).toBe(VIEW);
    expect(() => checkedListingView({ ...VIEW, version: 0 })).toThrow();
  });
});

describe('API errors', () => {
  it('maps field errors of a 400 answer to form paths', () => {
    expect(
      formErrorsFromApi([
        { code: 'INVALID_PARAMETER', message: 'x', field: 'content.offers.1.price' },
        { code: 'INVALID_PARAMETER', message: 'x', field: 'customId' },
        { code: 'CUSTOM_ID_TAKEN', message: 'x' },
      ]),
    ).toEqual([
      {
        path: 'offers.1.price',
        field: 'price',
        item: { list: 'offers', position: 2 },
        messageKey: 'portal.listings.error.money',
        params: { min: 0.01, max: 999999999.99 },
      },
      expect.objectContaining({ path: 'customId', field: 'customId' }),
    ]);
  });

  it('reads the current version of a version conflict', () => {
    const conflict = { code: 'VERSION_CONFLICT', message: 'x', details: { currentVersion: 7 } };
    expect(versionConflict([conflict] as never)).toBe(7);
    expect(versionConflict([{ code: 'CUSTOM_ID_TAKEN', message: 'x' }])).toBeUndefined();
  });
});

describe('translations', () => {
  const read = (locale: string): Record<string, string> =>
    JSON.parse(
      readFileSync(join(__dirname, '..', 'public', 'i18n', `${locale}.json`), 'utf8'),
    ) as Record<string, string>;
  const SOURCES = [
    'src/app/portal/listings/listing-form-model.ts',
    'src/app/portal/listings/listing-table-model.ts',
    'src/app/portal/listings/listing-form.component.ts',
    'src/app/portal/listings/listing-table.component.ts',
    'src/app/portal/shared/diff-view/diff-view.component.ts',
  ];

  it.each(['en', 'de'])('every literal key of the listings area exists in %s.json', (locale) => {
    const keys = read(locale);
    const used = SOURCES.flatMap((file) => [
      ...readFileSync(join(__dirname, '..', file), 'utf8').matchAll(
        /'(portal\.(?:listings|field|diff)\.[A-Za-z.]+[A-Za-z])'/g,
      ),
    ]).map((m) => m[1] as string);
    const fields = [...DIFF_FIELD_NAMES, 'content'].map((name) => `portal.field.${name}`);
    const dynamic = [
      ...['ACTIVE', 'INACTIVE'].map((s) => `portal.listings.status.${s}`),
      ...['IMPORT', 'MANUAL'].map((o) => `portal.listings.origin.${o}`),
      ...['offers', 'translations', 'media', 'tours'].map((l) => `portal.listings.item.${l}`),
      ...['media', 'tours'].map((l) => `portal.listings.form.add.${l}`),
      ...['add', 'remove', 'change'].map((op) => `portal.diff.op.${op}`),
    ];
    for (const key of [...used, ...fields, ...dynamic]) expect(keys).toHaveProperty([key]);
  });
});
