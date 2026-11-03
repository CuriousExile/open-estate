// Feature: real-estate-platform, Property 7: Ungültige Suchparameter werden ohne Ausführung abgelehnt
import {
  createAccessGuard,
  createSearchService,
  InMemoryApiKeyStore,
  InMemoryRateLimitCounterStore,
  InMemorySearchProvider,
  StaticAccessConfigSource,
  type AccessConfig,
} from '@open-estate/core';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  ERROR_CODES,
  groupCodes,
  typeCodes,
  type ApiError,
  type ErrorCode,
  type ErrorResponse,
} from '@open-estate/shared';
import { createListingsHandler } from '@open-estate/api';
import fc from 'fast-check';

/**
 * Property 7: for any search request with at least one violation — syntactically invalid value,
 * value outside the schema bounds, Min > Max, `pageSize` ∉ [1, 50], invalid offer type, price
 * filter without offer type, `group` together with `types`, unknown taxonomy code, 0 or > 50
 * types resp. > 1 group, invalid `lang` — the Search_API answers 400, names every affected field
 * (resp. every unknown code) with its error code in `errors[]`, and the SearchProvider is not
 * called.
 *
 * A valid base query is generated, then 1–3 violations on disjoint field groups ("slots") are
 * injected, so no violation can suppress another (e.g. an invalid `priceMin` suppresses the range
 * check on the price pair). Only guaranteed reports are modelled: expected ⊆ actual.
 *
 * **Validates: Requirements 1.9, 1.10, 1.11, 3.5, 12.8, 12.12, 14.9, 15.7, 15.8, 15.10**
 */

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const schemas = buildSchemas(taxonomy, {
  defaultLocale: 'de',
  enabled: [
    { locale: 'de', label: 'Deutsch' },
    { locale: 'en', label: 'English' },
  ],
});
const GROUPS = groupCodes(taxonomy);
const TYPES = typeCodes(taxonomy);
const KNOWN_CODES = new Set([...GROUPS, ...TYPES]);

const OPEN: AccessConfig = { mode: 'open', rateLimit: { requests: 1000, windowSeconds: 60 } };
const NOW = 60_000 * 29_000_000;

type RawQuery = Record<string, string | string[]>;

/** A report the response must contain; `code` of `details.code` for unknown taxonomy codes. */
interface Expected {
  code: ErrorCode;
  field: string;
  detailsCode?: string;
}

interface Violation {
  /** Fields the violation sets; all others of its slot are removed from the base query. */
  set: RawQuery;
  expected: Expected[];
}

type Slot =
  'offer' | 'rooms' | 'area' | 'city' | 'postalCode' | 'hasTour' | 'taxonomy' | 'lang' | 'pageSize';

const SLOT_FIELDS: Record<Slot, readonly string[]> = {
  offer: ['offerType', 'priceMin', 'priceMax', 'currency'],
  rooms: ['roomsMin', 'roomsMax'],
  area: ['areaMin', 'areaMax'],
  city: ['city'],
  postalCode: ['postalCode'],
  hasTour: ['hasTour'],
  taxonomy: ['group', 'types'],
  lang: ['lang'],
  pageSize: ['pageSize'],
};

// ---------------------------------------------------------------------------------------------
// Valid values
// ---------------------------------------------------------------------------------------------

