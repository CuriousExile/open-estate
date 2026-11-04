import {
  createRunLogger,
  DELETION_BLOCK_REASON,
  ImportPipeline,
  InMemoryDeletionBlocklist,
  InMemoryListingWriter,
  type ImportPipelineOptions,
  type ListingWriter,
  type RawRecord,
  type RecordProcessingContext,
} from '@open-estate/ingestion';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  PiiAllowlistConfig,
  TourProvidersConfig,
} from '@open-estate/shared';

const NOW = new Date('2026-11-05T10:00:00.000Z');
const RUN_ID = 'run-42';
const SOURCE = 'partner-db';
const EMAIL = 'jane.doe@example.org';
const PHONE = '+49 170 1234567';
const NAME = 'Jane Doe';
const MATTERPORT = 'https://my.matterport.com/show/?m=abc';

const listingSchema = buildSchemas(assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG), {
  defaultLocale: 'de',
  enabled: [{ locale: 'de', label: 'Deutsch' }],
}).listing;

const tourProviders = TourProvidersConfig.parse({
  providers: [
    { code: 'matterport', hostnames: ['my.matterport.com'] },
    { code: 'kuula', hostnames: ['Kuula.co'] },
  ],
});

/** Valid raw record in the listing input format. */
function rawListing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'L-1',
    originalLocale: 'de',
    title: 'Helle Wohnung',
    description: 'Mit Balkon',
    translations: [],
    offers: [{ offerType: 'RENT', coldRent: '900.00', currency: 'EUR', warmRent: '1100.00' }],
    listingType: 'loft',
    rooms: 2.5,
    area: '72.50',
    address: { city: 'Berlin', postalCode: '10115', country: 'DE' },
    sourceUrl: 'https://partner.example/listings/1',
    media: [{ url: 'https://img.example/1.jpg' }],
    tours: [{ url: MATTERPORT }],
    ...overrides,
  };
}

function setup(options: Partial<ImportPipelineOptions> = {}) {
  const lines: string[] = [];
  const logger = createRunLogger({
    runId: RUN_ID,
    source: SOURCE,
    sink: (line) => lines.push(line),
    now: () => NOW,
  });
  const writer = new InMemoryListingWriter();
  const blocklist = new InMemoryDeletionBlocklist();
  const pipeline = new ImportPipeline({
    listingSchema,
    blocklist,
    writer,
    tourProviders,
    now: () => NOW,
    ...options,
  });
  const ctx: RecordProcessingContext = { runId: RUN_ID, source: SOURCE, logger };
  const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const rejectedFields = () =>
    entries()
      .filter((e) => e['event'] === 'record.rejected')
      .flatMap((e) => (e['issues'] as { field: string }[]).map((i) => i.field));
  return {
    writer,
    blocklist,
    lines,
    entries,
    rejectedFields,
    process: (raw: RawRecord) => pipeline.process(raw, ctx),
  };
}

