import type { ApiError } from './errors';
import { err, ok, type Result } from './result';
import { sha256Hex } from './sha256';

/**
 * Opaque pagination cursor (design: "Indexierungs-Strategie und Ordnung", Req 1.7, 1.8).
 * Global order is `id ASC`; `lastId` is the last delivered id, `queryHash` binds the cursor
 * to the query it was issued for.
 */
export interface Cursor {
  v: 1;
  lastId: string;
  queryHash: string;
}

/** Parsed search query: filters plus `pageSize`. `pageToken` is ignored by `queryHash`. */
export interface CursorQuery {
  pageSize: number;
  pageToken?: string | undefined;
  [filter: string]: unknown;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Deterministic serialization: object keys sorted, `undefined` omitted, arrays of primitives
 * (e.g. `types`) sorted and deduplicated since they are sets semantically. Hand-written instead
 * of relying on `JSON.stringify` key order (integer-like keys would be reordered).
 */
function canonicalJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items = value.map(canonicalJson).filter((s): s is string => s !== undefined);
    const isSet = value.every(
      (item) => item === undefined || item === null || typeof item !== 'object',
    );
    const normalized = isSet ? [...new Set(items)].sort() : items;
    return `[${normalized.join(',')}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .flatMap((key) => {
      const serialized = canonicalJson((value as Record<string, unknown>)[key]);
      return serialized === undefined ? [] : [`${JSON.stringify(key)}:${serialized}`];
    });
  return `{${entries.join(',')}}`;
}

/** SHA-256 (hex) over the normalized filters and `pageSize`; `pageToken` is excluded. */
export function queryHash(query: CursorQuery): string {
  const rest: Record<string, unknown> = { ...query };
  delete rest['pageToken'];
  return sha256Hex(new TextEncoder().encode(canonicalJson(rest)));
}

// base64url without padding (RFC 4648 §5). Own codec: `Buffer` is Node-only and
// `btoa`/`atob` work on Latin-1 strings, not bytes.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = ((bytes[i] as number) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) out += ALPHABET[(chunk >>> (18 - c * 6)) & 0x3f];
  }
  return out;
}

function fromBase64Url(text: string): Uint8Array | undefined {
  if (!BASE64URL_PATTERN.test(text) || text.length % 4 === 1) return undefined;
  const bytes = new Uint8Array(Math.floor((text.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text) {
    buffer = (buffer << 6) | ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >>> bits) & 0xff;
    }
    buffer &= (1 << bits) - 1;
  }
  // Non-zero trailing bits mean a non-canonical encoding.
  return buffer === 0 ? bytes : undefined;
}

export function encodeCursor(cursor: Cursor): string {
  const json = JSON.stringify({ v: cursor.v, lastId: cursor.lastId, queryHash: cursor.queryHash });
  return toBase64Url(new TextEncoder().encode(json));
}

function invalid(message: string): Result<Cursor, ApiError> {
  return err({ code: 'INVALID_PAGE_TOKEN', message, field: 'pageToken' });
}

/** Decodes `token` and checks it was issued for a query with hash `expectedHash`. */
export function decodeCursor(token: string, expectedHash: string): Result<Cursor, ApiError> {
  const bytes = fromBase64Url(token);
  if (bytes === undefined || bytes.length === 0)
    return invalid('Page token is not valid base64url.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return invalid('Page token is not valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalid('Page token has an invalid structure.');
  }

  const { v, lastId, queryHash: hash } = parsed as Record<string, unknown>;
  if (v !== 1) return invalid('Page token has an unsupported version.');
  if (
    typeof lastId !== 'string' ||
    lastId.length === 0 ||
    typeof hash !== 'string' ||
    !HASH_PATTERN.test(hash)
  ) {
    return invalid('Page token is missing required fields.');
  }
  if (hash !== expectedHash) return invalid('Page token belongs to a different query.');

  return ok({ v: 1, lastId, queryHash: hash });
}
