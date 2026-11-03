// Feature: real-estate-platform, Property 5: Deterministische, totale Ordnung
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  createSearchService,
  DynamoDbSearchProvider,
  InMemorySearchProvider,
  normalizeCity,
  OpenSearchSearchProvider,
  toListingItem,
  toOpenSearchDocument,
  type OpenSearchClientLike,
  type OpenSearchFilterClause,
  type SearchProvider,
} from '@open-estate/core';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  parseSearchQuery,
  typeCodes,
  type Listing,
  type SearchQuery,
} from '@open-estate/shared';
import fc from 'fast-check';
import { arbListing } from '../../../shared/test/arbitraries';

/**
 * Property 5: for any listing set and search query, repeating the full paging walk with identical
 * parameters yields the same page sequence (items and tokens), and the concatenated pages contain
 * every matching listing exactly once in strictly ascending `id` order — independent of the
 * insertion order and of the SearchProvider (in-memory reference, DynamoDB, OpenSearch).
 *
 * DynamoDB and OpenSearch run against in-process fakes of their backends: the DynamoDB fake
 * evaluates the provider's KeyCondition/FilterExpression on the stored items and ends each Query
 * response after a random number of *evaluated* items (like the 1 MB limit), so the provider's
 * multi-request loop is exercised; the OpenSearch fake evaluates the `bool.filter` clauses,
 * `sort`, `search_after` and `size` of the request body. Like the real backends, both fakes and
 * the expectation order ids by UTF-8 bytes, i.e. by Unicode code points (an independent
 * implementation, not the production comparator). Ids include high-BMP (U+E000–U+FFFF) and
 * non-BMP characters, where code-point order and JavaScript's UTF-16 `<` disagree. Conformance
 * against the real backends is covered by the integration tests 6.11 (DynamoDB Local) and 18.3
 * (OpenSearch).
 *
 * **Validates: Requirements 1.8, 19.3**
 */

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const schemas = buildSchemas(taxonomy, {
  defaultLocale: 'de',
  enabled: [{ locale: 'de', label: 'Deutsch' }],
});

function parse(raw: Record<string, unknown>): SearchQuery {
  const parsed = parseSearchQuery(raw, schemas);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}

// Small pools so that filters hit often; ids from a tiny alphabet give prefix and case neighbours
// ('a' < 'aB' < 'b', 'A' < 'a'), which exercise the exclusive start of the next page. U+FF01 and
// U+1F600 are neighbours whose code-point order (FF01 < 1F600) is the reverse of their UTF-16
// order (D83D < FF01).
const CITIES = ['Berlin', 'BERLIN', 'München', 'Köln'];
const TYPES = typeCodes(taxonomy).slice(0, 4);

const arbId = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.string({
      unit: fc.constantFrom('a', 'A', 'b', '-', '\uFF01', '\uE000', '\u{1F600}', '\u{10000}'),
      minLength: 1,
      maxLength: 4,
    }),
  },
  { weight: 1, arbitrary: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 16 }) },
  { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 128 }) },
);

const arbOrderingListing: fc.Arbitrary<Listing> = fc
  .tuple(arbListing({ listingTypes: TYPES }), arbId, fc.constantFrom(...CITIES))
  .map(([listing, id, city]) => ({ ...listing, id, address: { ...listing.address, city } }));

/** Listing set (unique ids, up to 60 so several pages occur) plus two insertion orders. */
const arbStock = fc
  .uniqueArray(arbOrderingListing, { maxLength: 60, size: 'max', selector: (l) => l.id })
  .chain((listings) => {
    const permutation = fc.shuffledSubarray(listings, {
      minLength: listings.length,
      maxLength: listings.length,
    });
    return fc.tuple(permutation, permutation);
  });

interface RawQuery {
  offerType?: 'SALE' | 'RENT';
  city?: string;
  roomsMin?: number;
  types?: string[];
  pageSize?: number;
}

const arbQuery: fc.Arbitrary<RawQuery> = fc.record(
  {
    offerType: fc.constantFrom('SALE' as const, 'RENT' as const),
    city: fc.constantFrom(...CITIES, 'berlin'),
    roomsMin: fc.integer({ min: 0, max: 40 }).map((n) => n / 2),
    types: fc.uniqueArray(fc.constantFrom(...TYPES), { minLength: 1, maxLength: TYPES.length }),
    // Small sizes are over-represented to get many pages.
    pageSize: fc.oneof(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 50 })),
  },
  { requiredKeys: [] },
);

/** Independent reference predicate for the generated filters. */
function matches(l: Listing, q: RawQuery): boolean {
  return (
    (q.offerType === undefined || l.offers.some((o) => o.offerType === q.offerType)) &&
    (q.city === undefined || normalizeCity(l.address.city) === normalizeCity(q.city)) &&
    (q.roomsMin === undefined || l.rooms >= q.roomsMin) &&
    (q.types === undefined || q.types.includes(l.listingType))
  );
}

