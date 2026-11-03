import { z } from 'zod';
import {
  type ApiError,
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  type LocaleConfig,
  parseDetailQuery,
  parseSearchQuery,
  SEARCH_QUERY_BOUNDS,
  toApiErrors,
} from '../../src';

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const locales: LocaleConfig = {
  defaultLocale: 'de',
  enabled: [
    { locale: 'de', label: 'Deutsch' },
    { locale: 'en', label: 'English' },
  ],
};
const schemas = buildSchemas(taxonomy, locales);

function errorsOf(raw: Record<string, unknown>): ApiError[] {
  const result = parseSearchQuery(raw, schemas);
  if (result.ok) throw new Error(`expected errors, got ${JSON.stringify(result.value)}`);
  return result.error;
}

const codesOf = (raw: Record<string, unknown>) =>
  errorsOf(raw).map((e) => ({ code: e.code, field: e.field }));

function valueOf(raw: Record<string, unknown>) {
  const result = parseSearchQuery(raw, schemas);
  if (!result.ok) throw new Error(`unexpected errors: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('buildSchemas', () => {
  it('exposes taxonomy, offer types and enabled locales as enums', () => {
    expect(schemas.enums).toEqual({
      offerTypes: ['SALE', 'RENT'],
      groups: ['apartment', 'house', 'land', 'commercial'],
      types: expect.arrayContaining(['penthouse', 'office']) as unknown,
      locales: ['de', 'en'],
      defaultLocale: 'de',
    });
  });

  it('restricts listingType of the listing schema to the taxonomy', () => {
    const shape = schemas.listing.safeParse({ listingType: 'castle' });
    expect(shape.success).toBe(false);
    expect(shape.error?.issues.some((i) => i.path[0] === 'listingType')).toBe(true);
  });

  it('emits taxonomy codes as enum in the JSON Schema', () => {
    const json = JSON.stringify(z.toJSONSchema(schemas.searchQuery, { io: 'input' }));
    expect(json).toContain('"penthouse"');
    expect(json).toContain('"apartment"');
  });
});

describe('parseSearchQuery – valid queries', () => {
  it('defaults pageSize to 20 and ignores unknown parameters', () => {
    expect(valueOf({ foo: 'bar' })).toEqual({ pageSize: SEARCH_QUERY_BOUNDS.pageSize.default });
  });

  it('converts query strings: prices and area to minor units, rooms decimal, booleans', () => {
    expect(
      valueOf({
        offerType: 'RENT',
        priceMin: '500',
        priceMax: '1250.5',
        currency: 'EUR',
        roomsMin: '2.5',
        roomsMax: '4',
        areaMin: '50',
        areaMax: '85.25',
        city: 'Berlin',
        postalCode: '10115',
        types: ['penthouse', 'loft'],
        hasTour: 'true',
        lang: 'en-GB',
        pageSize: '10',
        pageToken: 'abc',
      }),
    ).toEqual({
      offerType: 'RENT',
      priceMin: 50_000,
      priceMax: 125_050,
      currency: 'EUR',
      roomsMin: 2.5,
      roomsMax: 4,
      areaMin: 5_000,
      areaMax: 8_525,
      city: 'Berlin',
      postalCode: '10115',
      types: ['penthouse', 'loft'],
      hasTour: true,
      lang: 'en-GB',
      pageSize: 10,
      pageToken: 'abc',
    });
  });

  it('accepts equal min and max', () => {
    expect(valueOf({ roomsMin: '3', roomsMax: '3' })).toMatchObject({ roomsMin: 3, roomsMax: 3 });
  });

  it('normalizes a single types string and a single-element group list', () => {
    expect(valueOf({ types: 'villa' }).types).toEqual(['villa']);
    expect(valueOf({ group: ['house'] }).group).toBe('house');
    expect(valueOf({ group: 'house' }).group).toBe('house');
  });
});

describe('parseSearchQuery – coercion equality (API strings vs. typed MCP values)', () => {
  const pairs: [Record<string, unknown>, Record<string, unknown>][] = [
    [
      {
        offerType: 'SALE',
        priceMin: '1250.50',
        roomsMin: '3.5',
        areaMax: '100',
        hasTour: 'false',
        pageSize: '5',
      },
      {
        offerType: 'SALE',
        priceMin: 1250.5,
        roomsMin: 3.5,
        areaMax: 100,
        hasTour: false,
        pageSize: 5,
      },
    ],
    [{ types: 'loft' }, { types: ['loft'] }],
    [{ pageSize: '0' }, { pageSize: 0 }],
    [{ pageSize: '-5' }, { pageSize: -5 }],
    [{ pageSize: '2.5' }, { pageSize: 2.5 }],
    [{ roomsMin: '3.3' }, { roomsMin: 3.3 }],
    [{ roomsMin: '100' }, { roomsMin: 100 }],
    [
      { offerType: 'RENT', priceMin: '0.001' },
      { offerType: 'RENT', priceMin: 0.001 },
    ],
    [
      { areaMin: '200', areaMax: '100' },
      { areaMin: 200, areaMax: 100 },
    ],
    [{ types: '' }, { types: [] }],
  ];

  it.each(pairs)('%j ≡ %j', (api, mcp) => {
    expect(parseSearchQuery(api, schemas)).toEqual(parseSearchQuery(mcp, schemas));
  });
});

describe('parseSearchQuery – error codes', () => {
  it('INVALID_PARAMETER for syntax, type and range violations', () => {
    expect(codesOf({ roomsMin: 'abc' })).toEqual([
      { code: 'INVALID_PARAMETER', field: 'roomsMin' },
    ]);
    expect(codesOf({ roomsMax: '3.3' })).toEqual([
      { code: 'INVALID_PARAMETER', field: 'roomsMax' },
    ]);
    expect(codesOf({ offerType: 'SALE', priceMax: '1e3' })).toEqual([
      { code: 'INVALID_PARAMETER', field: 'priceMax' },
    ]);
    expect(codesOf({ areaMin: '0.5' })).toEqual([{ code: 'INVALID_PARAMETER', field: 'areaMin' }]);
    expect(codesOf({ currency: 'eur' })).toEqual([
      { code: 'INVALID_PARAMETER', field: 'currency' },
    ]);
    expect(codesOf({ city: '' })).toEqual([{ code: 'INVALID_PARAMETER', field: 'city' }]);
    expect(codesOf({ postalCode: '12345678901' })).toEqual([
      { code: 'INVALID_PARAMETER', field: 'postalCode' },
    ]);
    expect(codesOf({ hasTour: 'yes' })).toEqual([{ code: 'INVALID_PARAMETER', field: 'hasTour' }]);
  });

  it('INVALID_RANGE names the min field for price, rooms and area', () => {
    expect(errorsOf({ offerType: 'SALE', priceMin: '200', priceMax: '100' })).toEqual([
      expect.objectContaining({
        code: 'INVALID_RANGE',
        field: 'priceMin',
        details: { fields: ['priceMin', 'priceMax'] },
      }),
    ]);
    expect(codesOf({ roomsMin: '4', roomsMax: '3.5' })).toEqual([
      { code: 'INVALID_RANGE', field: 'roomsMin' },
    ]);
    expect(codesOf({ areaMin: '100.01', areaMax: '100' })).toEqual([
      { code: 'INVALID_RANGE', field: 'areaMin' },
    ]);
  });

  it('does not report INVALID_RANGE when one bound is invalid on its own', () => {
    expect(codesOf({ roomsMin: '200', roomsMax: '3' })).toEqual([
      { code: 'INVALID_PARAMETER', field: 'roomsMin' },
    ]);
  });

  it.each([['0'], ['51'], ['abc'], ['']])('INVALID_PAGE_SIZE for pageSize=%j', (pageSize) => {
    expect(codesOf({ pageSize })).toEqual([{ code: 'INVALID_PAGE_SIZE', field: 'pageSize' }]);
  });

  // A non-integer pageSize must not abort the cross-field rules (Zod's `.int()` would).
  describe('non-integer pageSize together with cross-field errors', () => {
    const pageSizeError = { code: 'INVALID_PAGE_SIZE', field: 'pageSize' };

    it.each([['2.5'], [2.5]])('INVALID_RANGE for pageSize=%j', (pageSize) => {
      expect(codesOf({ roomsMin: '0.5', roomsMax: '0', pageSize })).toEqual([
        pageSizeError,
        { code: 'INVALID_RANGE', field: 'roomsMin' },
      ]);
    });

    it('OFFER_TYPE_REQUIRED', () => {
      expect(codesOf({ priceMin: '5', pageSize: '2.5' })).toEqual([
        pageSizeError,
        { code: 'OFFER_TYPE_REQUIRED', field: 'offerType' },
      ]);
    });

    it('CONFLICTING_FILTERS', () => {
      expect(codesOf({ group: 'house', types: ['villa'], pageSize: '2.5' })).toEqual([
        pageSizeError,
        { code: 'CONFLICTING_FILTERS', field: 'group,types' },
      ]);
    });
  });

  it('INVALID_OFFER_TYPE for values other than SALE/RENT', () => {
    expect(codesOf({ offerType: 'LEASE' })).toEqual([
      { code: 'INVALID_OFFER_TYPE', field: 'offerType' },
    ]);
    expect(codesOf({ offerType: 'sale' })).toEqual([
      { code: 'INVALID_OFFER_TYPE', field: 'offerType' },
    ]);
  });

  it('OFFER_TYPE_REQUIRED for a price filter without offerType, but not for an invalid offerType', () => {
    expect(codesOf({ priceMax: '1000' })).toEqual([
      { code: 'OFFER_TYPE_REQUIRED', field: 'offerType' },
    ]);
    expect(codesOf({ priceMin: 'x' })).toEqual([
      { code: 'INVALID_PARAMETER', field: 'priceMin' },
      { code: 'OFFER_TYPE_REQUIRED', field: 'offerType' },
    ]);
    expect(codesOf({ offerType: 'X', priceMin: '1' })).toEqual([
      { code: 'INVALID_OFFER_TYPE', field: 'offerType' },
    ]);
  });

  it('CONFLICTING_FILTERS names group and types', () => {
    expect(errorsOf({ group: 'house', types: ['villa'] })).toEqual([
      expect.objectContaining({
        code: 'CONFLICTING_FILTERS',
        field: 'group,types',
        details: { fields: ['group', 'types'] },
      }),
    ]);
  });

  it('UNKNOWN_TAXONOMY_CODE once per unknown code', () => {
    expect(errorsOf({ types: ['villa', 'castle', 'igloo'] })).toEqual([
      expect.objectContaining({
        code: 'UNKNOWN_TAXONOMY_CODE',
        field: 'types',
        details: { code: 'castle' },
      }),
      expect.objectContaining({
        code: 'UNKNOWN_TAXONOMY_CODE',
        field: 'types',
        details: { code: 'igloo' },
      }),
    ]);
    // Group and type codes are separate namespaces.
    expect(errorsOf({ group: 'villa' })).toEqual([
      expect.objectContaining({
        code: 'UNKNOWN_TAXONOMY_CODE',
        field: 'group',
        details: { code: 'villa' },
      }),
    ]);
  });

  it('INVALID_FILTER_COUNT with the allowed count', () => {
    const tooMany = Array.from({ length: 51 }, () => 'villa');
    expect(errorsOf({ types: tooMany })).toEqual([
      expect.objectContaining({
        code: 'INVALID_FILTER_COUNT',
        field: 'types',
        details: { allowed: { min: 1, max: 50 }, actual: 51 },
      }),
    ]);
    expect(codesOf({ types: [] })).toEqual([{ code: 'INVALID_FILTER_COUNT', field: 'types' }]);
    expect(errorsOf({ group: ['house', 'land'] })).toEqual([
      expect.objectContaining({
        code: 'INVALID_FILTER_COUNT',
        field: 'group',
        details: { allowed: { min: 1, max: 1 }, actual: 2 },
      }),
    ]);
  });

  it.each([[''], ['x'.repeat(36)], ['not a locale!']])('INVALID_LOCALE for lang=%j', (lang) => {
    expect(codesOf({ lang })).toEqual([{ code: 'INVALID_LOCALE', field: 'lang' }]);
  });

  it('INVALID_PAGE_TOKEN for an empty page token', () => {
    expect(codesOf({ pageToken: '' })).toEqual([
      { code: 'INVALID_PAGE_TOKEN', field: 'pageToken' },
    ]);
  });

  it('collects all errors at once with non-empty messages', () => {
    const errors = errorsOf({
      offerType: 'BUY',
      priceMin: '10',
      roomsMin: '5',
      roomsMax: '2',
      group: 'house',
      types: ['castle'],
      lang: '',
      pageSize: '100',
    });
    expect(errors.map((e) => [e.code, e.field])).toEqual(
      expect.arrayContaining([
        ['INVALID_OFFER_TYPE', 'offerType'],
        ['INVALID_RANGE', 'roomsMin'],
        ['CONFLICTING_FILTERS', 'group,types'],
        ['UNKNOWN_TAXONOMY_CODE', 'types'],
        ['INVALID_LOCALE', 'lang'],
        ['INVALID_PAGE_SIZE', 'pageSize'],
      ]),
    );
    expect(errors).toHaveLength(6);
    for (const e of errors) expect(e.message.length).toBeGreaterThan(0);
  });
});

describe('parseDetailQuery', () => {
  it('accepts id and lang', () => {
    expect(parseDetailQuery({ id: 'lst-1', lang: 'de' }, schemas)).toEqual({
      ok: true,
      value: { id: 'lst-1', lang: 'de' },
    });
  });

  it('reports INVALID_ID and INVALID_LOCALE together', () => {
    const result = parseDetailQuery({ id: '', lang: '' }, schemas);
    expect(result.ok ? [] : result.error.map((e) => [e.code, e.field])).toEqual([
      ['INVALID_ID', 'id'],
      ['INVALID_LOCALE', 'lang'],
    ]);
  });
});

describe('toApiErrors', () => {
  it('uses the code from custom issue params and falls back to INVALID_PARAMETER', () => {
    const schema = z.object({
      a: z.string(),
      b: z.string().superRefine((_, ctx) => {
        ctx.addIssue({
          code: 'custom',
          message: 'gone',
          params: { code: 'NOT_FOUND', details: { id: 'x' } },
        });
      }),
    });
    const issues = schema.safeParse({ a: 1, b: 'y' }).error?.issues ?? [];
    expect(toApiErrors(issues)).toEqual([
      expect.objectContaining({ code: 'INVALID_PARAMETER', field: 'a' }),
      { code: 'NOT_FOUND', field: 'b', message: 'gone', details: { id: 'x' } },
    ]);
  });

  it('every catalog code except UNKNOWN_TOOL has an HTTP status', () => {
    expect(ERROR_CODES).toHaveLength(20);
    for (const code of ERROR_CODES) {
      if (code !== 'UNKNOWN_TOOL') expect(ERROR_HTTP_STATUS).toHaveProperty(code);
    }
  });
});
