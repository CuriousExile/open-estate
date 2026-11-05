// Example listings for the walking skeleton (Req 12.1, 11.1). All data is fictitious: URLs point to
// example.org, there is no contact data, and coordinates are approximate city centres. Every title
// is prefixed with `[DEMO]` and every description starts with an explicit demo marker so the sample
// data is unmistakably recognisable as demo content wherever a listing is shown.
import { Listing, type ListingInput } from '@open-estate/shared';

export const SEED_SOURCE = 'seed';
/** Fixed provenance values keep repeated seeding idempotent (same ids, same items). */
export const SEED_RUN_ID = 'seed-v1';
export const SEED_IMPORTED_AT = '2026-01-01T00:00:00Z';

/** Prefix on every seed title; makes demo listings obvious in lists, detail views and the API. */
export const DEMO_TITLE_PREFIX = '[DEMO]';
/** Marker opening every seed description, in the listing's original language. */
const DEMO_MARKER_DE = 'DEMO-Beispieldaten –';
const DEMO_MARKER_EN = 'DEMO sample data –';

const MATTERPORT = 'matterport';

function media(id: string, count: number): ListingInput['media'] {
  return Array.from({ length: count }, (_, i) => ({
    url: `https://example.org/open-estate/seed/${id}/photo-${i + 1}.jpg`,
  }));
}

function tour(id: string): ListingInput['tours'] {
  // Matterport host from the default tour allow-list; the model id is a placeholder.
  return [{ url: `https://my.matterport.com/show/?m=example-${id}`, providerCode: MATTERPORT }];
}

/** Common fields for all seed listings. */
function base(
  id: string,
): Pick<ListingInput, 'id' | 'sourceUrl' | 'source' | 'lastImportedAt' | 'lastRunId'> {
  return {
    id,
    sourceUrl: `https://example.org/open-estate/listings/${id}`,
    source: SEED_SOURCE,
    lastImportedAt: SEED_IMPORTED_AT,
    lastRunId: SEED_RUN_ID,
  };
}

