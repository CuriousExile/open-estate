import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createAccessGuard,
  createListingService,
  createLocationService,
  createSearchService,
  hashApiKey,
  InMemoryApiKeyStore,
  InMemoryRateLimitCounterStore,
  InMemorySearchProvider,
  StaticAccessConfigSource,
  type AccessConfig,
  type AccessGuard,
  type ListingService,
  type LocationService,
  type SearchService,
} from '@open-estate/core';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  type Listing,
  type LocaleConfig,
  type TourProvidersConfig,
} from '@open-estate/shared';
import {
  createCorsPolicy,
  createDiscoveryHandlers,
  createListingDetailHandler,
  createListingsHandler,
  createLocationsHandler,
  createRouter,
  LISTINGS_ROUTES,
  withCors,
  type DiscoveryInput,
  type ListingsHandler,
  type ListingsRequest,
} from '@open-estate/api';

// Fixture and helpers for the doc examples in docs/api.md and docs/mcp.md: the examples are
// produced by the real handlers over this data, and the docs-examples tests re-run every example
// and compare the documented output, so the documentation cannot drift from the code.

export const REPO_ROOT = path.resolve(__dirname, '../../../..');

export function readDoc(name: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'docs', name), 'utf8');
}

/** Placeholders used in the doc's shell snippets. */
export const DOC_API_URL = 'https://abc123defg.execute-api.eu-central-1.amazonaws.com/dev/';
export const DOC_API_KEY = 'oe_live_7c1f0d2a9b8e4f36a5d1c0b2e9f8a7d6';

export const DOC_TAXONOMY = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
/** Repository default `packages/frontend/public/i18n-config.json`. */
export const DOC_LOCALES: LocaleConfig = {
  defaultLocale: 'en',
  enabled: [
    { locale: 'en', label: 'English' },
    { locale: 'de', label: 'Deutsch' },
  ],
};
export const DOC_TOUR_PROVIDERS: TourProvidersConfig = {
  providers: [{ code: 'matterport', hostnames: ['my.matterport.com'] }],
};
export const DOC_DEFAULT_CURRENCY = 'EUR';
/** Default rate limit (Req 17.1). */
export const DOC_RATE_LIMIT = { requests: 60, windowSeconds: 60 } as const;
/** Fixed clock 15 s into a 60-s window → `Retry-After: 45`. */
export const DOC_NOW = Date.parse('2026-11-05T09:30:15.000Z');

const provenance = {
  source: 'example-partner',
  lastImportedAt: '2026-11-05T03:00:12.000Z',
  lastRunId: 'run-20261105-0300',
} as const;

/** Example inventory: one listing with SALE + RENT, one RENT only (Berlin), one house in Hamburg. */
export const DOC_LISTINGS: readonly Listing[] = [
  {
    id: 'berlin-mitte-0042',
    originalLocale: 'de',
    title: 'Helle 3,5-Zimmer-Altbauwohnung mit Balkon in Mitte',
    description:
      'Sanierte Altbauwohnung im 3. OG mit Stuck, Dielenboden und Südbalkon. ' +
      'Kauf oder Miete möglich.',
    translations: [
      {
        locale: 'en',
        title: 'Bright 3.5-room period apartment with balcony in Mitte',
        description:
          'Renovated period apartment on the 3rd floor with stucco, wooden floors and a ' +
          'south-facing balcony. Available to buy or to rent.',
      },
    ],
    offers: [
      { offerType: 'SALE', price: 450_000_00, currency: 'EUR' },
      {
        offerType: 'RENT',
        coldRent: 1_250_50,
        currency: 'EUR',
        additionalCosts: 280_00,
        warmRent: 1_530_50,
      },
    ],
    listingType: 'apartment_unit',
    rooms: 3.5,
    area: 92_40,
    address: { city: 'Berlin', postalCode: '10115', country: 'DE', street: 'Invalidenstraße 12' },
    geo: { lat: 52.530644, lon: 13.383068 },
    sourceUrl: 'https://partner.example/expose/berlin-mitte-0042',
    media: [
      { url: 'https://media.partner.example/berlin-mitte-0042/living-room.jpg' },
      { url: 'https://media.partner.example/berlin-mitte-0042/balcony.jpg' },
    ],
    tours: [{ url: 'https://my.matterport.com/show/?m=Zh14WDtkjdC', providerCode: 'matterport' }],
    ...provenance,
  },
  {
    id: 'berlin-pankow-0107',
    originalLocale: 'de',
    title: '2-Zimmer-Wohnung nahe Bürgerpark',
    description: 'Ruhige Wohnung mit Einbauküche, ab sofort frei.',
    translations: [],
    offers: [{ offerType: 'RENT', coldRent: 980_00, currency: 'EUR' }],
    listingType: 'apartment_unit',
    rooms: 2,
    area: 61_00,
    address: { city: 'Berlin', postalCode: '13187', country: 'DE' },
    sourceUrl: 'https://partner.example/expose/berlin-pankow-0107',
    media: [],
    tours: [],
    ...provenance,
  },
  {
    id: 'hamburg-altona-0311',
    originalLocale: 'de',
    title: 'Reihenhaus mit Garten in Altona',
    description: '',
    translations: [],
    offers: [{ offerType: 'SALE', price: 789_000_00, currency: 'EUR' }],
    listingType: 'terraced',
    rooms: 5,
    area: 134_00,
    address: { city: 'Hamburg', postalCode: '22765', country: 'DE' },
    sourceUrl: 'https://partner.example/expose/hamburg-altona-0311',
    media: [],
    tours: [],
    ...provenance,
  },
];

