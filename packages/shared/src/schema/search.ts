import * as z from 'zod';
import { toApiErrors, type ApiError, type ApiIssueParams } from '../errors';
import { Area, Money } from '../money';
import { err, ok, type Result } from '../result';
import { groupCodes, typeCodes, type Taxonomy } from '../taxonomy';
import {
  CountryCode,
  Currency,
  LISTING_BOUNDS,
  ListingBase,
  LocaleTag,
  OFFER_TYPES,
  refineListing,
  Rooms,
} from './listing';
import { integer } from './non-aborting';

// Request schemas built from the loaded taxonomy and locale configuration (design: "Domänenkern",
// "Search_API"). Search_API passes query strings, MCP_Server typed JSON values; every field
// coerces strings with the same semantics as the typed value, so equal values yield equal results
// and error codes (Req 19.7). Unknown query parameters are not specified and are ignored (stripped).

/** Locale configuration (`i18n-config.json`, design: "Konfigurationsmodelle"). */
export interface LocaleConfig {
  readonly defaultLocale: string;
  readonly enabled: readonly { readonly locale: string; readonly label: string }[];
}

/** Limits of the request parameters in addition to {@link LISTING_BOUNDS} (Req 1.6, 1.11, 15.10). */
export const SEARCH_QUERY_BOUNDS = {
  pageSize: { min: 1, max: 50, default: 20 },
  types: { min: 1, max: 50 },
  group: { min: 1, max: 1 },
  pageToken: { min: 1, max: 1024 },
} as const;

/** Range filters as `[minField, maxField]`; Min > Max yields `INVALID_RANGE` (Req 1.10). */
export const RANGE_FILTERS = [
  ['priceMin', 'priceMax'],
  ['roomsMin', 'roomsMax'],
  ['areaMin', 'areaMax'],
] as const;

const PRICE_FIELDS = ['priceMin', 'priceMax'] as const;

// ---------------------------------------------------------------------------------------------
// Coercion: API strings ↔ typed MCP values
// ---------------------------------------------------------------------------------------------

/** JSON number grammar, so "-5", "2.5" and "1e1" coerce exactly like the JSON numbers. */
const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

/** String in JSON number grammar → number; anything else unchanged (the schema rejects it). */
const toNumber = (value: unknown): unknown =>
  typeof value === 'string' && JSON_NUMBER.test(value) ? Number(value) : value;

/** Number → shortest decimal string (decimal schemas stay string-based, never float × 100). */
const toDecimalString = (value: unknown): unknown =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : value;

const toBoolean = (value: unknown): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/** Single value or repeated parameter → list of codes; empty strings (`types=`) are dropped. */
const toCodeList = (value: unknown): unknown => {
  const list = typeof value === 'string' ? [value] : value;
  return Array.isArray(list) ? list.filter((item) => item !== '') : list;
};

const boundedString = (bounds: { readonly min: number; readonly max: number }) =>
  z.string().min(bounds.min).max(bounds.max);

function addApiIssue(
  ctx: z.core.$RefinementCtx,
  message: string,
  params: ApiIssueParams,
  path: PropertyKey[] = [],
): void {
  ctx.addIssue({ code: 'custom', message, params, path });
}

/**
 * List of taxonomy codes with count limits (`INVALID_FILTER_COUNT`, allowed count in `details`)
 * and one `UNKNOWN_TAXONOMY_CODE` per unknown code (`details.code`, Req 15.8, 15.10). The known
 * codes and the count limits are exposed as `enum` and `minItems`/`maxItems` in the generated
 * JSON Schema/OpenAPI (Req 3.2, 3.7); they are checked here, not by Zod, to keep the error codes.
 */
