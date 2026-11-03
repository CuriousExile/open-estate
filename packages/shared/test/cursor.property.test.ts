// Feature: real-estate-platform, Property 6: Cursor-Round-Trip und Bindung an die Anfrage
import fc from 'fast-check';
import { decodeCursor, encodeCursor, queryHash, type Cursor, type CursorQuery } from '../src';

/**
 * Property 6 on the level of the cursor codec (the search layer does not exist yet):
 * round-trip, rejection of arbitrary non-tokens and binding to the issuing query.
 *
 * **Validates: Requirements 1.7, 1.8**
 */

const HEX = '0123456789abcdef'.split('');
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.split('');

const arbHash = fc.string({ unit: fc.constantFrom(...HEX), minLength: 64, maxLength: 64 });
/** Full Unicode code points (no lone surrogates), 1–128 code points. */
const arbLastId = fc.string({ unit: 'binary', minLength: 1, maxLength: 128 });
const arbCursor: fc.Arbitrary<Cursor> = fc.record({
  v: fc.constant(1 as const),
  lastId: arbLastId,
  queryHash: arbHash,
});

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

function expectInvalidPageToken(result: ReturnType<typeof decodeCursor>): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe('INVALID_PAGE_TOKEN');
    expect(result.error.field).toBe('pageToken');
  }
}

/** Search-like query: `pageSize` plus optional filters (scalars and a set-valued `types`). */
const arbQuery: fc.Arbitrary<CursorQuery> = fc.record(
  {
    pageSize: fc.integer({ min: 1, max: 100 }),
    q: fc.string({ maxLength: 20 }),
    city: fc.string({ minLength: 1, maxLength: 20 }),
    offerType: fc.constantFrom('SALE', 'RENT'),
    priceMin: fc.integer({ min: 0, max: 10_000_000 }),
    priceMax: fc.integer({ min: 0, max: 10_000_000 }),
    roomsMin: fc.integer({ min: 0, max: 20 }),
    types: fc.uniqueArray(fc.constantFrom('apartment', 'house', 'land', 'office'), {
      minLength: 1,
    }),
  },
  { requiredKeys: ['pageSize'] },
);

/** `q2` differs from `q` in exactly one filter or in `pageSize` (semantically, not just textually). */
const arbQueryPair: fc.Arbitrary<[CursorQuery, CursorQuery]> = arbQuery.chain((q) => {
  const filterKeys = Object.keys(q).filter((k) => k !== 'pageSize');
  const changes: fc.Arbitrary<CursorQuery>[] = [
    fc
      .integer({ min: 1, max: 100 })
      .filter((n) => n !== q.pageSize)
      .map((pageSize) => ({ ...q, pageSize })),
    fc
      .string({ minLength: 1, maxLength: 20 })
      .filter((s) => s !== q['city'])
      .map((city) => ({ ...q, city })),
    fc
      .integer({ min: 0, max: 10_000_000 })
      .filter((n) => n !== q['priceMin'])
      .map((priceMin) => ({ ...q, priceMin })),
  ];
  const types = q['types'] as string[] | undefined;
  if (types !== undefined && types.length < 4) {
    changes.push(
      fc
        .constantFrom('apartment', 'house', 'land', 'office')
        .filter((t) => !types.includes(t))
        .map((t) => ({ ...q, types: [...types, t] })),
    );
  }
  if (filterKeys.length > 0) {
    changes.push(
      fc
        .constantFrom(...filterKeys)
        .map(
          (key) => Object.fromEntries(Object.entries(q).filter(([k]) => k !== key)) as CursorQuery,
        ),
    );
  }
  return fc.oneof(...changes).map((q2): [CursorQuery, CursorQuery] => [q, q2]);
});

