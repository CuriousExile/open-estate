import type { APIGatewayProxyResult } from 'aws-lambda';
import type { AccessGuard } from '@open-estate/core';
import {
  BINDABLE_ATTRIBUTES,
  Currency,
  ERROR_CODES,
  formatDecimal,
  LISTING_BOUNDS,
  LocalizedListing,
  LocationsDocument,
  requestSchemaOverride,
  SEARCH_QUERY_BOUNDS,
  tourHostIndex,
  type BindableAttribute,
  type ExchangeRatesConfig,
  type LocaleConfig,
  type Schemas,
  type Taxonomy,
  type TourProvidersConfig,
} from '@open-estate/shared';
import { z } from 'zod';
import {
  createDocument,
  type oas32,
  type ZodOpenApiOperationObject,
  type ZodOpenApiResponseObject,
} from 'zod-openapi';
import { guardedRoute, type ListingsHandler } from './listings-handler';

// Discovery endpoints (design: "Search_API", "Request-Pfade"): `GET /openapi.json` (API_Schema,
// Req 3.1, 3.2, 3.7) and `GET /meta` (taxonomy, locales, default currency, tour hosts, field
// bounds; Req 3.7, 15.9, 16.6). Both documents are computed once per Lambda instance from the
// configuration loaded at init; configuration changes take effect with the next cold start
// (restart semantics, Req 15.3).
//
// Access: both routes go through the AccessGuard like every other Search_API route. Req 17.1
// applies the rate limit to *all* requests to the Search_API and Req 17.4 admits only requests
// with a valid key in API-key mode; the design lists discovery as part of the Search_API and
// routes every API-Lambda request through the guard. `/admin/*` is not documented: it is an
// IAM-signed operator interface of a separate Lambda, not part of the public API.

/** Configuration the documents are derived from; a `ReadModel` satisfies it. */
export interface DiscoveryInput {
  schemas: Schemas;
  taxonomy: Taxonomy;
  locales: LocaleConfig;
  defaultCurrency: string;
  tourProviders: TourProvidersConfig;
  /** Optional static exchange rates; `/meta` omits `exchangeRates` without them. */
  exchangeRates?: ExchangeRatesConfig | undefined;
}

export const API_TITLE = 'open-estate Search API';
export const API_VERSION = '0.0.0';

/**
 * Browsers may reuse the documents for 5 minutes; `private` keeps shared caches out, because
 * every request has to pass the AccessGuard (key check, rate limit).
 */
export const DISCOVERY_CACHE_CONTROL = 'private, max-age=300';

// ---------------------------------------------------------------------------------------------
// `/meta`
// ---------------------------------------------------------------------------------------------

const decimalRange = ({ minMinor, maxMinor }: { minMinor: number; maxMinor: number }) => ({
  min: formatDecimal(minMinor),
  max: formatDecimal(maxMinor),
});

/** Field bounds as clients send them: amounts and area as decimal strings (Req 3.2, 4.7). */
function fieldBounds() {
  const { money, area, plotArea, ...listing } = LISTING_BOUNDS;
  return {
    listing: {
      ...listing,
      money: decimalRange(money),
      area: decimalRange(area),
      plotArea: decimalRange(plotArea),
    },
    search: SEARCH_QUERY_BOUNDS,
  };
}

/** `GET /meta` response; the frontend reads `taxonomy`, `locales`, `defaultCurrency`, `tourProviders`. */
export interface MetaDocument {
  /**
   * Every group with all of its type codes, in configuration order (Req 15.9), and the Objektmerkmale
   * its listings may carry (duplicate-detection Req 2.6; all bindable attributes without binding).
   */
  taxonomy: { groups: { code: string; types: string[]; attributes: BindableAttribute[] }[] };
  offerTypes: string[];
  locales: { defaultLocale: string; enabled: { locale: string; label: string }[] };
  defaultCurrency: string;
  /** Lower-cased host names of the tour allow-list (Req 16.6). */
  tourProviders: string[];
  /** `exchange-rates.json` as configured; omitted if the file is missing. */
  exchangeRates?: ExchangeRatesConfig;
  bounds: ReturnType<typeof fieldBounds>;
}