function codeList(field: string, known: readonly string[], allowed: { min: number; max: number }) {
  const knownSet = new Set(known);
  const codes = z.array(z.string().meta({ enum: [...known] }));
  return z.preprocess(
    toCodeList,
    codes.meta({ minItems: allowed.min, maxItems: allowed.max }).superRefine((codes, ctx) => {
      if (codes.length < allowed.min || codes.length > allowed.max) {
        const range =
          allowed.min === allowed.max ? `${allowed.min}` : `${allowed.min} to ${allowed.max}`;
        addApiIssue(ctx, `${field} must contain ${range} code(s), got ${codes.length}`, {
          code: 'INVALID_FILTER_COUNT',
          field,
          details: { allowed, actual: codes.length },
        });
      }
      for (const code of codes) {
        if (!knownSet.has(code)) {
          addApiIssue(ctx, `Unknown taxonomy code "${code}" in ${field}`, {
            code: 'UNKNOWN_TAXONOMY_CODE',
            field,
            details: { code },
          });
        }
      }
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Search query
// ---------------------------------------------------------------------------------------------

function searchQueryShape(taxonomy: Taxonomy) {
  const B = LISTING_BOUNDS;
  const S = SEARCH_QUERY_BOUNDS;
  const money = z.preprocess(toDecimalString, Money).optional();
  const rooms = z.preprocess(toNumber, Rooms).optional();
  const area = z.preprocess(toDecimalString, Area).optional();
  return {
    offerType: z.enum(OFFER_TYPES).optional(),
    /** Minor units of the offer price (cold rent for RENT). */
    priceMin: money,
    priceMax: money,
    currency: Currency.optional(),
    /**
     * `true`: offers in other currencies match too, compared after converting the price bounds
     * with the configured exchange rates (`exchange-rates.json`). Default: one currency only.
     */
    convertCurrency: z.preprocess(toBoolean, z.boolean()).optional(),
    roomsMin: rooms,
    roomsMax: rooms,
    /** Hundredths of m². */
    areaMin: area,
    areaMax: area,
    city: boundedString(B.city).optional(),
    postalCode: boundedString(B.postalCode).optional(),
    /** `address.country`, ISO 3166-1 alpha-2 in upper case (exact match). */
    country: CountryCode.optional(),
    /** Exactly one group code (repeated parameter allowed, then counted). */
    group: codeList('group', groupCodes(taxonomy), S.group)
      .transform((codes) => codes[0] ?? '')
      .optional(),
    /** 1–50 type codes, OR-combined; a single string is a one-element list. */
    types: codeList('types', typeCodes(taxonomy), S.types).optional(),
    hasTour: z.preprocess(toBoolean, z.boolean()).optional(),
    lang: LocaleTag.optional(),
    pageSize: z
      .preprocess(toNumber, integer().min(S.pageSize.min).max(S.pageSize.max))
      .default(S.pageSize.default),
    /** Opaque cursor; decoded and bound to the query by the SearchService. */
    pageToken: boundedString(S.pageToken).optional(),
  };
}

type SearchQueryShape = ReturnType<typeof searchQueryShape>;
type ParsedFields = z.output<z.ZodObject<SearchQueryShape>>;

/**
 * Cross-field rules (Req 1.10, 12.8, 15.7). Run even if fields failed, so all errors are reported
 * at once; range checks only compare two values that are valid on their own. Field schemas must
 * not abort (see ./non-aborting), otherwise Zod skips these rules.
 */
function crossFieldRules(query: ParsedFields, ctx: z.core.$RefinementCtx<ParsedFields>): void {
  const failed = new Set(ctx.issues.map((issue) => issue.path?.[0]));

  if (
    query.offerType === undefined &&
    !failed.has('offerType') &&
    PRICE_FIELDS.some((f) => query[f] !== undefined)
  ) {
    addApiIssue(
      ctx,
      'A price filter requires offerType (SALE or RENT)',
      { code: 'OFFER_TYPE_REQUIRED' },
      ['offerType'],
    );
  }

  if (query.group !== undefined && query.types !== undefined) {
    addApiIssue(ctx, 'group and types cannot be combined; use either group or types', {
      code: 'CONFLICTING_FILTERS',
      field: 'group,types',
      details: { fields: ['group', 'types'] },
    });
  }

  for (const [minField, maxField] of RANGE_FILTERS) {
    const min = query[minField];
    const max = query[maxField];
    if (
      min !== undefined &&
      max !== undefined &&
      !failed.has(minField) &&
      !failed.has(maxField) &&
      min > max
    ) {
      addApiIssue(
        ctx,
        `${minField} must be less than or equal to ${maxField}`,
        { code: 'INVALID_RANGE', details: { fields: [minField, maxField] } },
        [minField],
      );
    }
  }
}

function searchQuerySchema(taxonomy: Taxonomy) {
  // `when`: run the cross-field rules even after field issues (default would skip them).
  return z.object(searchQueryShape(taxonomy)).superRefine(crossFieldRules, { when: () => true });
}

function detailQuerySchema() {
  return z.object({ id: boundedString(LISTING_BOUNDS.id), lang: LocaleTag.optional() });
}

function listingSchema(taxonomy: Taxonomy) {
  return refineListing(ListingBase.extend({ listingType: z.enum(typeCodes(taxonomy)) }));
}

export type SearchQuerySchema = ReturnType<typeof searchQuerySchema>;
export type DetailQuerySchema = ReturnType<typeof detailQuerySchema>;

/** Validated search query: amounts and area in minor units, rooms decimal, `pageSize` defaulted. */
export type SearchQuery = z.output<SearchQuerySchema>;
export type DetailQuery = z.output<DetailQuerySchema>;

/** Schemas and enum values derived from the loaded configuration; computed once at init. */
export interface Schemas {
  /** Listing with `listingType` restricted to the taxonomy's type codes. */
  listing: ReturnType<typeof listingSchema>;
  /** `GET /listings` and MCP `search_listings`. */
  searchQuery: SearchQuerySchema;
  /** `GET /listings/{id}` and MCP `get_listing`. */
  detailQuery: DetailQuerySchema;
  /** Dynamic enums for OpenAPI, `/meta`, MCP and frontend (Req 3.7). */
  enums: {
    offerTypes: readonly (typeof OFFER_TYPES)[number][];
    groups: readonly string[];
    types: readonly string[];
    locales: readonly string[];
    defaultLocale: string;
  };
}

/** Builds all request and listing schemas from taxonomy and locale configuration. */
export function buildSchemas(taxonomy: Taxonomy, locales: LocaleConfig): Schemas {
  return {
    listing: listingSchema(taxonomy),
    searchQuery: searchQuerySchema(taxonomy),
    detailQuery: detailQuerySchema(),
    enums: {
      offerTypes: OFFER_TYPES,
      groups: groupCodes(taxonomy),
      types: typeCodes(taxonomy),
      locales: locales.enabled.map((l) => l.locale),
      defaultLocale: locales.defaultLocale,
    },
  };
}

function parseWith<T>(schema: z.ZodType<T>, raw: unknown): Result<T, ApiError[]> {
  const result = schema.safeParse(raw);
  return result.success ? ok(result.data) : err(toApiErrors(result.error.issues));
}

/**
 * Validates raw search parameters (query strings or typed MCP values) and collects all errors,
 * each with its `field` (Req 1.9–1.11, 3.5, 12.8, 12.12, 14.9, 15.7, 15.8, 15.10).
 */
export function parseSearchQuery(
  raw: Record<string, unknown>,
  s: Schemas,
): Result<SearchQuery, ApiError[]> {
  return parseWith(s.searchQuery, raw);
}

/** Validates a detail request (`INVALID_ID`, `INVALID_LOCALE`). */
export function parseDetailQuery(
  raw: Record<string, unknown>,
  s: Schemas,
): Result<DetailQuery, ApiError[]> {
  return parseWith(s.detailQuery, raw);
}