const decimal = (minor: number): string =>
  `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;

const arbPriceMinor = fc.integer({ min: 1, max: 99_999_999_999 });
const arbAreaMinor = fc.integer({ min: 100, max: 10_000_000 });
const arbRooms = fc.integer({ min: 0, max: 199 }).map((n) => n / 2);

/** Ordered pair `lo ≤ hi`, optionally only one bound. */
const arbRange = (
  arb: fc.Arbitrary<number>,
  show: (v: number) => string,
  min: string,
  max: string,
) =>
  fc
    .tuple(fc.option(arb, { nil: undefined }), fc.option(arb, { nil: undefined }))
    .map(([a, b]): RawQuery => {
      const [lo, hi] = a !== undefined && b !== undefined && a > b ? [b, a] : [a, b];
      return {
        ...(lo !== undefined && { [min]: show(lo) }),
        ...(hi !== undefined && { [max]: show(hi) }),
      };
    });

const arbOfferType = fc.constantFrom('SALE', 'RENT');

const arbValidOffer: fc.Arbitrary<RawQuery> = fc.oneof(
  fc.constant({}),
  fc
    .tuple(
      arbOfferType,
      arbRange(arbPriceMinor, decimal, 'priceMin', 'priceMax'),
      fc.option(fc.constantFrom('EUR', 'CHF'), { nil: undefined }),
    )
    .map(([offerType, price, currency]) => ({
      offerType,
      ...price,
      ...(currency !== undefined && { currency }),
    })),
);

const arbValidTaxonomy: fc.Arbitrary<RawQuery> = fc.oneof(
  fc.constant({}),
  fc.constantFrom(...GROUPS).map((group) => ({ group })),
  fc
    .uniqueArray(fc.constantFrom(...TYPES), { minLength: 1, maxLength: TYPES.length })
    .map((types) => ({ types: types.length === 1 ? (types[0] as string) : types })),
);

/** Valid base query covering every slot. */
const arbBaseQuery: fc.Arbitrary<RawQuery> = fc
  .tuple(
    arbValidOffer,
    arbRange(arbRooms, String, 'roomsMin', 'roomsMax'),
    arbRange(arbAreaMinor, decimal, 'areaMin', 'areaMax'),
    fc.option(fc.constantFrom('Berlin', 'München', 'Köln'), { nil: undefined }),
    fc.option(fc.stringMatching(/^\d{5}$/), { nil: undefined }),
    fc.option(fc.constantFrom('true', 'false'), { nil: undefined }),
    arbValidTaxonomy,
    fc.option(fc.constantFrom('de', 'en', 'EN', 'de-AT', 'fr'), { nil: undefined }),
    fc.option(fc.integer({ min: 1, max: 50 }).map(String), { nil: undefined }),
  )
  .map(([offer, rooms, area, city, postalCode, hasTour, tax, lang, pageSize]) => ({
    ...offer,
    ...rooms,
    ...area,
    ...tax,
    ...(city !== undefined && { city }),
    ...(postalCode !== undefined && { postalCode }),
    ...(hasTour !== undefined && { hasTour }),
    ...(lang !== undefined && { lang }),
    ...(pageSize !== undefined && { pageSize }),
  }));

// ---------------------------------------------------------------------------------------------
// Violations per slot
// ---------------------------------------------------------------------------------------------

const one = (field: string, code: ErrorCode): Expected[] => [{ code, field }];

/** Min > Max on a pair of individually valid values. */
const arbInverted = (
  arb: fc.Arbitrary<number>,
  show: (v: number) => string,
  min: string,
  max: string,
) =>
  fc
    .tuple(arb, arb)
    .filter(([a, b]) => a !== b)
    .map(([a, b]): Violation => {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      return {
        set: { [min]: show(hi), [max]: show(lo) },
        expected: one(min, 'INVALID_RANGE'),
      };
    });

/** One field of a pair set to an invalid value, the other optionally valid. */
const arbInvalidBound = (
  fields: readonly [string, string],
  invalid: fc.Arbitrary<string | string[]>,
  valid: fc.Arbitrary<string>,
) =>
  fc
    .tuple(fc.constantFrom(0, 1), invalid, fc.option(valid, { nil: undefined }))
    .map(([i, bad, other]): Violation => {
      const field = fields[i] as string;
      const otherField = fields[1 - i] as string;
      return {
        set: { [field]: bad, ...(other !== undefined && { [otherField]: other }) },
        expected: one(field, 'INVALID_PARAMETER'),
      };
    });

/** Syntactically invalid values shared by all numeric fields (incl. a repeated parameter). */
const GARBAGE: readonly (string | string[])[] = ['', 'abc', '1,5', ' 1', '1 ', 'NaN', ['1', '2']];

const arbMoneyInvalid = fc.constantFrom<string | string[]>(
  ...GARBAGE,
  '0',
  '0.00',
  '-5',
  '12.345',
  '1e3',
  '1000000000',
  '01',
);
const arbAreaInvalid = fc.constantFrom<string | string[]>(
  ...GARBAGE,
  '0.99',
  '100000.01',
  '1000000',
  '50.123',
);
const arbRoomsInvalid = fc.constantFrom<string | string[]>(
  ...GARBAGE,
  '-0.5',
  '100',
  '0.25',
  '2.7',
);

const arbOfferViolation: fc.Arbitrary<Violation> = fc.oneof(
  // Invalid offer type (Req 12.12).
  fc
    .constantFrom<string | string[]>('', 'sale', 'Rent', 'LEASE', 'BUY', ['SALE', 'RENT'])
    .map((offerType) => ({ set: { offerType }, expected: one('offerType', 'INVALID_OFFER_TYPE') })),
  // Price filter without offer type (Req 12.8).
  fc.tuple(arbPriceMinor, fc.constantFrom('priceMin', 'priceMax')).map(([minor, field]) => ({
    set: { [field]: decimal(minor) },
    expected: one('offerType', 'OFFER_TYPE_REQUIRED'),
  })),
  // Invalid price value with a valid offer type (Req 1.9).
  fc
    .tuple(
      arbOfferType,
      arbInvalidBound(['priceMin', 'priceMax'], arbMoneyInvalid, arbPriceMinor.map(decimal)),
    )
    .map(([offerType, v]) => ({ set: { offerType, ...v.set }, expected: v.expected })),
  // Min > Max (Req 1.10).
  fc
    .tuple(arbOfferType, arbInverted(arbPriceMinor, decimal, 'priceMin', 'priceMax'))
    .map(([offerType, v]) => ({ set: { offerType, ...v.set }, expected: v.expected })),
  // Invalid currency.
  fc
    .tuple(fc.option(arbOfferType, { nil: undefined }), fc.constantFrom('eur', 'EU', 'EURO', ''))
    .map(([offerType, currency]) => ({
      set: { currency, ...(offerType !== undefined && { offerType }) },
      expected: one('currency', 'INVALID_PARAMETER'),
    })),
);

const arbRoomsViolation = fc.oneof(
  arbInvalidBound(['roomsMin', 'roomsMax'], arbRoomsInvalid, arbRooms.map(String)),
  arbInverted(arbRooms, String, 'roomsMin', 'roomsMax'),
);

const arbAreaViolation = fc.oneof(
  arbInvalidBound(['areaMin', 'areaMax'], arbAreaInvalid, arbAreaMinor.map(decimal)),
  arbInverted(arbAreaMinor, decimal, 'areaMin', 'areaMax'),
);

const arbStringViolation = (field: string, maxLength: number) =>
  fc
    .oneof(
      fc.constant<string | string[]>(''),
      fc.constant<string | string[]>(['a', 'b']),
      fc.string({ minLength: maxLength + 1, maxLength: maxLength + 20 }),
    )
    .map((value): Violation => ({
      set: { [field]: value },
      expected: one(field, 'INVALID_PARAMETER'),
    }));

const arbHasTourViolation = fc
  .constantFrom<string | string[]>('', 'yes', '1', 'TRUE', 'False', ['true', 'false'])
  .map((hasTour): Violation => ({
    set: { hasTour },
    expected: one('hasTour', 'INVALID_PARAMETER'),
  }));

const arbUnknownCode = fc
  .stringMatching(/^[a-z][a-z0-9_]{0,20}$/)
  .filter((code) => !KNOWN_CODES.has(code));

const arbTaxonomyViolation: fc.Arbitrary<Violation> = fc.oneof(
  // group together with types (Req 15.7).
  fc.tuple(fc.constantFrom(...GROUPS), fc.constantFrom(...TYPES)).map(([group, type]) => ({
    set: { group, types: type },
    expected: one('group,types', 'CONFLICTING_FILTERS'),
  })),
  // Unknown type codes, mixed with known ones; each one is reported (Req 15.8).
  fc
    .tuple(
      fc.uniqueArray(arbUnknownCode, { minLength: 1, maxLength: 3 }),
      fc.uniqueArray(fc.constantFrom(...TYPES), { maxLength: 3 }),
    )
    .chain(([unknown, known]) =>
      fc
        .shuffledSubarray([...unknown, ...known], {
          minLength: unknown.length + known.length,
        })
        .map((types) => ({
          set: { types: types.length === 1 ? (types[0] as string) : types },
          expected: unknown.map((code) => ({
            code: 'UNKNOWN_TAXONOMY_CODE' as const,
            field: 'types',
            detailsCode: code,
          })),
        })),
    ),
  // Unknown group code (Req 15.8).
  arbUnknownCode.map((group) => ({
    set: { group },
    expected: [{ code: 'UNKNOWN_TAXONOMY_CODE' as const, field: 'group', detailsCode: group }],
  })),
  // 0 types (Req 15.10).
  fc.constant({ set: { types: '' }, expected: one('types', 'INVALID_FILTER_COUNT') }),
  // > 50 types (Req 15.10); known codes, so only the count is wrong.
  fc
    .array(fc.constantFrom(...TYPES), { minLength: 51, maxLength: 60 })
    .map((types) => ({ set: { types }, expected: one('types', 'INVALID_FILTER_COUNT') })),
  // > 1 group (Req 15.10).
  fc
    .uniqueArray(fc.constantFrom(...GROUPS), { minLength: 2, maxLength: GROUPS.length })
    .map((group) => ({ set: { group }, expected: one('group', 'INVALID_FILTER_COUNT') })),
);

const arbLangViolation = fc
  .oneof(
    fc.constantFrom<string | string[]>('', 'de_DE', 'not a locale', 'x', '123', '-de', [
      'de',
      'en',
    ]),
    fc.constant(`de-${'a'.repeat(32)}`), // > 35 characters
  )
  .map((lang): Violation => ({ set: { lang }, expected: one('lang', 'INVALID_LOCALE') }));

const arbPageSizeViolation = fc
  .oneof(
    fc.integer({ min: -1000, max: 0 }).map(String),
    fc.integer({ min: 51, max: 100_000 }).map(String),
    fc.constantFrom<string | string[]>('2.5', '1e3', 'abc', '', ' 20', ['10', '20']),
  )
  .map((pageSize): Violation => ({
    set: { pageSize },
    expected: one('pageSize', 'INVALID_PAGE_SIZE'),
  }));

const VIOLATIONS: Record<Slot, fc.Arbitrary<Violation>> = {
  offer: arbOfferViolation,
  rooms: arbRoomsViolation,
  area: arbAreaViolation,
  city: arbStringViolation('city', 200),
  postalCode: arbStringViolation('postalCode', 10),
  hasTour: arbHasTourViolation,
  taxonomy: arbTaxonomyViolation,
  lang: arbLangViolation,
  pageSize: arbPageSizeViolation,
};

const SLOTS = Object.keys(VIOLATIONS) as Slot[];

/** Base query with 1–3 violations on distinct slots; returns the query and the expected reports. */
const arbInvalidRequest = fc
  .tuple(arbBaseQuery, fc.shuffledSubarray(SLOTS, { minLength: 1, maxLength: 3 }))
  .chain(([base, slots]) =>
    fc.tuple(...slots.map((slot) => VIOLATIONS[slot])).map((violations) => {
      const replaced = new Set(slots.flatMap((slot) => SLOT_FIELDS[slot]));
      const query: RawQuery = Object.fromEntries(
        Object.entries(base).filter(([field]) => !replaced.has(field)),
      );
      for (const v of violations) Object.assign(query, v.set);
      return { query, expected: violations.flatMap((v) => v.expected) };
    }),
  );

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

/** API Gateway event: scalars as single values, repeated parameters as multi-value list. */
function toEvent(query: RawQuery) {
  const single: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(query)) {
    const values = typeof value === 'string' ? [value] : value;
    single[key] = values[values.length - 1] as string;
    multi[key] = [...values];
  }
  return {
    queryStringParameters: single,
    multiValueQueryStringParameters: multi,
    requestContext: { identity: { sourceIp: '192.0.2.1' } },
  };
}

function setup() {
  const provider = new InMemorySearchProvider([]);
  const providerSearch = jest.spyOn(provider, 'search');
  const providerGetById = jest.spyOn(provider, 'getById');
  const search = createSearchService({
    provider,
    taxonomy,
    tourProviders: { providers: [] },
    defaultCurrency: 'EUR',
  });
  const serviceSearch = jest.spyOn(search, 'search');
  const guard = createAccessGuard({
    config: new StaticAccessConfigSource(OPEN),
    apiKeys: new InMemoryApiKeyStore([]),
    counters: new InMemoryRateLimitCounterStore(),
    clock: () => NOW,
  });
  const handler = createListingsHandler({ guard, schemas, search });
  return { handler, spies: [providerSearch, providerGetById, serviceSearch] };
}

const CATALOG: ReadonlySet<string> = new Set(ERROR_CODES);

const matches = (e: ApiError, x: Expected): boolean =>
  e.code === x.code &&
  e.field === x.field &&
  (x.detailsCode === undefined || e.details?.['code'] === x.detailsCode);

afterEach(() => jest.restoreAllMocks());

describe('Property 7: invalid search parameters are rejected without execution', () => {
  it('answers 400 naming every violation and never calls the SearchProvider', async () => {
    await fc.assert(
      fc.asyncProperty(arbInvalidRequest, async ({ query, expected }) => {
        const { handler, spies } = setup();

        const res = await handler(toEvent(query));
        const body = JSON.parse(res.body) as ErrorResponse;

        expect(res.statusCode).toBe(400);
        expect(body.errors.length).toBeGreaterThan(0);
        for (const error of body.errors) {
          expect(CATALOG.has(error.code)).toBe(true);
          expect(typeof error.message).toBe('string');
          expect(error.message.length).toBeGreaterThan(0);
        }
        const missing = expected.filter((x) => !body.errors.some((e) => matches(e, x)));
        expect({ missing, errors: body.errors }).toEqual({ missing: [], errors: body.errors });
        // Count errors name the allowed count (Req 15.10); conflicts name both fields (Req 15.7).
        for (const e of body.errors) {
          if (e.code === 'INVALID_FILTER_COUNT') expect(e.details).toHaveProperty('allowed');
          if (e.code === 'CONFLICTING_FILTERS') {
            expect(e.details).toEqual({ fields: ['group', 'types'] });
          }
        }
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });
});