export function buildMetaDocument(input: DiscoveryInput): MetaDocument {
  const rates = input.exchangeRates;
  return {
    taxonomy: {
      groups: input.taxonomy.groups.map((g) => ({
        code: g.code,
        types: [...g.types],
        attributes: [...g.attributes],
      })),
    },
    offerTypes: [...input.schemas.enums.offerTypes],
    locales: {
      defaultLocale: input.locales.defaultLocale,
      enabled: input.locales.enabled.map(({ locale, label }) => ({ locale, label })),
    },
    defaultCurrency: input.defaultCurrency,
    tourProviders: [...tourHostIndex(input.tourProviders).keys()],
    ...(rates !== undefined && {
      exchangeRates: { base: rates.base, asOf: rates.asOf, rates: { ...rates.rates } },
    }),
    bounds: fieldBounds(),
  };
}

// ---------------------------------------------------------------------------------------------
// `/openapi.json`
// ---------------------------------------------------------------------------------------------

/**
 * Registers `schema` as component `id`, rendered in its API (input) representation: amounts and
 * area as decimal strings. Responses reference components by `$ref`, so zod-openapi never renders
 * them in output mode (minor units); the `id` makes nested uses `$ref`s as well.
 */
const component = <T extends z.ZodType>(id: string, schema: T) =>
  schema.meta({ id, unusedIO: 'input' });

