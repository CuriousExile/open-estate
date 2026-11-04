// Feature: real-estate-platform, Property 18: Medien-/Tour-Bereinigung beim Import
import {
  createRunLogger,
  ImportPipeline,
  InMemoryDeletionBlocklist,
  InMemoryListingWriter,
  TOUR_HOST_NOT_ALLOWED,
  type RecordProcessingContext,
} from '@open-estate/ingestion';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  formatDecimal,
  LISTING_BOUNDS as B,
  TourProvidersConfig,
  type Listing,
  type Offer,
} from '@open-estate/shared';
import fc from 'fast-check';
import { arbListing, arbUrl } from '../../shared/test/arbitraries';

/**
 * Property 18: for any candidate with arbitrary media/tour lists and any tour allow-list, the
 * stored media are exactly the first 50 valid https URLs and the stored tours exactly the first
 * 10 valid tours with an allowed host — in delivery order, with the `providerCode` of the owning
 * provider; the listing itself is not rejected, and every drop/truncation is logged with listing
 * id and connector.
 *
 * Strategy: every generated element carries its expected classification by construction (valid
 * URL, invalid URL, or — for tours — the exact host used). The reference model below decides
 * from that tag and the allow-list alone; it does not reuse the URL checks of the pipeline.
 *
 * **Validates: Requirements 16.1, 16.2, 16.4, 16.5, 16.8, 16.11**
 */

const NOW = new Date('2026-11-05T10:00:00.000Z');
const RUN_ID = 'run-18';
const SOURCE = 'property-source';

const listingSchema = buildSchemas(assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG), {
  defaultLocale: 'de',
  enabled: [{ locale: 'de', label: 'Deutsch' }],
}).listing;

type Obj = Record<string, unknown>;
type Media = Listing['media'][number];
type Tour = Listing['tours'][number];

// ---------------------------------------------------------------------------------------------
// Input representation (as in Property 11, without contact and with generated media/tours)
// ---------------------------------------------------------------------------------------------

function toInputOffer(offer: Offer): Obj {
  if (offer.offerType === 'SALE') {
    return { offerType: 'SALE', price: formatDecimal(offer.price), currency: offer.currency };
  }
  return {
    offerType: 'RENT',
    coldRent: formatDecimal(offer.coldRent),
    currency: offer.currency,
    ...(offer.additionalCosts !== undefined && {
      additionalCosts: formatDecimal(offer.additionalCosts),
    }),
    ...(offer.warmRent !== undefined && { warmRent: formatDecimal(offer.warmRent) }),
  };
}

function toInput(listing: Listing, media: readonly unknown[], tours: readonly unknown[]): Obj {
  return {
    id: listing.id,
    originalLocale: listing.originalLocale,
    title: listing.title,
    description: listing.description,
    translations: listing.translations.map((t) => ({ ...t })),
    offers: listing.offers.map(toInputOffer),
    listingType: listing.listingType,
    rooms: listing.rooms,
    area: formatDecimal(listing.area),
    address: { ...listing.address },
    ...(listing.geo !== undefined && { geo: { ...listing.geo } }),
    sourceUrl: listing.sourceUrl,
    media: [...media],
    tours: [...tours],
  };
}

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

/** Element as delivered plus what the model needs to know about it. */
type Generated =
  | { readonly element: unknown; readonly valid: true; readonly url: string; readonly host: string }
  | { readonly element: unknown; readonly valid: false };

const PREFIX = 'https://img.example/';
const atLength = (length: number): string => PREFIX + 'a'.repeat(length - PREFIX.length);

/** URL values that are not storable (Req 16.5), each with a label for counterexamples. */
const arbInvalidUrl: fc.Arbitrary<unknown> = fc.oneof(
  arbUrl(['http']),
  fc.constantFrom<unknown>(
    '',
    '/images/1.jpg',
    'images/1.jpg',
    '//img.example/1.jpg',
    'https://',
    'not a url',
    'ftp://img.example/1.jpg',
    atLength(B.url.max + 1),
    atLength(B.url.max + 500),
    42,
    null,
  ),
);

/** Elements without a usable `url` field at all. */
const arbBrokenElement: fc.Arbitrary<unknown> = fc.constantFrom<unknown>(
  {},
  { link: 'https://img.example/1.jpg' },
  'https://img.example/1.jpg',
  null,
  7,
  ['https://img.example/1.jpg'],
);

const invalid = (element: unknown): Generated => ({ element, valid: false });

/** `validWeight` against 3 for invalid elements: long lists use a high value to exceed the limit. */
const arbMediaElement = (validWeight: number): fc.Arbitrary<Generated> =>
  fc.oneof(
    {
      weight: validWeight,
      arbitrary: fc
        .oneof(
          { weight: 9, arbitrary: arbUrl() },
          { weight: 1, arbitrary: fc.constant(atLength(B.url.max)) },
        )
        .map((url) => ({
          element: { url },
          valid: true as const,
          url,
          host: new URL(url).hostname,
        })),
    },
    { weight: 2, arbitrary: arbInvalidUrl.map((url) => invalid({ url })) },
    { weight: 1, arbitrary: arbBrokenElement.map(invalid) },
  );

