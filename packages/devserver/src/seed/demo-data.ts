import type { DirectoryUser } from '@open-estate/core';

// DEV ONLY: fictitious demo data of the local server. Names, e-mail addresses (example.org) and
// URLs are made up; media URLs point to example.org and do not resolve (the SPA hides broken
// images). Coordinates are approximate city centres.

export const AGENCIES = {
  nordlicht: { agencyId: 'agency-nordlicht', displayName: 'Nordlicht Immobilien' },
  alpenblick: { agencyId: 'agency-alpenblick', displayName: 'Alpenblick Makler' },
} as const;

export interface SeedUser extends DirectoryUser {
  role: 'PLATFORM_ADMIN' | 'AGENCY_ADMIN' | 'AGENCY_MEMBER';
  agencyId?: string;
  hint: string;
}

export const USERS = {
  platformAdmin: {
    userId: 'user-paula-platform',
    email: 'paula.platform@example.org',
    displayName: 'Paula Plattform',
    role: 'PLATFORM_ADMIN',
    hint: 'Admin mode: agencies, suspension, platform monitoring, operations',
  },
  agencyAdmin: {
    userId: 'user-anna-nordlicht',
    email: 'anna.admin@nordlicht.example.org',
    displayName: 'Anna Albers',
    role: 'AGENCY_ADMIN',
    agencyId: AGENCIES.nordlicht.agencyId,
    hint: 'Listings, versions, monitoring, team and machine access',
  },
  agencyMember: {
    userId: 'user-max-nordlicht',
    email: 'max.member@nordlicht.example.org',
    displayName: 'Max Meyer',
    role: 'AGENCY_MEMBER',
    agencyId: AGENCIES.nordlicht.agencyId,
    hint: 'Listings and monitoring only (no team, no machine access, no audit log)',
  },
  suspendedAdmin: {
    userId: 'user-sepp-alpenblick',
    email: 'sepp.admin@alpenblick.example.org',
    displayName: 'Sepp Brandl',
    role: 'AGENCY_ADMIN',
    agencyId: AGENCIES.alpenblick.agencyId,
    hint: 'Agency is suspended: the Management API answers 403 AGENCY_SUSPENDED',
  },
} as const satisfies Record<string, SeedUser>;

export const SEED_USERS: readonly SeedUser[] = Object.values(USERS);

/** Listing_Inhalt as the Management_API accepts it (amounts and area as decimal strings). */
export type ContentInput = Record<string, unknown>;

/** `[DEMO]` title prefix and localized description marker, so demo data is unmistakable. */
export const DEMO_TITLE_PREFIX = '[DEMO]';
const DEMO_MARKER_DE = 'DEMO-Beispieldaten –';
const DEMO_MARKER_EN = 'DEMO sample data –';

const demoTitle = (value: unknown): unknown =>
  typeof value === 'string' && !value.startsWith(DEMO_TITLE_PREFIX)
    ? `${DEMO_TITLE_PREFIX} ${value}`
    : value;
const demoDescription = (value: unknown, locale: unknown): unknown => {
  if (typeof value !== 'string') return value;
  if (value.startsWith(DEMO_MARKER_DE) || value.startsWith(DEMO_MARKER_EN)) return value;
  const marker =
    typeof locale === 'string' && locale.toLowerCase().startsWith('de')
      ? DEMO_MARKER_DE
      : DEMO_MARKER_EN;
  return `${marker} ${value}`;
};

/**
 * Stamps listing content (and every translation) as demo data: `[DEMO]` title prefix and a
 * localized marker in front of each description. Idempotent, so re-applying changes nothing.
 * Applied centrally while seeding, so any entry added here or to the CRM feed is marked.
 */
