// Public listings of the local demo as the Search_API delivers them to the SPA (seed:
// packages/devserver/src/seed/). Written out on purpose instead of derived from the seed: a change of
// the demo data should fail these tests visibly, and the expected results of a search stay readable.
// The seed is not changed by the search tests, so every worker sees the same data.

export interface DemoListing {
  /** Title as delivered for the English UI (`Accept-Language: en`), `[DEMO]` prefix included. */
  title: string;
  /** Title for the German UI, if the listing has a German version that differs. */
  titleDe?: string;
  city: string;
  postalCode: string;
  country: 'DE' | 'TH';
  offerTypes: readonly ('SALE' | 'RENT')[];
  rooms: number;
  /** Living area in m². */
  area: number;
  /** Number of images. */
  media: number;
}

export const LISTINGS = {
  berlinMitte: {
    title: '[DEMO] Bright 3-room period apartment in Berlin-Mitte',
    titleDe: '[DEMO] Helle 3-Zimmer-Altbauwohnung in Berlin-Mitte',
    city: 'Berlin',
    postalCode: '10115',
    country: 'DE',
    offerTypes: ['SALE'],
    rooms: 3,
    area: 82.5,
    media: 4,
  },
  hamburgWinterhude: {
    // Portal edit of the CRM listing CRM-4711; see the demo-data test about the missing [DEMO].
    title: '4-Zimmer-Wohnung mit Alsterblick – provisionsfrei',
    city: 'Hamburg',
    postalCode: '22301',
    country: 'DE',
    offerTypes: ['SALE'],
    rooms: 4,
    area: 121,
    media: 3,
  },
  hamburgHafencity: {
    title: '[DEMO] Loft in HafenCity – buy or rent',
    titleDe: '[DEMO] Loft in der HafenCity – Kauf oder Miete',
    city: 'Hamburg',
    postalCode: '20457',
    country: 'DE',
    offerTypes: ['SALE', 'RENT'],
    rooms: 3.5,
    area: 118.4,
    media: 5,
  },
  luebeck: {
    title: '[DEMO] Reihenmittelhaus mit Garten in Lübeck-St. Jürgen',
    city: 'Lübeck',
    postalCode: '23562',
    country: 'DE',
    offerTypes: ['SALE'],
    rooms: 4,
    area: 112,
    media: 2,
  },
  rostock: {
    title: '[DEMO] Ferienwohnung in Warnemünde, 200 m zum Strand',
    city: 'Rostock',
    postalCode: '18119',
    country: 'DE',
    offerTypes: ['SALE'],
    rooms: 2,
    area: 58,
    media: 0,
  },
  pattaya: {
    title: '[DEMO] Beachfront condo in Pattaya',
    titleDe: '[DEMO] Strandnahe Eigentumswohnung in Pattaya',
    city: 'Pattaya',
    postalCode: '20150',
    country: 'TH',
    offerTypes: ['SALE', 'RENT'],
    rooms: 2,
    area: 68,
    media: 5,
  },
  berlinCharlottenburg: {
    title: '[DEMO] 3,5-Zimmer-Altbau in Charlottenburg',
    city: 'Berlin',
    postalCode: '10623',
    country: 'DE',
    offerTypes: ['RENT'],
    rooms: 3.5,
    area: 104,
    media: 2,
  },
  berlinPrenzlauerBerg: {
    title: '[DEMO] 2-Zimmer-Wohnung am Kollwitzplatz',
    city: 'Berlin',
    postalCode: '10435',
    country: 'DE',
    offerTypes: ['RENT'],
    rooms: 2,
    area: 61,
    media: 2,
  },
  berlinKreuzbergOffice: {
    title: '[DEMO] Office loft in Kreuzberg',
    titleDe: '[DEMO] Büroloft in Kreuzberg',
    city: 'Berlin',
    postalCode: '10999',
    country: 'DE',
    offerTypes: ['RENT'],
    rooms: 5,
    area: 210,
    media: 1,
  },
  kiel: {
    title: '[DEMO] Gemütliche 2-Zimmer-Wohnung nahe der Kiellinie',
    city: 'Kiel',
    postalCode: '24105',
    country: 'DE',
    offerTypes: ['RENT'],
    rooms: 2,
    area: 54,
    media: 1,
  },
  bangkok: {
    title: '[DEMO] Condominium with skyline view in Sukhumvit',
    titleDe: '[DEMO] Eigentumswohnung mit Skyline-Blick in Sukhumvit',
    city: 'Bangkok',
    postalCode: '10110',
    country: 'TH',
    offerTypes: ['RENT'],
    rooms: 1.5,
    area: 54.2,
    media: 3,
  },
} as const satisfies Record<string, DemoListing>;

export type ListingKey = keyof typeof LISTINGS;

const ALL = Object.values(LISTINGS) as readonly DemoListing[];

/** Titles of the public listings with an offer of `offerType` (any city, any country). */
export function titlesFor(offerType: 'SALE' | 'RENT'): string[] {
  return ALL.filter((listing) => listing.offerTypes.includes(offerType)).map((l) => l.title);
}

/**
 * Seeded but not public: listings of the suspended agency "Alpenblick Makler" and drafts
 * (`INACTIVE`). Their cities have no other listing, so a city search must come back empty.
 */
export const HIDDEN_CITIES = {
  suspendedAgency: ['München', 'Salzburg', 'Garmisch-Partenkirchen'],
  drafts: ['Potsdam', 'Bremen'],
} as const;

/** Cities with public listings per country, as `GET /api/locations` reports them. */
export const CITIES = {
  DE: ['Berlin', 'Hamburg', 'Kiel', 'Lübeck', 'Rostock'],
  TH: ['Bangkok', 'Pattaya'],
} as const;