/** Provider host names; a subset is put on the allow-list per run. */
const PROVIDER_HOSTS = ['my.matterport.com', 'kuula.co', 'tours.example', 'view.Tour3D.example'];
const FOREIGN_HOSTS = ['evil.example', 'matterport.com', 'tours.example.evil', 'kuula.co.example'];

/** Same letters, random case per character. */
const arbMixedCase = (text: string): fc.Arbitrary<string> =>
  fc
    .array(fc.boolean(), { minLength: text.length, maxLength: text.length })
    .map((upper) =>
      [...text].map((c, i) => (upper[i] ? c.toUpperCase() : c.toLowerCase())).join(''),
    );

/** Host as written in the URL; candidates include subdomains of provider hosts (never allowed). */
const arbTourHost: fc.Arbitrary<string> = fc
  .oneof(
    { weight: 8, arbitrary: fc.constantFrom(...PROVIDER_HOSTS) },
    { weight: 1, arbitrary: fc.constantFrom(...FOREIGN_HOSTS) },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.constantFrom('www', 'sub', 'a.b'), fc.constantFrom(...PROVIDER_HOSTS))
        .map(([sub, host]) => `${sub}.${host}`),
    },
  )
  .chain(arbMixedCase);

const arbTourElement = (validWeight: number): fc.Arbitrary<Generated> =>
  fc.oneof(
    {
      weight: validWeight,
      arbitrary: fc
        .record(
          {
            host: arbTourHost,
            port: fc.constantFrom('', ':8443'),
            path: fc.stringMatching(/^[a-z0-9-]{0,20}$/),
            // A delivered provider code must be ignored (derived from the host instead).
            providerCode: fc.constantFrom<unknown>('fake', 'kuula', 'matterport', '', 42),
          },
          { requiredKeys: ['host', 'port', 'path'] },
        )
        .map(({ host, port, path, providerCode }) => {
          const url = `https://${host}${port}/${path}`;
          const element = providerCode === undefined ? { url } : { url, providerCode };
          return { element, valid: true as const, url, host: host.toLowerCase() };
        }),
    },
    {
      weight: 2,
      arbitrary: fc
        .tuple(arbInvalidUrl, fc.option(fc.constant('kuula'), { nil: undefined }))
        .map(([url, providerCode]) =>
          invalid(providerCode === undefined ? { url } : { url, providerCode }),
        ),
    },
    { weight: 1, arbitrary: arbBrokenElement.map(invalid) },
  );

/** Short mixed lists, or long, mostly valid lists that usually exceed the limit. */
const arbList = (
  element: (validWeight: number) => fc.Arbitrary<Generated>,
  short: number,
  long: { min: number; max: number },
): fc.Arbitrary<Generated[]> =>
  fc.oneof(
    fc.array(element(6), { maxLength: short }),
    fc.array(element(24), { minLength: long.min, maxLength: long.max }),
  );

/**
 * 0–3 providers with distinct codes, owning distinct hosts (random case in config). Every third
 * allow-list covers all provider hosts so that long tour lists can exceed the limit.
 */
const arbAllowList: fc.Arbitrary<TourProvidersConfig> = fc
  .oneof(
    { weight: 2, arbitrary: fc.shuffledSubarray(PROVIDER_HOSTS) },
    { weight: 1, arbitrary: fc.constant(PROVIDER_HOSTS) },
  )
  .chain((hosts) =>
    fc.tuple(
      ...hosts.map((host) => arbMixedCase(host)),
      fc.integer({
        min: hosts.length === PROVIDER_HOSTS.length ? 1 : 0,
        max: Math.min(3, hosts.length),
      }),
    ),
  )
  .map((values) => {
    const hosts = values.slice(0, -1) as string[];
    const count = values[values.length - 1] as number;
    // Distribute the hosts round-robin over `count` providers; unassigned hosts stay foreign.
    const providers = Array.from({ length: count }, (_, p) => ({
      code: `provider-${p}`,
      hostnames: hosts.filter((_, i) => i % count === p),
    })).filter((p) => p.hostnames.length > 0);
    return TourProvidersConfig.parse({ providers });
  });

// ---------------------------------------------------------------------------------------------
// Reference model
// ---------------------------------------------------------------------------------------------

interface ExpectedDrop {
  readonly kind: 'media' | 'tour';
  readonly index: number;
  /** Only for tours rejected because of their host. */
  readonly url?: string;
}

interface Model {
  readonly media: Media[];
  readonly tours: Tour[];
  readonly drops: ExpectedDrop[];
  readonly truncated: { kind: 'media' | 'tour'; droppedCount: number }[];
}

