// Feature: real-estate-platform, Property 31: Frontend-Filtervalidierung entspricht dem Schema und erhält Eingaben
import { LISTING_BOUNDS, parseSearchQuery, type ApiError } from '@open-estate/shared';
import fc from 'fast-check';
import { buildQuery, type SearchParams } from '../src/app/api/api-client';
import { parseSearchMeta } from '../src/app/search/search-meta';
import {
  normalizeDecimal,
  SEARCH_FORM_FIELDS,
  validateSearchForm,
  type SearchFormField,
  type SearchFormValues,
} from '../src/app/search/validate-search-form';

/**
 * Property 31: for any form state, the frontend validator rejects exactly the values the shared
 * `SearchQuery` schema rejects; on rejection no API call is made, the affected fields are named
 * and all inputs stay unchanged.
 *
 * Oracle: `parseSearchQuery(…, buildSchemas(taxonomy, locales))` (via `parseSearchMeta`, which
 * calls `buildSchemas`) on the query exactly as Search_API receives it: the form state is encoded
 * with the client's `buildQuery` and decoded like `collectQuery` in the API handler (single values
 * as string, repeated `types` as list, `hasTour` as `"true"`). Decimal inputs enter the oracle
 * after the form's own normalization (`normalizeDecimal`: trim, decimal comma → point); without it
 * the API would reject e.g. "1,5", which the form accepts on purpose (German input). Everything
 * else ("1.250,50", "1e3", "+1", …) is left to the schema on both sides.
 *
 * `offerType` is always `SALE`/`RENT`: the control is non-nullable with radio buttons (Req 12.10);
 * the frontend-only "offer type required" rule is covered by the unit tests. `SearchFormComponent`
 * itself needs Angular; `submit` below mirrors its logic (validate → emit only on success) with a
 * fake `emit` standing in for the `search` output that triggers the API call.
 *
 * **Validates: Requirements 4.7, 7.2**
 */

const META = parseSearchMeta({
  taxonomy: {
    groups: [
      { code: 'apartment', types: ['loft', 'penthouse'] },
      { code: 'house', types: ['villa'] },
    ],
  },
  locales: ['en', 'de'],
});

const DECIMAL_FIELDS = [
  'priceMin',
  'priceMax',
  'roomsMin',
  'roomsMax',
  'areaMin',
  'areaMax',
] as const;

// --- Generators -----------------------------------------------------------------------------

/** Number-like strings around the bounds, in API and locale formats, plus malformed input. */
const edgeNumberText = fc.oneof(
  fc.constantFrom(
    '0',
    '0.01',
    '0.5',
    '0.99',
    '1',
    '99.5',
    '100',
    '100000',
    '100000.01',
    '999999999.99',
    '1000000000',
    '-1',
    '-0.5',
    '00.5',
    '+1',
    '.5',
    '1.',
    '1e3',
    '1.234',
    '1.000,00',
    '1.250,50',
    '1,250.50',
    '1 000',
    'abc',
    'NaN',
  ),
  fc
    .tuple(fc.integer({ min: 0, max: 200_000 }), fc.integer({ min: 0, max: 999 }), fc.nat(3))
    .map(([whole, fraction, digits]) =>
      digits === 0 ? `${whole}` : `${whole}.${String(fraction).padStart(3, '0').slice(0, digits)}`,
    ),
);

/** Mostly valid values per field kind, so that whole forms are accepted often enough. */
const plausibleNumberText = {
  price: fc
    .tuple(fc.integer({ min: 1, max: 5_000_000 }), fc.integer({ min: 0, max: 99 }), fc.boolean())
    .map(([whole, cents, fraction]) => (fraction ? `${whole}.${cents}` : `${whole}`)),
  rooms: fc.integer({ min: 0, max: 199 }).map((halves) => String(halves / 2)),
  area: fc
    .tuple(fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 0, max: 99 }), fc.boolean())
    .map(([whole, cents, fraction]) => (fraction ? `${whole}.${cents}` : `${whole}`)),
};

/** Decimal input as typed: empty, plausible or edge case; optional decimal comma and padding. */
const decimalInput = (kind: keyof typeof plausibleNumberText) =>
  fc.oneof(
    { arbitrary: fc.constant(''), weight: 6 },
    {
      arbitrary: fc
        .record({
          text: fc.oneof(
            { arbitrary: plausibleNumberText[kind], weight: 4 },
            { arbitrary: edgeNumberText, weight: 1 },
          ),
          comma: fc.boolean(),
          pad: fc.constantFrom('', '', ' ', '\t'),
        })
        .map(({ text, comma, pad }) => `${pad}${comma ? text.replace('.', ',') : text}${pad}`),
      weight: 4,
    },
  );

/** Text: mostly empty or short, sometimes at, beyond or around the length bound. */
const boundedText = (max: number) =>
  fc.oneof(
    { arbitrary: fc.constant(''), weight: 4 },
    { arbitrary: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 8 }), weight: 3 },
    { arbitrary: fc.string({ maxLength: max + 2 }), weight: 1 },
    { arbitrary: fc.constantFrom(' ', 'x'.repeat(max), 'x'.repeat(max + 1)), weight: 1 },
  );

