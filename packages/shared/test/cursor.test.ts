import { createHash } from 'node:crypto';
import { decodeCursor, encodeCursor, queryHash, type Cursor } from '../src';
import { sha256Hex } from '../src/sha256';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

describe('sha256Hex', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
  ])('matches the FIPS 180-4 test vector for %j', (input, expected) => {
    expect(sha256Hex(utf8(input))).toBe(expected);
  });

  it('handles the 55/56/64-byte padding boundaries like node:crypto', () => {
    for (const length of [55, 56, 63, 64, 65, 1000]) {
      const input = 'a'.repeat(length);
      expect(sha256Hex(utf8(input))).toBe(createHash('sha256').update(input).digest('hex'));
    }
  });
});

describe('queryHash', () => {
  it('is independent of key order, undefined fields and pageToken', () => {
    const a = queryHash({ pageSize: 20, city: 'Berlin', offerType: 'SALE' });
    const b = queryHash({
      offerType: 'SALE',
      city: 'Berlin',
      lang: undefined,
      pageSize: 20,
      pageToken: 'xyz',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats arrays like types as sets (sorted, deduplicated)', () => {
    expect(queryHash({ pageSize: 20, types: ['house', 'apartment_unit', 'house'] })).toBe(
      queryHash({ pageSize: 20, types: ['apartment_unit', 'house'] }),
    );
  });

  it('changes when a filter or pageSize changes', () => {
    const base = queryHash({ pageSize: 20, city: 'Berlin' });
    expect(queryHash({ pageSize: 20, city: 'Hamburg' })).not.toBe(base);
    expect(queryHash({ pageSize: 21, city: 'Berlin' })).not.toBe(base);
    expect(queryHash({ pageSize: 20, city: 'Berlin', hasTour: true })).not.toBe(base);
  });

  it('is stable for a fixed query', () => {
    expect(queryHash({ pageSize: 20 })).toBe(sha256Hex(utf8('{"pageSize":20}')));
  });
});

describe('encodeCursor / decodeCursor', () => {
  const hash = queryHash({ pageSize: 20, city: 'Berlin' });
  const cursor: Cursor = { v: 1, lastId: 'lst-ä-42', queryHash: hash };

  it('round-trips as unpadded base64url JSON', () => {
    const token = encodeCursor(cursor);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).toBe(b64url(JSON.stringify(cursor)));
    expect(decodeCursor(token, hash)).toEqual({ ok: true, value: cursor });
  });

  const otherHash = queryHash({ pageSize: 20, city: 'Hamburg' });
  it.each([
    ['empty token', ''],
    ['invalid base64url characters', 'abc+/='],
    ['impossible base64 length', 'abcde'],
    ['not JSON', b64url('not json')],
    ['invalid UTF-8', Buffer.from([0xff, 0xfe]).toString('base64url')],
    ['JSON array', b64url('[1]')],
    ['wrong version', b64url(JSON.stringify({ ...cursor, v: 2 }))],
    ['missing lastId', b64url(JSON.stringify({ v: 1, queryHash: hash }))],
    ['empty lastId', b64url(JSON.stringify({ v: 1, lastId: '', queryHash: hash }))],
    ['missing queryHash', b64url(JSON.stringify({ v: 1, lastId: 'x' }))],
    ['malformed queryHash', b64url(JSON.stringify({ v: 1, lastId: 'x', queryHash: 'abc' }))],
    ['hash of another query', encodeCursor({ ...cursor, queryHash: otherHash })],
  ])('rejects %s with INVALID_PAGE_TOKEN on pageToken', (_case, token) => {
    const result = decodeCursor(token, hash);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ code: 'INVALID_PAGE_TOKEN', field: 'pageToken' });
    }
  });
});
