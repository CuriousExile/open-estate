// Load test of the Duplikat-Erkennung (duplicate-detection task 13.3, Req 5.7, 10.9): request
// bodies for `POST /listings` of the Management_API and the capacity the Duplikat_Abgleich needs.
//
// Creation latency (Req 5.7: at most 300 ms more at p95 with 200 candidates): a crowd of listings
// around one point (one geo cell, every one with its own house number, so none is a duplicate of
// another) makes every later creation there meet all of them as candidates, capped at
// `maxCandidates` (200). The same creations far apart from each other meet none. The difference of
// the two p95 values is the additional latency of the Duplikat_Prüfung.

/** Centre of the crowd (Berlin-Mitte); every crowd listing lies in the same 0.001° geo cell. */
export const CROWD_CENTRE = { lat: 52.5321, lon: 13.3851 } as const;
export const CROWD_POSTAL_CODE = '10115';
/** More than the default `maxCandidates`, so the limit is reached. */
export const DEFAULT_CROWD_SIZE = 250;
export const DEFAULT_PROBE_COUNT = 300;

export type CreateBody = { content: Record<string, unknown>; status: 'INACTIVE' };

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const WORDS = [
  'Altbau',
  'Balkon',
  'ruhig',
  'hell',
  'Garten',
  'Dachterrasse',
  'Neubau',
  'saniert',
  'Stuck',
  'Parkett',
  'Aufzug',
  'Keller',
];

function text(rand: () => number, words: number): string {
  return Array.from({ length: words }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ');
}

function body(
  rand: () => number,
  place: { city: string; postalCode: string; street: string; lat: number; lon: number },
  index: number,
): CreateBody {
  return {
    content: {
      originalLocale: 'de',
      title: `Lasttest ${index}: ${text(rand, 4)}`,
      description: text(rand, 12),
      translations: [],
      offers: [
        {
          offerType: 'SALE',
          price: `${200_000 + Math.floor(rand() * 600_000)}.00`,
          currency: 'EUR',
        },
      ],
      listingType: 'apartment_unit',
      rooms: 1 + Math.floor(rand() * 5),
      area: `${40 + Math.floor(rand() * 100)}.00`,
      address: {
        city: place.city,
        postalCode: place.postalCode,
        country: 'DE',
        street: place.street,
      },
      geo: { lat: place.lat, lon: place.lon },
      media: [],
      tours: [],
    },
    status: 'INACTIVE',
  };
}

/** Offset within the crowd cell (< 0.001°). */
const jitter = (rand: () => number) => Math.floor(rand() * 8) / 10_000;

/**
 * The crowd: `count` listings in one geo cell, each with its own house number (different
 * addresses are never duplicates, Req 3.3), so they are candidates of each other but not flagged.
 */
export function crowdBodies(count: number, seed = 1): CreateBody[] {
  const rand = random(seed);
  return Array.from({ length: count }, (_, i) =>
    body(
      rand,
      {
        city: 'Berlin',
        postalCode: CROWD_POSTAL_CODE,
        street: `Lastteststraße ${i + 1}`,
        lat: CROWD_CENTRE.lat + jitter(rand),
        lon: CROWD_CENTRE.lon + jitter(rand),
      },
      i,
    ),
  );
}

/** Measured creations inside the crowd: every one meets the whole crowd as candidates. */
export function probeBodies(count: number, seed = 2, crowdSize = DEFAULT_CROWD_SIZE): CreateBody[] {
  const rand = random(seed);
  return Array.from({ length: count }, (_, i) =>
    body(
      rand,
      {
        city: 'Berlin',
        postalCode: CROWD_POSTAL_CODE,
        street: `Lastteststraße ${crowdSize + i + 1}`,
        lat: CROWD_CENTRE.lat + jitter(rand),
        lon: CROWD_CENTRE.lon + jitter(rand),
      },
      crowdSize + i,
    ),
  );
}

/**
 * Baseline: the same kind of creations, each in its own postal code and geo cell far from any
 * other listing, so the Duplikat_Prüfung finds no candidate.
 */
export function isolatedBodies(count: number, seed = 3): CreateBody[] {
  const rand = random(seed);
  return Array.from({ length: count }, (_, i) =>
    body(
      rand,
      {
        city: 'Teststadt',
        postalCode: String(20_000 + i).padStart(5, '0'),
        street: `Einzelweg ${i + 1}`,
        // 0.01° apart: never in the same or a neighbouring geo cell.
        lat: 47.5 + (i % 300) * 0.01,
        lon: 6.5 + Math.floor(i / 300) * 0.01,
      },
      i,
    ),
  );
}

/**
 * Throughput one segment of each phase must reach so a Duplikat_Abgleich of `listings` listings
 * with `segments` segments ends within `hours` (Req 10.9): the INDEX, ORPHAN and MATCH phases
 * each go over every listing once, RESOLVE is negligible.
 */
export function requiredSegmentRate(listings: number, segments: number, hours: number): number {
  const phases = 3;
  return (listings * phases) / (segments * hours * 3600);
}