describe('Property 6: Cursor-Round-Trip und Bindung an die Anfrage', () => {
  it('decodeCursor(encodeCursor(c), c.queryHash) returns c', () => {
    fc.assert(
      fc.property(arbCursor, (cursor) => {
        const token = encodeCursor(cursor);
        expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(decodeCursor(token, cursor.queryHash)).toEqual({ ok: true, value: cursor });
      }),
    );
  });

  it('never throws on arbitrary strings and only accepts tokens bound to the expected hash', () => {
    const arbToken = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 200 }),
      fc.string({ unit: fc.constantFrom(...BASE64URL), maxLength: 200 }),
      fc.string({ maxLength: 200 }).map(b64url),
    );
    fc.assert(
      fc.property(arbToken, arbHash, (token, expectedHash) => {
        const result = decodeCursor(token, expectedHash);
        if (result.ok) {
          // A random string may only pass if it really is a cursor for this query.
          expect(result.value.v).toBe(1);
          expect(result.value.queryHash).toBe(expectedHash);
          expect(result.value.lastId.length).toBeGreaterThan(0);
        } else {
          expectInvalidPageToken(result);
        }
      }),
    );
  });

  it('rejects strings containing characters outside the base64url alphabet', () => {
    fc.assert(
      fc.property(
        arbCursor,
        fc.nat(),
        fc.constantFrom('=', '+', '/', ' ', '.', '\n', 'ä', '\u{1F3E0}'),
        (cursor, position, foreign) => {
          const token = encodeCursor(cursor);
          const at = position % (token.length + 1);
          expectInvalidPageToken(
            decodeCursor(token.slice(0, at) + foreign + token.slice(at), cursor.queryHash),
          );
        },
      ),
    );
  });

  it('rejects well-formed base64url payloads that are not a valid cursor', () => {
    const arbNonCursorJson = fc.oneof(
      // arbitrary JSON values (objects without the cursor shape, arrays, primitives)
      fc.jsonValue().filter((v) => v === null || typeof v !== 'object' || !('v' in v)),
      // cursor-like objects with exactly one broken field
      fc.tuple(arbLastId, arbHash).chain(([lastId, hash]) =>
        fc.oneof(
          fc
            .oneof(fc.integer(), fc.string(), fc.constant(null))
            .filter((v) => v !== 1)
            .map((v) => ({ v, lastId, queryHash: hash })),
          fc
            .oneof(fc.constant(''), fc.integer(), fc.constant(null))
            .map((bad) => ({ v: 1, lastId: bad, queryHash: hash })),
          fc
            .string({ maxLength: 70 })
            .filter((s) => !/^[0-9a-f]{64}$/.test(s))
            .map((bad) => ({ v: 1, lastId, queryHash: bad })),
          fc.constant({ v: 1, queryHash: hash }),
          fc.constant({ v: 1, lastId }),
        ),
      ),
    );
    fc.assert(
      fc.property(arbNonCursorJson, arbHash, (payload, expectedHash) => {
        expectInvalidPageToken(decodeCursor(b64url(JSON.stringify(payload)), expectedHash));
      }),
    );
  });

  it('rejects a cursor of query q1 when presented for a query q2 with other filters or pageSize', () => {
    fc.assert(
      fc.property(arbQueryPair, arbLastId, ([q1, q2], lastId) => {
        const h1 = queryHash(q1);
        const h2 = queryHash(q2);
        expect(h2).not.toBe(h1);

        const token = encodeCursor({ v: 1, lastId, queryHash: h1 });
        expect(decodeCursor(token, h1).ok).toBe(true);
        expectInvalidPageToken(decodeCursor(token, h2));
      }),
    );
  });

  it('queryHash is invariant under key order and pageToken', () => {
    fc.assert(
      fc.property(
        arbQuery.chain((q) => {
          const entries = Object.entries(q);
          return fc.tuple(
            fc.constant(q),
            fc.shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length }),
            fc.string({ maxLength: 200 }),
          );
        }),
        ([q, shuffled, pageToken]) => {
          const reordered = Object.fromEntries(shuffled) as CursorQuery;
          const expected = queryHash(q);
          expect(queryHash(reordered)).toBe(expected);
          expect(queryHash({ ...reordered, pageToken })).toBe(expected);
          expect(queryHash({ pageToken, ...q })).toBe(expected);
        },
      ),
    );
  });
});