export interface DocReadModel extends DiscoveryInput {
  guard: AccessGuard;
  search: SearchService;
  listings: ListingService;
  locations: LocationService;
}

/** Read model over {@link DOC_LISTINGS}, like `initReadModel` builds it in the Lambdas. */
export function docReadModel(mode: AccessConfig['mode'] = 'open'): DocReadModel {
  const provider = new InMemorySearchProvider(DOC_LISTINGS);
  const schemas = buildSchemas(DOC_TAXONOMY, DOC_LOCALES);
  const guard = createAccessGuard({
    config: new StaticAccessConfigSource({ mode, rateLimit: DOC_RATE_LIMIT }),
    apiKeys: new InMemoryApiKeyStore([
      { keyId: 'k-7c1f0d2a', keyHash: hashApiKey(DOC_API_KEY), status: 'active' },
    ]),
    counters: new InMemoryRateLimitCounterStore(),
    clock: () => DOC_NOW,
  });
  return {
    guard,
    schemas,
    taxonomy: DOC_TAXONOMY,
    locales: DOC_LOCALES,
    defaultCurrency: DOC_DEFAULT_CURRENCY,
    tourProviders: DOC_TOUR_PROVIDERS,
    search: createSearchService({
      provider,
      taxonomy: DOC_TAXONOMY,
      tourProviders: DOC_TOUR_PROVIDERS,
      defaultCurrency: DOC_DEFAULT_CURRENCY,
    }),
    listings: createListingService({ provider, taxonomy: DOC_TAXONOMY }),
    locations: createLocationService({ provider }),
  };
}

// ---------------------------------------------------------------------------------------------
// Markdown code blocks
// ---------------------------------------------------------------------------------------------

/** Fenced block whose info string is `<lang> <kind>:<name> [flags]`, e.g. `json response:search`. */
export interface TaggedBlock {
  lang: string;
  kind: string;
  name: string;
  flags: string[];
  content: string;
}

const FENCE = /^```(\S*)[ \t]*(.*)\n([\s\S]*?)^```[ \t]*$/gm;

export function taggedBlocks(markdown: string): TaggedBlock[] {
  const blocks: TaggedBlock[] = [];
  for (const [, lang = '', info = '', content = ''] of markdown.matchAll(FENCE)) {
    const [tag, ...flags] = info.trim().split(/\s+/);
    const colon = tag?.indexOf(':') ?? -1;
    if (tag === undefined || colon <= 0) continue;
    blocks.push({ lang, kind: tag.slice(0, colon), name: tag.slice(colon + 1), flags, content });
  }
  return blocks;
}

/** Blocks of one kind keyed by name; a duplicate name is a doc error. */
export function blocksByName(
  blocks: readonly TaggedBlock[],
  kind: string,
): Map<string, TaggedBlock> {
  const map = new Map<string, TaggedBlock>();
  for (const block of blocks.filter((b) => b.kind === kind)) {
    if (map.has(block.name)) throw new Error(`Duplicate block ${kind}:${block.name}`);
    map.set(block.name, block);
  }
  return map;
}

/** `HTTP/1.1 200 OK` + `Name: value` lines → status and headers. */
export function parseHead(content: string): {
  statusCode: number;
  headers: Record<string, string>;
} {
  const [statusLine = '', ...lines] = content.trim().split('\n');
  const status = /^HTTP\/[\d.]+ (\d{3})\b/.exec(statusLine);
  if (status === null) throw new Error(`Invalid status line: ${statusLine}`);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error(`Invalid header line: ${line}`);
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { statusCode: Number(status[1]), headers };
}

/**
 * Splits a shell command into words: single and double quotes, `\`-newline continuations and
 * `$VAR`/`${VAR}` from `vars` (double quotes and bare words only). Enough for the doc snippets.
 */