describe('ImportPipeline', () => {
  describe('mapping and enrichment', () => {
    it('drops unknown fields and sets provenance itself', async () => {
      const t = setup();
      const outcome = await t.process(
        rawListing({
          internalScore: 7,
          address: { city: 'Berlin', postalCode: '10115', country: 'DE', floorPlanCode: 'X' },
          source: 'spoofed',
          lastImportedAt: '2000-01-01T00:00:00Z',
          lastRunId: 'other-run',
        }),
      );

      expect(outcome).toBe('imported');
      const stored = t.writer.get('L-1');
      expect(stored).toBeDefined();
      expect(stored).not.toHaveProperty('internalScore');
      expect(stored?.address).toEqual({ city: 'Berlin', postalCode: '10115', country: 'DE' });
      expect(stored?.source).toBe(SOURCE);
      expect(stored?.lastImportedAt).toBe(NOW.toISOString());
      expect(stored?.lastRunId).toBe(RUN_ID);
    });

    it('stores amounts in minor units and returns the writer outcome', async () => {
      const t = setup();
      expect(await t.process(rawListing())).toBe('imported');
      expect(await t.process(rawListing({ title: 'Neu' }))).toBe('updated');
      expect(t.writer.size).toBe(1);
      expect(t.writer.get('L-1')?.offers[0]).toEqual({
        offerType: 'RENT',
        coldRent: 90000,
        warmRent: 110000,
        currency: 'EUR',
      });
    });

    it('imports a listing with a SALE and a RENT offer', async () => {
      const t = setup();
      const offers = [
        { offerType: 'SALE', price: '350000', currency: 'EUR' },
        { offerType: 'RENT', coldRent: '1200', currency: 'EUR' },
      ];
      expect(await t.process(rawListing({ offers }))).toBe('imported');
      expect(t.writer.get('L-1')?.offers.map((o) => o.offerType)).toEqual(['SALE', 'RENT']);
    });
  });

  describe('deletion blocklist', () => {
    it('rejects a blocked id with reason „Löschsperre“ and does not write', async () => {
      const writer: ListingWriter = { write: jest.fn() };
      const t = setup({ writer, blocklist: new InMemoryDeletionBlocklist(['L-1']) });

      expect(await t.process(rawListing({ contact: { email: EMAIL } }))).toBe('rejected');
      expect(writer.write).not.toHaveBeenCalled();
      expect(t.entries()).toEqual([
        expect.objectContaining({
          event: 'record.rejected',
          listingId: 'L-1',
          source: SOURCE,
          issues: [{ field: 'id', reason: DELETION_BLOCK_REASON }],
        }),
      ]);
      expect(DELETION_BLOCK_REASON).toBe('Löschsperre');
    });
  });

  describe('PII filter', () => {
    const contact = { name: NAME, phone: PHONE, email: EMAIL };

    it('drops every PII field without allow-list and never logs values', async () => {
      const t = setup();
      expect(await t.process(rawListing({ contact }))).toBe('imported');

      expect(t.writer.get('L-1')?.contact).toEqual({});
      const dropped = t.entries().filter((e) => e['event'] === 'pii.field_dropped');
      expect(dropped.map((e) => [e['listingId'], e['source'], e['field']])).toEqual([
        ['L-1', SOURCE, 'contact.name'],
        ['L-1', SOURCE, 'contact.phone'],
        ['L-1', SOURCE, 'contact.email'],
      ]);
      const log = t.lines.join('\n');
      for (const value of [NAME, PHONE, EMAIL]) expect(log).not.toContain(value);
    });

    it('treats an empty allow-list like a missing one', async () => {
      const t = setup({ piiAllowlist: PiiAllowlistConfig.parse({ allowedFields: [] }) });
      await t.process(rawListing({ contact }));
      expect(t.writer.get('L-1')?.contact).toEqual({});
    });

    it('keeps allow-listed fields and drops the rest', async () => {
      const t = setup({
        piiAllowlist: PiiAllowlistConfig.parse({ allowedFields: ['contact.email'] }),
      });
      await t.process(rawListing({ contact }));

      expect(t.writer.get('L-1')?.contact).toEqual({ email: EMAIL });
      const fields = t
        .entries()
        .flatMap((e) => (e['event'] === 'pii.field_dropped' ? [e['field']] : []));
      expect(fields).toEqual(['contact.name', 'contact.phone']);
      const log = t.lines.join('\n');
      for (const value of [NAME, PHONE, EMAIL]) expect(log).not.toContain(value);
    });

    it('does not reject a listing because of an invalid PII value that is dropped', async () => {
      const t = setup();
      const outcome = await t.process(rawListing({ contact: { phone: 'x'.repeat(500) } }));
      expect(outcome).toBe('imported');
    });

    it('rejects unknown fields in the allow-list config', () => {
      expect(PiiAllowlistConfig.safeParse({ allowedFields: ['contact.mail'] }).success).toBe(false);
    });
  });

  describe('validation', () => {
    const cases: [string, Record<string, unknown>, string[]][] = [
      ['missing required field', { title: undefined }, ['title']],
      [
        'warmRent below coldRent',
        { offers: [{ offerType: 'RENT', coldRent: '900', warmRent: '800', currency: 'EUR' }] },
        ['offers.0.warmRent'],
      ],
      [
        'SALE offer with rent fields',
        {
          offers: [
            {
              offerType: 'SALE',
              price: '1000',
              currency: 'EUR',
              additionalCosts: '100',
              warmRent: '200',
            },
          ],
        },
        ['offers.0.additionalCosts', 'offers.0.warmRent'],
      ],
      ['no offer', { offers: [] }, ['offers']],
      [
        'three offers',
        {
          offers: [
            { offerType: 'SALE', price: '1', currency: 'EUR' },
            { offerType: 'RENT', coldRent: '1', currency: 'EUR' },
            { offerType: 'RENT', coldRent: '2', currency: 'EUR' },
          ],
        },
        ['offers'],
      ],
      [
        'two offers of the same type',
        {
          offers: [
            { offerType: 'SALE', price: '1', currency: 'EUR' },
            { offerType: 'SALE', price: '2', currency: 'EUR' },
          ],
        },
        ['offers'],
      ],
      [
        'unknown offer type',
        { offers: [{ offerType: 'LEASE', price: '1', currency: 'EUR' }] },
        ['offers.0.offerType'],
      ],
      ['listing type not in taxonomy', { listingType: 'castle' }, ['listingType']],
      ['half geo pair', { geo: { lat: 52.5 } }, ['geo.lon']],
    ];

    it.each(cases)('rejects %s and names the field', async (_name, overrides, fields) => {
      const writer: ListingWriter = { write: jest.fn() };
      const t = setup({ writer });
      expect(await t.process(rawListing(overrides))).toBe('rejected');
      expect(writer.write).not.toHaveBeenCalled();
      expect(t.rejectedFields()).toEqual(fields);
    });

    it('logs every invalid field of one listing in one rejection', async () => {
      const t = setup();
      await t.process(
        rawListing({ title: '', rooms: 0.3, address: { city: 'Berlin', country: 'Germany' } }),
      );
      expect(t.rejectedFields()).toEqual(
        expect.arrayContaining(['title', 'rooms', 'address.postalCode', 'address.country']),
      );
      const rejection = t.entries().find((e) => e['event'] === 'record.rejected');
      expect(rejection?.['listingId']).toBe('L-1');
      expect(t.lines.join('\n')).not.toContain('Germany');
    });

    it('rejects a record without valid id without attributing logs to it', async () => {
      const t = setup();
      expect(await t.process(rawListing({ id: '', contact: { email: EMAIL } }))).toBe('rejected');
      expect(t.entries().map((e) => e['event'])).toEqual(['record.rejected']);
      expect(t.entries()[0]).not.toHaveProperty('listingId');
      expect(t.rejectedFields()).toEqual(['id']);
    });
  });

  describe('media and tours', () => {
    const drops = (entries: Record<string, unknown>[]) =>
      entries
        .filter((e) => e['event'] === 'media.dropped')
        .map(({ kind, index, reason, url }) => ({ kind, index, reason, url }));

    it('drops invalid media and foreign tours, keeps the rest and derives providerCode', async () => {
      const t = setup();
      const outcome = await t.process(
        rawListing({
          media: [
            { url: 'http://img.example/insecure.jpg' },
            { url: 'https://img.example/ok.jpg', caption: 'dropped field' },
            { url: '/relative.jpg' },
            {},
            { url: `https://img.example/${'a'.repeat(2048)}` },
          ],
          tours: [
            { url: 'https://evil.example/tour', providerCode: 'matterport' },
            { url: MATTERPORT, providerCode: 'spoofed' },
            { url: 'https://KUULA.co/share/1' },
            { url: 'http://my.matterport.com/show/?m=x' },
          ],
        }),
      );

      expect(outcome).toBe('imported');
      const stored = t.writer.get('L-1');
      expect(stored?.media).toEqual([{ url: 'https://img.example/ok.jpg' }]);
      expect(stored?.tours).toEqual([
        { url: MATTERPORT, providerCode: 'matterport' },
        { url: 'https://KUULA.co/share/1', providerCode: 'kuula' },
      ]);
      expect(drops(t.entries())).toEqual([
        { kind: 'media', index: 0, reason: 'URL scheme is not https', url: undefined },
        { kind: 'media', index: 2, reason: 'URL is not absolute', url: undefined },
        { kind: 'media', index: 3, reason: 'URL is missing', url: undefined },
        {
          kind: 'media',
          index: 4,
          reason: 'URL is longer than 2048 characters',
          url: undefined,
        },
        {
          kind: 'tour',
          index: 0,
          reason: 'tour host is not on the tour allow-list',
          url: 'https://evil.example/tour',
        },
        { kind: 'tour', index: 3, reason: 'URL scheme is not https', url: undefined },
      ]);
      expect(
        t.entries().every((e) => e['event'] !== 'media.dropped' || e['listingId'] === 'L-1'),
      ).toBe(true);
    });

    it('keeps the first 50 media and 10 tours and logs the excess count', async () => {
      const t = setup();
      const media = Array.from({ length: 53 }, (_, i) => ({ url: `https://img.example/${i}.jpg` }));
      const tours = Array.from({ length: 12 }, (_, i) => ({ url: `${MATTERPORT}${i}` }));
      expect(await t.process(rawListing({ media: [{ url: 'ftp://x' }, ...media], tours }))).toBe(
        'imported',
      );

      const stored = t.writer.get('L-1');
      expect(stored?.media).toEqual(media.slice(0, 50));
      expect(stored?.tours.map((tour) => tour.url)).toEqual(tours.slice(0, 10).map((x) => x.url));
      const truncated = t.entries().filter((e) => e['event'] === 'media.truncated');
      expect(
        truncated.map(({ listingId, kind, droppedCount }) => ({ listingId, kind, droppedCount })),
      ).toEqual([
        { listingId: 'L-1', kind: 'media', droppedCount: 3 },
        { listingId: 'L-1', kind: 'tour', droppedCount: 2 },
      ]);
    });

    it('accepts a listing without media and tours', async () => {
      const t = setup();
      expect(await t.process(rawListing({ media: undefined, tours: undefined }))).toBe('imported');
      expect(t.writer.get('L-1')).toMatchObject({ media: [], tours: [] });
    });

    it('rejects duplicate host names in the tour provider config', () => {
      const result = TourProvidersConfig.safeParse({
        providers: [
          { code: 'a', hostnames: ['tour.example'] },
          { code: 'b', hostnames: ['TOUR.example'] },
        ],
      });
      expect(result.success).toBe(false);
    });
  });
});