/** Types come from checkboxes, so no duplicates; `castle` is unknown to the taxonomy. */
const typeSelection = fc.uniqueArray(fc.constantFrom('loft', 'penthouse', 'villa', 'castle'), {
  minLength: 1,
  maxLength: 4,
});
const groupCode = fc.constantFrom('apartment', 'house', 'castle');

/** Group XOR types as in the UI, plus programmatic states with both. */
const taxonomyFilter = fc.oneof(
  { arbitrary: fc.constant({ group: '', types: [] as string[] }), weight: 3 },
  { arbitrary: groupCode.map((group) => ({ group, types: [] as string[] })), weight: 2 },
  { arbitrary: typeSelection.map((types) => ({ group: '', types })), weight: 2 },
  { arbitrary: fc.record({ group: groupCode, types: typeSelection }), weight: 1 },
);

const formValues: fc.Arbitrary<SearchFormValues> = fc
  .record({
    offerType: fc.constantFrom('SALE' as const, 'RENT' as const),
    priceMin: decimalInput('price'),
    priceMax: decimalInput('price'),
    roomsMin: decimalInput('rooms'),
    roomsMax: decimalInput('rooms'),
    areaMin: decimalInput('area'),
    areaMax: decimalInput('area'),
    city: boundedText(LISTING_BOUNDS.city.max),
    postalCode: boundedText(LISTING_BOUNDS.postalCode.max),
    taxonomy: taxonomyFilter,
    hasTour: fc.boolean(),
  })
  .map(({ taxonomy, ...rest }) => ({ ...rest, ...taxonomy }));

// --- Oracle: the query as Search_API receives it -------------------------------------------

/** Form state → wire parameters; `buildQuery` drops empty inputs, as the client does. */
function wireParams(values: SearchFormValues): SearchParams {
  const params: SearchParams = {
    ...(values.offerType !== null && { offerType: values.offerType }),
  };
  for (const field of DECIMAL_FIELDS) params[field] = normalizeDecimal(values[field]);
  params.city = values.city;
  params.postalCode = values.postalCode;
  params.group = values.group;
  params.types = values.types;
  if (values.hasTour) params.hasTour = true;
  return params;
}

/** Query string → raw record like `collectQuery` (single value: string, repeated: list). */
function receive(params: SearchParams): Record<string, string | string[]> {
  const raw = new Map<string, string[]>();
  const query = buildQuery(Object.entries(params));
  for (const part of query.slice(1).split('&').filter(Boolean)) {
    const [key = '', value = ''] = part.split('=').map(decodeURIComponent);
    raw.set(key, [...(raw.get(key) ?? []), value]);
  }
  return Object.fromEntries(
    [...raw].map(([key, values]) => [key, values.length === 1 ? (values[0] as string) : values]),
  );
}

/** Form controls an API error refers to; the group/types conflict concerns both. */
function controlsOf(error: ApiError): SearchFormField[] {
  const fields = error.field === 'group,types' ? ['group', 'types'] : [error.field];
  return fields.filter((f): f is SearchFormField =>
    (SEARCH_FORM_FIELDS as readonly (string | undefined)[]).includes(f),
  );
}

// --- System under test ---------------------------------------------------------------------

/** Mirrors `SearchFormComponent.submit`: emits (→ API call) only for a valid form. */
function submit(values: SearchFormValues, emit: (params: SearchParams) => void) {
  const result = validateSearchForm(values, META);
  if ('params' in result) emit(result.params);
  return result;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe('Property 31: frontend filter validation matches the schema and keeps inputs', () => {
  it('accepts ⇔ schema accepts; on rejection no call, fields named, values unchanged', () => {
    fc.assert(
      fc.property(formValues, (generated) => {
        const before = structuredClone(generated);
        const values = deepFreeze(generated);
        const oracle = parseSearchQuery(receive(wireParams(values)), META.schemas);
        const sent: SearchParams[] = [];

        const result = submit(values, (params) => sent.push(params));

        expect('params' in result).toBe(oracle.ok);
        expect(values).toEqual(before);
        if ('params' in result) {
          expect(sent).toEqual([result.params]);
          // What is sent is exactly what the oracle accepted.
          expect(receive(result.params)).toEqual(receive(wireParams(values)));
          return;
        }
        expect(sent).toEqual([]);
        if (oracle.ok) return; // unreachable: covered by the equivalence above
        const named = new Set(result.errors.map((e) => e.field));
        expect(named.size).toBe(result.errors.length);
        for (const error of oracle.error) {
          const controls = controlsOf(error);
          expect(controls.length).toBeGreaterThan(0);
          expect(controls.some((field) => named.has(field))).toBe(true);
        }
        // No field is named that the schema did not reject.
        const rejected = new Set(oracle.error.flatMap(controlsOf));
        for (const field of named) expect(rejected.has(field)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