/** `id ASC` as in DynamoDB/OpenSearch: lexicographic by code points (= UTF-8 byte order). */
function byCodePoints(a: string, b: string): number {
  const codePoints = (s: string) => [...s].map((c) => c.codePointAt(0) as number);
  const [x, y] = [codePoints(a), codePoints(b)];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return (x[i] as number) < (y[i] as number) ? -1 : 1;
  }
  return Math.sign(x.length - y.length);
}

/** Never-aborting deadline signal, so the fakes leave no timers behind. */
const noDeadline = (): AbortSignal => new AbortController().signal;

// --- DynamoDB fake -------------------------------------------------------------------------------

type Item = Record<string, unknown>;
type Values = Record<string, unknown>;

/** Evaluates one conjunct of the provider's FilterExpression on `item`. */
function evalCondition(cond: string, item: Item, names: Record<string, string>, values: Values) {
  const attr = (placeholder: string) => item[names[placeholder] as string];
  const val = (placeholder: string) => values[placeholder];
  let m: RegExpMatchArray | null;
  if ((m = cond.match(/^attribute_exists\((#\w+)\)$/))) return attr(m[1] as string) !== undefined;
  if ((m = cond.match(/^(#\w+) (=|>=|<=|>) (:v\d+)$/))) {
    const [, a, op, v] = m as [string, string, string, string];
    const left = attr(a) as string | number | undefined;
    const right = val(v) as string | number;
    if (left === undefined || typeof left !== typeof right) return false;
    if (op === '=') return left === right;
    // String keys (the `id` sort key) compare by code points, as in DynamoDB.
    const cmp =
      typeof left === 'string' ? byCodePoints(left, right as string) : Math.sign(left - +right);
    if (op === '>') return cmp > 0;
    return op === '>=' ? cmp >= 0 : cmp <= 0;
  }
  if ((m = cond.match(/^(#\w+) IN \((.+)\)$/))) {
    const [, a, operands] = m as [string, string, string];
    return operands.split(', ').some((v) => attr(a) === val(v));
  }
  if ((m = cond.match(/^\((.+)\)$/))) {
    return (m[1] as string).split(' OR ').some((alt) => {
      const c = alt.match(/^contains\((#\w+), (:v\d+)\)$/);
      if (!c) throw new Error(`unsupported condition: ${alt}`);
      const set = attr(c[1] as string);
      return Array.isArray(set) && set.includes(val(c[2] as string));
    });
  }
  throw new Error(`unsupported condition: ${cond}`);
}

const conjuncts = (expression: string | undefined): string[] =>
  expression === undefined ? [] : expression.split(' AND ');

/**
 * Query on the `byId` GSI: key condition (incl. `id > :after`), FilterExpression, `id` order,
 * `ExclusiveStartKey`. A response ends after `evaluatedPerResponse` evaluated items (before the
 * filter), with `LastEvaluatedKey` if items remain — as DynamoDB does at its 1 MB limit.
 */
function dynamoQuery(
  table: readonly Item[],
  input: QueryCommandInput,
  evaluatedPerResponse: number,
) {
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  const all = (item: Item, expression: string | undefined) =>
    conjuncts(expression).every((c) => evalCondition(c, item, names, values));
  const start = input.ExclusiveStartKey?.['id'] as string | undefined;
  const candidates = table
    .filter((item) => all(item, input.KeyConditionExpression))
    .sort((a, b) => byCodePoints(a['id'] as string, b['id'] as string))
    .filter((item) => start === undefined || byCodePoints(item['id'] as string, start) > 0);
  const evaluated = candidates.slice(0, evaluatedPerResponse);
  const last = evaluated[evaluated.length - 1];
  return {
    Items: evaluated.filter((item) => all(item, input.FilterExpression)),
    ...(candidates.length > evaluated.length && last !== undefined
      ? { LastEvaluatedKey: { gsiPk: last['gsiPk'], id: last['id'] } }
      : {}),
  };
}

function dynamoProvider(listings: readonly Listing[], evaluatedPerResponse: number) {
  const table = listings.map((l) => toListingItem(l) as unknown as Item);
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
  jest.spyOn(client, 'send').mockImplementation((async (command: unknown) => {
    if (!(command instanceof QueryCommand)) throw new Error('unexpected command');
    return dynamoQuery(table, command.input, evaluatedPerResponse);
  }) as never);
  return new DynamoDbSearchProvider({ client, tableName: 'listings', deadlineSignal: noDeadline });
}

// --- OpenSearch fake -----------------------------------------------------------------------------

function clauseMatches(clause: OpenSearchFilterClause, doc: Item): boolean {
  const [[field, arg]] = Object.entries(Object.values(clause)[0] as object) as [[string, unknown]];
  const value = doc[field];
  const values = Array.isArray(value) ? (value as unknown[]) : value === undefined ? [] : [value];
  if ('exists' in clause) return doc[clause.exists.field] !== undefined;
  if ('term' in clause) return values.includes(arg);
  if ('terms' in clause) return values.some((v) => (arg as unknown[]).includes(v));
  const { gte, lte } = arg as { gte?: number; lte?: number };
  return values.some(
    (v) =>
      typeof v === 'number' && (gte === undefined || v >= gte) && (lte === undefined || v <= lte),
  );
}

function openSearchProvider(listings: readonly Listing[]) {
  const index = listings.map((l) => toOpenSearchDocument(l) as unknown as Item);
  const client: OpenSearchClientLike = {
    search: async ({ body }) => {
      const filter = (body['query'] as { bool: { filter: OpenSearchFilterClause[] } }).bool.filter;
      expect(body['sort']).toEqual([{ id: 'asc' }]);
      const [after] = (body['search_after'] as string[] | undefined) ?? [];
      const hits = index
        .filter((doc) => filter.every((clause) => clauseMatches(clause, doc)))
        .sort((a, b) => byCodePoints(a['id'] as string, b['id'] as string))
        .filter((doc) => after === undefined || byCodePoints(doc['id'] as string, after) > 0)
        .slice(0, body['size'] as number)
        .map((doc) => ({ _source: { listing: doc['listing'] } }));
      return { body: { hits: { hits } } };
    },
  };
  return new OpenSearchSearchProvider({ client, index: 'listings', deadlineSignal: noDeadline });
}

// --- Property ------------------------------------------------------------------------------------

interface Walk {
  pages: string[][];
  tokens: (string | undefined)[];
}

/** Follows `nextPageToken` from the first page to the last. */
async function walk(provider: SearchProvider, raw: RawQuery, bound: number): Promise<Walk> {
  const service = createSearchService({
    provider,
    taxonomy,
    tourProviders: { providers: [] },
    defaultCurrency: 'EUR',
  });
  const pages: string[][] = [];
  const tokens: (string | undefined)[] = [];
  let pageToken: string | undefined;
  // Every non-final page delivers ≥ 1 listing, so bound + 1 pages suffice.
  for (let i = 0; i <= bound; i++) {
    const result = await service.search(parse({ ...raw, ...(pageToken && { pageToken }) }), []);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    pages.push(result.value.items.map((item) => item.id));
    tokens.push(result.value.nextPageToken);
    pageToken = result.value.nextPageToken;
    if (pageToken === undefined) return { pages, tokens };
  }
  throw new Error('paging did not terminate');
}

const PROVIDERS: [string, (ls: readonly Listing[], evaluated: number) => SearchProvider][] = [
  ['InMemorySearchProvider', (ls) => new InMemorySearchProvider(ls)],
  ['DynamoDbSearchProvider', dynamoProvider],
  ['OpenSearchSearchProvider', (ls) => openSearchProvider(ls)],
];

describe('Property 5: Deterministische, totale Ordnung', () => {
  afterEach(() => jest.restoreAllMocks());

  it('repeated walks are identical and deliver every match exactly once in ascending id order, for every provider', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStock,
        arbQuery,
        fc.integer({ min: 1, max: 8 }),
        async ([orderA, orderB], raw, evaluatedPerResponse) => {
          const expected = orderA
            .filter((l) => matches(l, raw))
            .map((l) => l.id)
            .sort(byCodePoints);

          let reference: Walk | undefined;
          for (const [, create] of PROVIDERS) {
            const first = await walk(create(orderA, evaluatedPerResponse), raw, expected.length);
            // Repetition with identical parameters on the same stock → same sequence (Req 1.8).
            const again = await walk(create(orderA, evaluatedPerResponse), raw, expected.length);
            // Different insertion order → same sequence (order is a function of the data only).
            const shuffled = await walk(create(orderB, evaluatedPerResponse), raw, expected.length);
            expect(again).toEqual(first);
            expect(shuffled).toEqual(first);

            // Complete walk: every match exactly once, strictly ascending by id.
            const ids = first.pages.flat();
            expect(ids).toEqual(expected);
            for (let i = 1; i < ids.length; i++) {
              expect(byCodePoints(ids[i - 1] as string, ids[i] as string)).toBe(-1);
            }

            // Provider independence: identical pages and tokens (Req 19.3 relies on it).
            if (reference === undefined) reference = first;
            else expect(first).toEqual(reference);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