export function markDemoContent(content: ContentInput): ContentInput {
  const translations = Array.isArray(content['translations'])
    ? (content['translations'] as Record<string, unknown>[]).map((t) => ({
        ...t,
        title: demoTitle(t['title']),
        description: demoDescription(t['description'], t['locale']),
      }))
    : content['translations'];
  return {
    ...content,
    title: demoTitle(content['title']),
    description: demoDescription(content['description'], content['originalLocale']),
    ...(translations !== undefined && { translations }),
  };
}

const media = (slug: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    url: `https://example.org/open-estate/demo/${slug}/photo-${i + 1}.jpg`,
  }));

const sale = (price: string) => ({ offerType: 'SALE', price, currency: 'EUR' });
const rent = (coldRent: string, additionalCosts?: string) => ({
  offerType: 'RENT',
  coldRent,
  currency: 'EUR',
  ...(additionalCosts !== undefined && {
    additionalCosts,
    warmRent: (Number(coldRent) + Number(additionalCosts)).toFixed(2),
  }),
});

export interface ManualSeed {
  key: string;
  agency: keyof typeof AGENCIES;
  customId?: string;
  status: 'ACTIVE' | 'INACTIVE';
  daysAgo: number;
  content: ContentInput;
}

/** Listings created in the portal (origin `MANUAL`). */
export const MANUAL_LISTINGS: readonly ManualSeed[] = [
  {
    key: 'berlin-mitte',
    agency: 'nordlicht',
    customId: 'NL-BER-001',
    status: 'ACTIVE',
    daysAgo: 24,
    content: {
      originalLocale: 'de',
      title: 'Helle 3-Zimmer-Altbauwohnung in Berlin-Mitte',
      description:
        'Altbau mit Stuck, Dielenboden und Südbalkon. Ruhige Seitenstraße, fünf Minuten zur U-Bahn.',
      translations: [
        {
          locale: 'en',
          title: 'Bright 3-room period apartment in Berlin-Mitte',
          description:
            'Period building with stucco, wooden floors and a south-facing balcony. Quiet side street.',
        },
      ],
      offers: [sale('489000.00')],
      listingType: 'apartment_unit',
      rooms: 3,
      area: '82.5',
      address: { city: 'Berlin', postalCode: '10115', country: 'DE', street: 'Ackerstraße 12' },
      geo: { lat: 52.532, lon: 13.385 },
      media: media('berlin-mitte', 3),
      tours: [],
    },
  },
  {
    key: 'berlin-prenzlauer-berg',
    agency: 'nordlicht',
    status: 'ACTIVE',
    daysAgo: 22,
    content: {
      originalLocale: 'de',
      title: '2-Zimmer-Wohnung am Kollwitzplatz',
      description: 'Renovierte Wohnung im 3. OG mit Einbauküche und Blick ins Grüne.',
      translations: [],
      offers: [rent('1450.00', '230.00')],
      listingType: 'apartment_unit',
      rooms: 2,
      area: '61',
      address: { city: 'Berlin', postalCode: '10435', country: 'DE' },
      geo: { lat: 52.536, lon: 13.418 },
      media: media('berlin-prenzlauer-berg', 2),
      tours: [],
    },
  },
  {
    key: 'hamburg-hafencity',
    agency: 'nordlicht',
    customId: 'NL-HH-003',
    status: 'ACTIVE',
    daysAgo: 21,
    content: {
      originalLocale: 'de',
      title: 'Loft in der HafenCity – Kauf oder Miete',
      description: 'Offener Grundriss, bodentiefe Fenster und Blick auf die Elbe.',
      translations: [
        {
          locale: 'en',
          title: 'Loft in HafenCity – buy or rent',
          description: 'Open floor plan, floor-to-ceiling windows and a view of the Elbe.',
        },
      ],
      offers: [sale('615000.00'), rent('1950.00')],
      listingType: 'loft',
      rooms: 3.5,
      area: '118.4',
      address: { city: 'Hamburg', postalCode: '20457', country: 'DE' },
      geo: { lat: 53.541, lon: 9.984 },
      media: media('hamburg-hafencity', 4),
      tours: [],
    },
  },
  {
    key: 'hamburg-eppendorf',
    agency: 'nordlicht',
    customId: 'NL-HH-004',
    status: 'INACTIVE',
    daysAgo: 6,
    content: {
      originalLocale: 'de',
      title: 'Penthouse mit Dachterrasse in Eppendorf (Entwurf)',
      description: 'Noch nicht veröffentlicht: Exposé und Fotos folgen nach dem Fototermin.',
      translations: [],
      offers: [sale('1150000.00')],
      listingType: 'penthouse',
      rooms: 4,
      area: '142',
      address: { city: 'Hamburg', postalCode: '20249', country: 'DE' },
      media: [],
      tours: [],
    },
  },
  {
    key: 'luebeck-reihenhaus',
    agency: 'nordlicht',
    status: 'ACTIVE',
    daysAgo: 18,
    content: {
      originalLocale: 'de',
      title: 'Reihenmittelhaus mit Garten in Lübeck-St. Jürgen',
      description: 'Familienfreundlich, 4 Zimmer, Gartenseite nach Westen, Stellplatz.',
      translations: [],
      offers: [sale('395000.00')],
      listingType: 'terraced',
      rooms: 4,
      area: '112',
      address: { city: 'Lübeck', postalCode: '23562', country: 'DE' },
      geo: { lat: 53.85, lon: 10.69 },
      media: media('luebeck-reihenhaus', 2),
      tours: [],
    },
  },
  {
    key: 'kiel-wohnung',
    agency: 'nordlicht',
    status: 'ACTIVE',
    daysAgo: 15,
    content: {
      originalLocale: 'de',
      title: 'Gemütliche 2-Zimmer-Wohnung nahe der Kiellinie',
      description: 'Ideal für Pendler und Studierende, Balkon, Kellerabteil.',
      translations: [],
      offers: [rent('890.00', '160.00')],
      listingType: 'apartment_unit',
      rooms: 2,
      area: '54',
      address: { city: 'Kiel', postalCode: '24105', country: 'DE' },
      media: media('kiel-wohnung', 1),
      tours: [],
    },
  },
  {
    key: 'potsdam-villa',
    agency: 'nordlicht',
    customId: 'NL-P-007',
    status: 'INACTIVE',
    daysAgo: 12,
    content: {
      originalLocale: 'de',
      title: 'Stadtvilla am Heiligen See (reserviert)',
      description: 'Reserviert – derzeit nicht öffentlich sichtbar.',
      translations: [],
      offers: [sale('1890000.00')],
      listingType: 'villa',
      rooms: 7,
      area: '286',
      address: { city: 'Potsdam', postalCode: '14469', country: 'DE' },
      media: media('potsdam-villa', 2),
      tours: [],
    },
  },
  {
    key: 'berlin-buero',
    agency: 'nordlicht',
    status: 'ACTIVE',
    daysAgo: 10,
    content: {
      originalLocale: 'en',
      title: 'Office loft in Kreuzberg',
      description: 'Bright office space for 12–15 workplaces, close to the canal.',
      translations: [
        {
          locale: 'de',
          title: 'Büroloft in Kreuzberg',
          description: 'Helle Bürofläche für 12–15 Arbeitsplätze, nahe am Kanal.',
        },
      ],
      offers: [rent('3200.00', '540.00')],
      listingType: 'office',
      rooms: 5,
      area: '210',
      address: { city: 'Berlin', postalCode: '10999', country: 'DE' },
      geo: { lat: 52.497, lon: 13.42 },
      media: media('berlin-buero', 2),
      tours: [],
    },
  },
  {
    key: 'muenchen-schwabing',
    agency: 'alpenblick',
    status: 'ACTIVE',
    daysAgo: 26,
    content: {
      originalLocale: 'de',
      title: '2-Zimmer-Wohnung in Schwabing',
      description: 'Altbau, Parkett, wenige Schritte zum Englischen Garten.',
      translations: [],
      offers: [rent('1690.00', '280.00')],
      listingType: 'apartment_unit',
      rooms: 2,
      area: '63',
      address: { city: 'München', postalCode: '80802', country: 'DE' },
      geo: { lat: 48.162, lon: 11.586 },
      media: media('muenchen-schwabing', 2),
      tours: [],
    },
  },
  {
    key: 'salzburg-haus',
    agency: 'alpenblick',
    status: 'ACTIVE',
    daysAgo: 25,
    content: {
      originalLocale: 'de',
      title: 'Einfamilienhaus mit Garten und Bergblick',
      description: 'Freistehendes Haus, großer Garten, Doppelgarage.',
      translations: [],
      offers: [{ offerType: 'SALE', price: '1250000.00', currency: 'EUR' }],
      listingType: 'single_family',
      rooms: 5.5,
      area: '184',
      address: { city: 'Salzburg', postalCode: '5020', country: 'AT' },
      media: media('salzburg-haus', 3),
      tours: [],
    },
  },
  {
    key: 'garmisch-chalet',
    agency: 'alpenblick',
    status: 'ACTIVE',
    daysAgo: 23,
    content: {
      originalLocale: 'de',
      title: 'Chalet mit Zugspitzblick',
      description: 'Holzbauweise, Kamin, Sauna, ruhige Hanglage.',
      translations: [],
      offers: [sale('2150000.00')],
      listingType: 'villa',
      rooms: 6,
      area: '240',
      address: { city: 'Garmisch-Partenkirchen', postalCode: '82467', country: 'DE' },
      media: media('garmisch-chalet', 3),
      tours: [],
    },
  },
  {
    key: 'bangkok-sukhumvit',
    agency: 'nordlicht',
    customId: 'NL-TH-010',
    status: 'ACTIVE',
    daysAgo: 17,
    content: {
      originalLocale: 'en',
      title: 'Condominium with skyline view in Sukhumvit',
      description: 'High floor, shared pool and gym, a few minutes from the BTS skytrain.',
      translations: [
        {
          locale: 'de',
          title: 'Eigentumswohnung mit Skyline-Blick in Sukhumvit',
          description: 'Hohe Etage, Gemeinschaftspool und Fitnessraum, wenige Minuten zur BTS.',
        },
        {
          locale: 'th',
          title: 'คอนโดวิวเมืองย่านสุขุมวิท',
          description: 'ชั้นสูง สระว่ายน้ำและฟิตเนสส่วนกลาง ใกล้รถไฟฟ้า BTS',
        },
      ],
      offers: [rent('45000.00')],
      listingType: 'condominium',
      rooms: 1.5,
      area: '54.2',
      address: { city: 'Bangkok', postalCode: '10110', country: 'TH' },
      geo: { lat: 13.737, lon: 100.56 },
      media: media('bangkok-sukhumvit', 3),
      tours: [],
    },
  },
  {
    key: 'pattaya-jomtien',
    agency: 'nordlicht',
    customId: 'NL-TH-011',
    status: 'ACTIVE',
    daysAgo: 16,
    content: {
      originalLocale: 'en',
      title: 'Beachfront condo in Pattaya',
      description: 'Sea view, a short walk to Jomtien Beach, with a shared rooftop pool.',
      translations: [
        {
          locale: 'de',
          title: 'Strandnahe Eigentumswohnung in Pattaya',
          description: 'Meerblick, wenige Minuten zum Jomtien Beach, Dachpool zur Mitnutzung.',
        },
        {
          locale: 'th',
          title: 'คอนโดติดชายหาดในพัทยา',
          description: 'วิวทะเล ใกล้หาดจอมเทียน สระว่ายน้ำบนดาดฟ้า',
        },
      ],
      offers: [sale('4200000.00'), rent('32000.00')],
      listingType: 'condominium',
      rooms: 2,
      area: '68',
      address: { city: 'Pattaya', postalCode: '20150', country: 'TH' },
      geo: { lat: 12.923, lon: 100.882 },
      media: media('pattaya-jomtien', 4),
      tours: [],
    },
  },
];