/** All component schemas; built per document because the enums come from the configuration. */
function componentSchemas(enums: Schemas['enums']) {
  const ErrorCode = component('ErrorCode', z.enum(ERROR_CODES));
  const ApiError = component(
    'ApiError',
    z.object({
      code: ErrorCode,
      message: z.string().meta({ description: 'Human-readable cause of the error' }),
      field: z.string().optional().meta({ description: 'Affected request field(s)' }),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  );
  const ErrorResponse = component(
    'ErrorResponse',
    z.object({
      errors: z.array(ApiError).min(1),
      retryAfterSeconds: z.number().int().min(1).optional().meta({
        description: 'Only with RATE_LIMITED: seconds until the next admitted request',
      }),
    }),
  );
  // Configured enumerations (Req 3.7).
  const OfferType = component('OfferType', z.enum(enums.offerTypes));
  const PropertyGroup = component('PropertyGroup', z.enum(enums.groups));
  const ListingType = component('ListingType', z.enum(enums.types));
  const EnabledLocale = component(
    'EnabledLocale',
    z.enum(enums.locales).meta({ default: enums.defaultLocale }),
  );

  const LocalizedListingModel = component(
    'LocalizedListing',
    LocalizedListing.extend({
      group: PropertyGroup.optional().meta({
        description: 'Property group of listingType; omitted if the type is not configured',
      }),
    }),
  );
  const SearchPage = component(
    'SearchPage',
    z.object({
      items: z.array(LocalizedListingModel),
      nextPageToken: z.string().optional().meta({ description: 'Absent on the last page' }),
    }),
  );

  const bound = z.record(z.string(), z.union([z.number(), z.string()]));
  const Meta = component(
    'Meta',
    z.object({
      taxonomy: z.object({
        groups: z.array(
          z.object({
            code: PropertyGroup,
            types: z.array(ListingType),
            attributes: z.array(z.enum(BINDABLE_ATTRIBUTES)).meta({
              description:
                'Optional property attributes (Objektmerkmale) listings of this group may carry; ' +
                '`address.unit` stands for the field `address.unit`.',
            }),
          }),
        ),
      }),
      offerTypes: z.array(OfferType),
      locales: z.object({
        defaultLocale: EnabledLocale,
        enabled: z.array(z.object({ locale: EnabledLocale, label: z.string() })),
      }),
      defaultCurrency: Currency,
      tourProviders: z.array(z.string()).meta({ description: 'Allowed 3D-tour host names' }),
      exchangeRates: z
        .object({
          base: Currency,
          asOf: z.string().meta({ format: 'date' }),
          rates: z.record(Currency, z.number()),
        })
        .optional()
        .meta({
          description:
            'Static exchange rates (one unit of base = rates[X] units of X); used for display ' +
            'conversion and convertCurrency=true. Omitted if not configured.',
        }),
      bounds: z.object({
        listing: z.record(z.string(), bound),
        search: z.record(z.string(), bound),
      }),
    }),
  );

  return {
    LocalizedListing: LocalizedListingModel,
    SearchPage,
    Meta,
    Locations: component('Locations', LocationsDocument),
    ErrorResponse,
    ApiError,
    ErrorCode,
    OfferType,
    PropertyGroup,
    ListingType,
    EnabledLocale,
  };
}

/** JSON body referencing a component schema. */
const jsonRef = (name: string) => ({
  'application/json': { schema: { $ref: `#/components/schemas/${name}` } },
});

const errorContent = jsonRef('ErrorResponse');

/** Shared error responses; `id` registers each once under `components.responses`. */
const ERROR_RESPONSES = {
  400: {
    id: 'BadRequest',
    description: 'Invalid request; one error per violation, each naming its parameter.',
    content: errorContent,
  },
  401: {
    id: 'Unauthorized',
    description: 'API-key access is enabled and the key is missing or invalid.',
    content: errorContent,
  },
  404: { id: 'NotFound', description: 'No such listing or resource.', content: errorContent },
  429: {
    id: 'RateLimited',
    description: 'Rate limit exceeded; retry after the given number of seconds.',
    headers: {
      'Retry-After': {
        required: true,
        description: 'Seconds until the next admitted request',
        schema: { type: 'integer', minimum: 1 },
      },
    },
    content: errorContent,
  },
  503: {
    id: 'ServiceUnavailable',
    description: 'Temporarily unavailable (e.g. invalid configuration or storage failure).',
    content: errorContent,
  },
} as const satisfies Record<number, ZodOpenApiResponseObject>;

const { 400: badRequest, 401: unauthorized, 404: notFound } = ERROR_RESPONSES;
const { 429: rateLimited, 503: unavailable } = ERROR_RESPONSES;
const guardErrors = { 401: unauthorized, 429: rateLimited, 503: unavailable };

const ACCEPT_LANGUAGE: oas32.ParameterObject = {
  in: 'header',
  name: 'Accept-Language',
  required: false,
  description: 'Language preference (RFC 9110); the `lang` parameter overrides it.',
  schema: { type: 'string' },
};

/** Parameter descriptions; schemas come from the request schemas (same as the MCP tools). */
function parameterDocs(input: DiscoveryInput): Record<string, string> {
  const locales = input.schemas.enums.locales.join(', ');
  return {
    offerType: 'Only listings with an offer of this type.',
    priceMin: 'Inclusive lower bound of the offer price (cold rent for RENT); requires offerType.',
    priceMax: 'Inclusive upper bound of the offer price (cold rent for RENT); requires offerType.',
    currency: `Currency of priceMin/priceMax; default ${input.defaultCurrency}.`,
    convertCurrency:
      'true: offers in other currencies match as well, compared after converting priceMin/' +
      'priceMax with the static exchange rates of /meta (exchangeRates). Default: only offers ' +
      'in `currency` match.',
    roomsMin: 'Inclusive lower bound of the number of rooms.',
    roomsMax: 'Inclusive upper bound of the number of rooms.',
    areaMin: 'Inclusive lower bound of the living or plot area in m².',
    areaMax: 'Inclusive upper bound of the living or plot area in m².',
    city: 'Exact city name, case-insensitive.',
    postalCode: 'Exact postal code.',
    country: 'Country of the address, ISO 3166-1 alpha-2 in upper case (exact match).',
    group: 'Exactly one property group code; cannot be combined with `types`.',
    types: 'Listing type codes (repeat the parameter), OR-combined; not combinable with `group`.',
    hasTour: 'Only listings with at least one 3D tour of an allowed tour provider.',
    lang:
      `Preferred language (BCP 47), overrides Accept-Language. Enabled locales: ${locales}; ` +
      'other tags fall back to the best available language version.',
    pageSize: 'Number of listings per page.',
    pageToken: 'nextPageToken of the previous page.',
    id: 'Listing id.',
  };
}

/** Generated document (zod-openapi types it with the OpenAPI 3.2 superset of 3.1). */
export type OpenApiDocument = ReturnType<typeof createDocument>;

function isParameterObject(
  param: oas32.ParameterObject | oas32.ReferenceObject,
): param is oas32.ParameterObject {
  return !('$ref' in param);
}

/**
 * Adds descriptions (and the enabled locales on `lang`) to the generated parameters. Done on the
 * document instead of the Zod schemas, so parameter schemas stay identical to the MCP tool input
 * schemas (Req 19.2).
 */
function describeParameters(doc: OpenApiDocument, input: DiscoveryInput): void {
  const docs = parameterDocs(input);
  for (const item of Object.values(doc.paths ?? {})) {
    for (const param of item.get?.parameters ?? []) {
      if (!isParameterObject(param)) continue;
      const description = docs[param.name];
      if (param.description === undefined && description !== undefined) {
        param.description = description;
      }
      if (param.name === 'lang') param['x-enabled-locales'] = [...input.schemas.enums.locales];
    }
  }
}

/** Generic JSON-RPC 2.0 envelope of `POST /mcp` (Streamable HTTP, JSON responses). */
const JsonRpcId = z.union([z.string(), z.int()]);
const JsonRpcRequest = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcId.optional().meta({ description: 'Omitted for notifications' }),
  method: z.string().meta({ examples: ['initialize', 'tools/list', 'tools/call'] }),
  params: z.record(z.string(), z.unknown()).optional(),
});
const JsonRpcResponse = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcId.nullable(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.int(), message: z.string(), data: z.unknown().optional() }).optional(),
});