/** Seed listings in the API/input representation (amounts and area as decimal strings). */
export const SEED_LISTING_INPUTS: readonly ListingInput[] = [
  {
    ...base('seed-de-berlin-001'),
    originalLocale: 'de-DE',
    title: 'Helle 3-Zimmer-Altbauwohnung in Berlin-Mitte',
    description: 'Beispiel-Listing: Altbau mit Stuck, Dielenboden und Südbalkon.',
    translations: [
      {
        locale: 'en',
        title: 'Bright 3-room period apartment in Berlin-Mitte',
        description:
          'Example listing: period building with stucco, wooden floors and a south balcony.',
      },
    ],
    offers: [{ offerType: 'SALE', price: '489000.00', currency: 'EUR' }],
    listingType: 'apartment_unit',
    rooms: 3,
    area: '82.5',
    address: { city: 'Berlin', postalCode: '10115', country: 'DE' },
    geo: { lat: 52.532, lon: 13.385 },
    media: media('seed-de-berlin-001', 3),
    tours: tour('seed-de-berlin-001'),
  },
  {
    ...base('seed-de-munich-002'),
    originalLocale: 'de-DE',
    title: 'Penthouse mit Dachterrasse in der Münchner Altstadt',
    description: 'Beispiel-Listing: 2,5 Zimmer, Dachterrasse mit Blick über die Altstadt.',
    translations: [
      {
        locale: 'en',
        title: 'Penthouse with roof terrace in Munich old town',
        description: 'Example listing: 2.5 rooms, roof terrace overlooking the old town.',
      },
    ],
    offers: [
      {
        offerType: 'RENT',
        coldRent: '2850.00',
        additionalCosts: '420.00',
        warmRent: '3270.00',
        currency: 'EUR',
      },
    ],
    listingType: 'penthouse',
    rooms: 2.5,
    area: '96',
    address: { city: 'München', postalCode: '80331', country: 'DE' },
    geo: { lat: 48.137, lon: 11.575 },
    media: media('seed-de-munich-002', 4),
    tours: tour('seed-de-munich-002'),
  },
  {
    ...base('seed-de-hamburg-003'),
    originalLocale: 'de-DE',
    title: 'Loft am Hafen – Kauf oder Miete',
    description: 'Beispiel-Listing: offener Grundriss, bodentiefe Fenster, Blick auf die Elbe.',
    translations: [],
    offers: [
      { offerType: 'SALE', price: '615000.00', currency: 'EUR' },
      { offerType: 'RENT', coldRent: '1950.00', currency: 'EUR' },
    ],
    listingType: 'loft',
    rooms: 3.5,
    area: '118.4',
    address: { city: 'Hamburg', postalCode: '20457', country: 'DE' },
    geo: { lat: 53.541, lon: 9.984 },
    media: media('seed-de-hamburg-003', 2),
    tours: [],
  },
  {
    ...base('seed-at-vienna-004'),
    originalLocale: 'de-AT',
    title: 'Gründerzeitwohnung im 1. Bezirk',
    description: 'Beispiel-Listing: hohe Räume, Fischgrätparkett, ruhige Innenhoflage.',
    translations: [
      {
        locale: 'en',
        title: 'Period apartment in Vienna’s 1st district',
        description: 'Example listing: high ceilings, herringbone parquet, quiet courtyard side.',
      },
    ],
    offers: [
      {
        offerType: 'RENT',
        coldRent: '1480.00',
        additionalCosts: '260.00',
        warmRent: '1740.00',
        currency: 'EUR',
      },
    ],
    listingType: 'apartment_unit',
    rooms: 2,
    area: '71',
    address: { city: 'Wien', postalCode: '1010', country: 'AT' },
    geo: { lat: 48.208, lon: 16.373 },
    media: media('seed-at-vienna-004', 3),
    tours: [],
  },
  {
    ...base('seed-at-salzburg-005'),
    originalLocale: 'de-AT',
    title: 'Einfamilienhaus mit Garten und Bergblick',
    description: 'Beispiel-Listing: freistehendes Haus, großer Garten, Doppelgarage.',
    translations: [],
    offers: [{ offerType: 'SALE', price: '1250000.00', currency: 'EUR' }],
    listingType: 'single_family',
    rooms: 5.5,
    area: '184',
    address: { city: 'Salzburg', postalCode: '5020', country: 'AT' },
    media: media('seed-at-salzburg-005', 5),
    tours: tour('seed-at-salzburg-005'),
  },
  {
    ...base('seed-th-phuket-006'),
    originalLocale: 'en',
    title: 'Pool villa near Kata Beach',
    description: 'Example listing: private pool, tropical garden, five minutes to the beach.',
    translations: [
      {
        locale: 'de',
        title: 'Poolvilla nahe Kata Beach',
        description: 'Beispiel-Listing: privater Pool, tropischer Garten, fünf Minuten zum Strand.',
      },
      {
        locale: 'th',
        title: 'พูลวิลล่าใกล้หาดกะตะ',
        description: 'ตัวอย่างประกาศ: สระว่ายน้ำส่วนตัว สวนเขตร้อน',
      },
    ],
    offers: [
      { offerType: 'SALE', price: '28500000.00', currency: 'THB' },
      { offerType: 'RENT', coldRent: '145000.00', currency: 'THB' },
    ],
    listingType: 'villa',
    rooms: 4,
    area: '320',
    address: { city: 'Phuket', postalCode: '83100', country: 'TH' },
    geo: { lat: 7.82, lon: 98.3 },
    media: media('seed-th-phuket-006', 6),
    tours: tour('seed-th-phuket-006'),
  },
  {
    ...base('seed-th-bangkok-007'),
    originalLocale: 'en',
    title: 'Condominium with skyline view in Sukhumvit',
    description: 'Example listing: high floor, shared pool and gym, close to the BTS.',
    translations: [],
    offers: [{ offerType: 'RENT', coldRent: '45000.00', currency: 'THB' }],
    listingType: 'condominium',
    rooms: 1.5,
    area: '54.2',
    address: { city: 'Bangkok', postalCode: '10110', country: 'TH' },
    geo: { lat: 13.737, lon: 100.56 },
    media: media('seed-th-bangkok-007', 2),
    tours: [],
  },
  {
    ...base('seed-th-pattaya-009'),
    originalLocale: 'en',
    title: 'Beachfront condo in Pattaya',
    description: 'Example listing: sea view, walk to Jomtien Beach, shared rooftop pool.',
    translations: [
      {
        locale: 'de',
        title: 'Strandnahe Eigentumswohnung in Pattaya',
        description:
          'Beispiel-Listing: Meerblick, wenige Minuten zum Jomtien Beach, Dachpool zur Mitnutzung.',
      },
      {
        locale: 'th',
        title: 'คอนโดติดชายหาดในพัทยา',
        description: 'ตัวอย่างประกาศ: วิวทะเล ใกล้หาดจอมเทียน สระว่ายน้ำบนดาดฟ้า',
      },
    ],
    offers: [
      { offerType: 'SALE', price: '4200000.00', currency: 'THB' },
      { offerType: 'RENT', coldRent: '32000.00', currency: 'THB' },
    ],
    listingType: 'condominium',
    rooms: 2,
    area: '68',
    address: { city: 'Pattaya', postalCode: '20150', country: 'TH' },
    geo: { lat: 12.923, lon: 100.882 },
    media: media('seed-th-pattaya-009', 4),
    tours: tour('seed-th-pattaya-009'),
  },
  {
    ...base('seed-th-chiangmai-008'),
    originalLocale: 'en',
    title: 'Family house in Chiang Mai',
    description: 'Example listing: three bedrooms, covered terrace, quiet residential area.',
    translations: [],
    offers: [{ offerType: 'SALE', price: '7900000.00', currency: 'THB' }],
    listingType: 'single_family',
    rooms: 3,
    area: '165',
    address: { city: 'Chiang Mai', postalCode: '50200', country: 'TH' },
    media: media('seed-th-chiangmai-008', 3),
    tours: [],
  },
];

/** Seed listings in the internal representation (minor units); throws if any input is invalid. */
export function seedListings(): Listing[] {
  return SEED_LISTING_INPUTS.map((input) => Listing.parse(markAsDemo(input)));
}

/**
 * Stamps a listing and all its translations as demo content: `[DEMO]` prefix on every title and a
 * localized demo marker in front of every description. Idempotent — a title that is already
 * prefixed is left unchanged — so repeated seeding keeps the same values. Keeping this in one place
 * means any listing added to `SEED_LISTING_INPUTS` is marked automatically.
 */
export function markAsDemo(input: ListingInput): ListingInput {
  const marker = (locale: string): string =>
    locale.toLowerCase().startsWith('de') ? DEMO_MARKER_DE : DEMO_MARKER_EN;
  const title = (value: string): string =>
    value.startsWith(DEMO_TITLE_PREFIX) ? value : `${DEMO_TITLE_PREFIX} ${value}`;
  const description = (value: string, locale: string): string =>
    value.startsWith(DEMO_MARKER_DE) || value.startsWith(DEMO_MARKER_EN)
      ? value
      : `${marker(locale)} ${value}`;
  return {
    ...input,
    title: title(input.title),
    description: description(input.description, input.originalLocale),
    translations: input.translations?.map((t) => ({
      ...t,
      title: title(t.title),
      description: description(t.description, t.locale),
    })),
  };
}