export function shellWords(command: string, vars: Readonly<Record<string, string>>): string[] {
  const words: string[] = [];
  let word: string | undefined;
  const src = command.replace(/\\\n/g, ' ');
  const expand = (text: string) =>
    text.replace(/\$\{(\w+)\}|\$(\w+)/g, (match, a?: string, b?: string) => {
      const value = vars[(a ?? b) as string];
      if (value === undefined) throw new Error(`Unknown variable ${match}`);
      return value;
    });
  for (let i = 0; i < src.length; i++) {
    const ch = src.charAt(i);
    if (/\s/.test(ch)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (ch === "'" || ch === '"') {
      const end = src.indexOf(ch, i + 1);
      if (end === -1) throw new Error(`Unterminated quote in: ${command}`);
      const inner = src.slice(i + 1, end);
      word = (word ?? '') + (ch === '"' ? expand(inner) : inner);
      i = end;
    } else {
      const end = src.slice(i).search(/[\s'"]/);
      const chunk = end === -1 ? src.slice(i) : src.slice(i, i + end);
      word = (word ?? '') + expand(chunk);
      i += chunk.length - 1;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

export interface CurlRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
}

/** Parses a `curl` call with `-sS`, `-i`, `-X`, `-H`/`--header`, `-d`/`--data` and one URL. */
export function parseCurl(command: string, vars: Readonly<Record<string, string>>): CurlRequest {
  const [cmd, ...args] = shellWords(command.trim(), vars);
  if (cmd !== 'curl') throw new Error(`Not a curl command: ${command}`);
  const headers: Record<string, string> = {};
  let method: string | undefined;
  let url: URL | undefined;
  let body: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const value = () => {
      const next = args[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '-sS' || arg === '-s' || arg === '-i') continue;
    if (arg === '-X') method = value();
    else if (arg === '-H' || arg === '--header') {
      const header = value();
      const colon = header.indexOf(':');
      headers[header.slice(0, colon).trim()] = header.slice(colon + 1).trim();
    } else if (arg === '-d' || arg === '--data') body = value();
    else if (arg.startsWith('-')) throw new Error(`Unsupported curl option ${arg}`);
    else if (url === undefined) url = new URL(arg);
    else throw new Error(`Second URL in: ${command}`);
  }
  if (url === undefined) throw new Error(`No URL in: ${command}`);
  return {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    url,
    headers,
    ...(body !== undefined && { body }),
  };
}

// ---------------------------------------------------------------------------------------------
// Search_API examples
// ---------------------------------------------------------------------------------------------

/** Frontend origin of the example deployment (CORS allowlist). */
export const DOC_FRONTEND_ORIGIN = 'https://estate.example.org';

/** All Search_API routes as the Lambda composes them (`createListingsHandlerFromEnv`). */
export function docApiHandler(model: DocReadModel): ListingsHandler {
  const { guard, schemas } = model;
  const discovery = createDiscoveryHandlers(guard, model);
  const router = createRouter({
    [LISTINGS_ROUTES.search]: createListingsHandler({ guard, schemas, search: model.search }),
    [LISTINGS_ROUTES.detail]: createListingDetailHandler({
      guard,
      schemas,
      listings: model.listings,
    }),
    [LISTINGS_ROUTES.openapi]: discovery.openapi,
    [LISTINGS_ROUTES.meta]: discovery.meta,
    [LISTINGS_ROUTES.locations]: createLocationsHandler({ guard, locations: model.locations }),
  });
  return withCors(async () => createCorsPolicy([DOC_FRONTEND_ORIGIN]), router);
}

export const DOC_VARS = { API_URL: DOC_API_URL, API_KEY: DOC_API_KEY } as const;

const STAGE_PATH = new URL(DOC_API_URL).pathname.replace(/\/$/, '');

/** The API Gateway REST proxy event for a documented `curl` call. */
export function toListingsRequest(curl: CurlRequest): ListingsRequest {
  if (!curl.url.pathname.startsWith(`${STAGE_PATH}/`)) {
    throw new Error(`URL outside the stage: ${curl.url.href}`);
  }
  const path = curl.url.pathname.slice(STAGE_PATH.length);
  const detail = /^\/listings\/([^/]+)$/.exec(path);
  const multi: Record<string, string[]> = {};
  for (const [key, value] of curl.url.searchParams) (multi[key] ??= []).push(value);
  return {
    httpMethod: curl.method,
    resource: detail === null ? path : LISTINGS_ROUTES.detail,
    pathParameters: detail === null ? null : { id: detail[1] as string },
    // API Gateway: the last value per key, and all values in the multi-value map.
    queryStringParameters: Object.fromEntries(
      Object.entries(multi).map(([key, values]) => [key, values[values.length - 1] as string]),
    ),
    multiValueQueryStringParameters: multi,
    headers: curl.headers,
    requestContext: { identity: { sourceIp: '203.0.113.7' } },
  };
}

/** Flags of a request block: `access=api-keys`, `repeat=<n>` (only the last response counts). */
export function exampleOptions(flags: readonly string[]): {
  mode: AccessConfig['mode'];
  repeat: number;
} {
  let mode: AccessConfig['mode'] = 'open';
  let repeat = 1;
  for (const flag of flags) {
    const [key, value = ''] = flag.split('=');
    if (key === 'access' && (value === 'open' || value === 'api-keys')) mode = value;
    else if (key === 'repeat' && /^\d+$/.test(value)) repeat = Number(value);
    else throw new Error(`Unknown example flag ${flag}`);
  }
  return { mode, repeat };
}