function operations(input: DiscoveryInput) {
  const { searchQuery, detailQuery } = input.schemas;
  return {
    search: {
      operationId: 'searchListings',
      summary: 'Search listings',
      description:
        'All filters are optional and AND-combined. Amounts and areas are decimal strings; ' +
        'Min > Max yields INVALID_RANGE. Results are paged with nextPageToken.',
      requestParams: { query: searchQuery },
      parameters: [ACCEPT_LANGUAGE],
      responses: {
        200: { description: 'One page of listings.', content: jsonRef('SearchPage') },
        400: badRequest,
        ...guardErrors,
      },
    },
    detail: {
      operationId: 'getListing',
      summary: 'Get one listing',
      requestParams: {
        path: detailQuery.pick({ id: true }),
        query: detailQuery.pick({ lang: true }),
      },
      parameters: [ACCEPT_LANGUAGE],
      responses: {
        200: { description: 'The listing.', content: jsonRef('LocalizedListing') },
        400: badRequest,
        404: notFound,
        ...guardErrors,
      },
    },
    openapi: {
      operationId: 'getOpenApi',
      summary: 'This OpenAPI document',
      responses: {
        200: {
          description: 'OpenAPI 3.1 document of the Search API.',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        ...guardErrors,
      },
    },
    meta: {
      operationId: 'getMeta',
      summary: 'Taxonomy, locales, currencies, tour hosts and field bounds',
      responses: {
        200: { description: 'Platform metadata.', content: jsonRef('Meta') },
        ...guardErrors,
      },
    },
    locations: {
      operationId: 'getLocations',
      summary: 'Countries and cities with public listings',
      description:
        'Every country and every city (per country) that has at least one public listing, with ' +
        'the number of listings. Use the values as `country` and `city` in GET /listings.',
      responses: {
        200: { description: 'Locations with listing counts.', content: jsonRef('Locations') },
        ...guardErrors,
      },
    },
    mcp: {
      operationId: 'mcp',
      summary: 'MCP server (JSON-RPC 2.0, Streamable HTTP, stateless)',
      description:
        'Model Context Protocol endpoint with the tools search_listings, get_listing and ' +
        'list_property_types; their input schemas equal the parameters of GET /listings and ' +
        'GET /listings/{id}. Send `Accept: application/json, text/event-stream`. Tool errors ' +
        'are tool results with isError=true and the ErrorResponse body. JSON-RPC batches ' +
        '(arrays) are not supported and are answered with HTTP 400 and error code -32600.',
      requestBody: { required: true, content: { 'application/json': { schema: JsonRpcRequest } } },
      responses: {
        200: {
          description: 'JSON-RPC response.',
          content: { 'application/json': { schema: JsonRpcResponse } },
        },
        ...guardErrors,
      },
    },
  } satisfies Record<string, ZodOpenApiOperationObject>;
}

/**
 * OpenAPI 3.1 document of the public API, generated from the init-time Zod schemas: every
 * endpoint, every parameter with type, required flag, bounds and enums (taxonomy, offer types,
 * enabled locales), and the listing model in its API representation (Req 3.1, 3.2, 3.7).
 */
export function buildOpenApiDocument(input: DiscoveryInput): OpenApiDocument {
  const { enums } = input.schemas;
  const op = operations(input);
  const doc = createDocument(
    {
      openapi: '3.1.0',
      info: {
        title: API_TITLE,
        version: API_VERSION,
        description:
          'Real estate search for humans and AI agents. Error codes: see ErrorCode. With ' +
          'API-key access enabled, send `Authorization: Bearer <key>`.',
      },
      security: [{}, { apiKey: [] }],
      paths: {
        '/listings': { get: op.search },
        '/listings/{id}': { get: op.detail },
        '/openapi.json': { get: op.openapi },
        '/meta': { get: op.meta },
        '/locations': { get: op.locations },
        '/mcp': { post: op.mcp },
      },
      components: {
        securitySchemes: {
          apiKey: {
            type: 'http',
            scheme: 'bearer',
            description: 'Required only when API-key access is enabled.',
          },
        },
        schemas: componentSchemas(enums),
      },
    },
    { override: requestSchemaOverride },
  );
  describeParameters(doc, input);
  dropUnusedOutputVariants(doc);
  return doc;
}

/**
 * zod-openapi renders every component in both input and output mode and adds the output variant
 * as `<Name>Output` when they differ. All models here are referenced in input mode only (see
 * {@link component}), so these variants are unreferenced (and would show minor units); drop them.
 */
function dropUnusedOutputVariants(doc: OpenApiDocument): void {
  const components = doc.components;
  const schemas = components?.schemas;
  if (components === undefined || schemas === undefined) return;
  const serialized = JSON.stringify(doc);
  const unused = (name: string) =>
    name.endsWith('Output') &&
    name.slice(0, -'Output'.length) in schemas &&
    !serialized.includes(`"#/components/schemas/${name}"`);
  components.schemas = Object.fromEntries(
    Object.entries(schemas).filter(([name]) => !unused(name)),
  );
}

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

/** Route handler serving a precomputed JSON document. */
function documentRoute(route: string, guard: AccessGuard, document: unknown): ListingsHandler {
  const result: APIGatewayProxyResult = {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': DISCOVERY_CACHE_CONTROL,
    },
    body: JSON.stringify(document),
  };
  return guardedRoute(route, guard, async () => ({ ...result, headers: { ...result.headers } }));
}

export interface DiscoveryHandlers {
  openapi: ListingsHandler;
  meta: ListingsHandler;
}

/** Builds both documents once (at init) and returns the guarded route handlers. */
export function createDiscoveryHandlers(
  guard: AccessGuard,
  input: DiscoveryInput,
): DiscoveryHandlers {
  return {
    openapi: documentRoute('GET /openapi.json', guard, buildOpenApiDocument(input)),
    meta: documentRoute('GET /meta', guard, buildMetaDocument(input)),
  };
}