function model(media: Generated[], tours: Generated[], config: TourProvidersConfig): Model {
  const providerOf = new Map<string, string>();
  for (const { code, hostnames } of config.providers) {
    for (const host of hostnames) providerOf.set(host.toLowerCase(), code);
  }
  const drops: ExpectedDrop[] = [];
  const truncated: Model['truncated'] = [];

  const keptMedia: Media[] = [];
  media.forEach((g, index) => {
    if (g.valid) keptMedia.push({ url: g.url });
    else drops.push({ kind: 'media', index });
  });

  const keptTours: Tour[] = [];
  tours.forEach((g, index) => {
    if (!g.valid) {
      drops.push({ kind: 'tour', index });
      return;
    }
    const providerCode = providerOf.get(g.host);
    if (providerCode === undefined) drops.push({ kind: 'tour', index, url: g.url });
    else keptTours.push({ url: g.url, providerCode });
  });

  if (keptMedia.length > B.media.max) {
    truncated.push({ kind: 'media', droppedCount: keptMedia.length - B.media.max });
  }
  if (keptTours.length > B.tours.max) {
    truncated.push({ kind: 'tour', droppedCount: keptTours.length - B.tours.max });
  }
  return {
    media: keptMedia.slice(0, B.media.max),
    tours: keptTours.slice(0, B.tours.max),
    drops,
    truncated,
  };
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

async function runImport(input: Obj, tourProviders: TourProvidersConfig) {
  const lines: string[] = [];
  const logger = createRunLogger({
    runId: RUN_ID,
    source: SOURCE,
    sink: (line) => lines.push(line),
    now: () => NOW,
  });
  const store = new InMemoryListingWriter();
  const pipeline = new ImportPipeline({
    listingSchema,
    blocklist: new InMemoryDeletionBlocklist(),
    writer: store,
    tourProviders,
    now: () => NOW,
  });
  const ctx: RecordProcessingContext = { runId: RUN_ID, source: SOURCE, logger };
  const outcome = await pipeline.process(input, ctx);
  const events = lines.map((line) => JSON.parse(line) as Obj);
  return { outcome, store, events };
}

const byKindAndIndex = (a: Obj, b: Obj): number =>
  String(a['kind']).localeCompare(String(b['kind'])) || Number(a['index']) - Number(b['index']);

describe('Property 18: Medien-/Tour-Bereinigung beim Import', () => {
  it('stores the first 50 valid media / 10 allowed tours in order and logs every drop', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbListing(),
        arbList(arbMediaElement, 15, { min: 50, max: 70 }),
        arbList(arbTourElement, 6, { min: 12, max: 20 }),
        arbAllowList,
        async (listing, media, tours, allowList) => {
          const expected = model(media, tours, allowList);
          const input = toInput(
            listing,
            media.map((g) => structuredClone(g.element)),
            tours.map((g) => structuredClone(g.element)),
          );

          const { outcome, store, events } = await runImport(input, allowList);

          // The listing itself is never rejected because of media or tours.
          expect(outcome).toBe('imported');
          expect(events.filter((e) => e['event'] === 'record.rejected')).toEqual([]);
          const stored = store.get(listing.id);
          expect(stored?.media).toEqual(expected.media);
          expect(stored?.tours).toEqual(expected.tours);

          // Exactly one media.dropped per dropped element, with listing id and connector.
          const dropped = events.filter((e) => e['event'] === 'media.dropped').sort(byKindAndIndex);
          expect(dropped.map(({ kind, index, url }) => ({ kind, index, url }))).toEqual(
            [...expected.drops]
              .sort((a, b) => byKindAndIndex({ ...a }, { ...b }))
              .map(({ kind, index, url }) => ({ kind, index, url })),
          );
          for (const event of dropped) {
            expect(event).toMatchObject({ listingId: listing.id, source: SOURCE, runId: RUN_ID });
            expect(typeof event['reason']).toBe('string');
            expect(event['reason']).not.toBe('');
            // Host rejections (Req 16.4) carry the URL and their own reason; URL problems do not.
            if (event['url'] === undefined) {
              expect(event['reason']).not.toBe(TOUR_HOST_NOT_ALLOWED);
              expect(Object.hasOwn(event, 'url')).toBe(false);
            } else {
              expect(event['reason']).toBe(TOUR_HOST_NOT_ALLOWED);
            }
          }

          // Truncation: one entry per affected list with the number of surplus elements.
          const truncated = events.filter((e) => e['event'] === 'media.truncated');
          expect(truncated.map(({ kind, droppedCount }) => ({ kind, droppedCount }))).toEqual(
            expected.truncated,
          );
          for (const event of truncated) {
            expect(event).toMatchObject({ listingId: listing.id, source: SOURCE, runId: RUN_ID });
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