/** CRM feed records of the Nordlicht connector (origin `IMPORT`), keyed by Custom_Id. */
export const CRM_RECORDS = {
  winterhude: {
    customId: 'CRM-4711',
    status: 'ACTIVE',
    originalLocale: 'de',
    title: '4-Zimmer-Wohnung mit Alsterblick in Winterhude',
    description: 'Großzügige Wohnung mit zwei Balkonen, Aufzug und Tiefgaragenstellplatz.',
    translations: [],
    offers: [sale('829000.00')],
    listingType: 'apartment_unit',
    rooms: 4,
    area: '121',
    address: { city: 'Hamburg', postalCode: '22301', country: 'DE' },
    geo: { lat: 53.585, lon: 10.005 },
    sourceUrl: 'https://crm.example.org/nordlicht/expose/4711',
    media: media('crm-4711', 3),
  },
  charlottenburg: {
    customId: 'CRM-4712',
    status: 'ACTIVE',
    originalLocale: 'de',
    title: '3,5-Zimmer-Altbau in Charlottenburg',
    description: 'Hohe Decken, Flügeltüren, Wannenbad mit Fenster. Nähe Savignyplatz.',
    translations: [],
    offers: [rent('2100.00', '360.00')],
    listingType: 'apartment_unit',
    rooms: 3.5,
    area: '104',
    address: { city: 'Berlin', postalCode: '10623', country: 'DE' },
    geo: { lat: 52.506, lon: 13.322 },
    sourceUrl: 'https://crm.example.org/nordlicht/expose/4712',
    media: media('crm-4712', 2),
  },
  rostock: {
    customId: 'CRM-4713',
    status: 'ACTIVE',
    originalLocale: 'de',
    title: 'Ferienwohnung in Warnemünde, 200 m zum Strand',
    description: 'Vermietete Ferienwohnung mit Ostseeblick, ideal als Kapitalanlage.',
    translations: [],
    offers: [sale('349000.00')],
    listingType: 'apartment_unit',
    rooms: 2,
    area: '58',
    address: { city: 'Rostock', postalCode: '18119', country: 'DE' },
    sourceUrl: 'https://crm.example.org/nordlicht/expose/4713',
    media: media('crm-4713', 2),
  },
  bremen: {
    customId: 'CRM-4714',
    status: 'INACTIVE',
    originalLocale: 'de',
    title: 'Doppelhaushälfte in Bremen-Horn',
    description: 'Wird derzeit renoviert, Veröffentlichung nach Abschluss der Arbeiten.',
    translations: [],
    offers: [sale('545000.00')],
    listingType: 'semi_detached',
    rooms: 5,
    area: '138',
    address: { city: 'Bremen', postalCode: '28359', country: 'DE' },
    sourceUrl: 'https://crm.example.org/nordlicht/expose/4714',
    media: [],
  },
} as const satisfies Record<string, ContentInput & { customId: string }>;

/** Records the import pipeline rejects (field names and reasons appear in the monitoring). */
export const CRM_INVALID_RECORDS = {
  unknownType: {
    ...CRM_RECORDS.bremen,
    customId: 'CRM-4720',
    title: 'Wasserschloss im Umland',
    listingType: 'castle',
  },
  negativeArea: { ...CRM_RECORDS.rostock, customId: 'CRM-4721', area: '-5' },
  noIdentity: {
    originalLocale: 'de',
    title: 'Datensatz ohne Kennung',
    description: 'Fehlt im CRM: weder id noch customId.',
    translations: [],
    offers: [sale('100000.00')],
    listingType: 'apartment_unit',
    rooms: 1,
    area: '30',
    address: { city: 'Hamburg', postalCode: '20095', country: 'DE' },
    sourceUrl: 'https://crm.example.org/nordlicht/expose/unknown',
    media: [],
  },
} as const satisfies Record<string, ContentInput>;
