import * as z from 'zod';
import { canonicalJson } from './cursor';
import { sha256Hex } from './sha256';

// Idempotenzschlüssel of `POST /listings` (duplicate-detection Req 9.2–9.6).

/** Name of the request header. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** Response header of a replayed request (Req 9.2). */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/** How long a key binds a request to the listing it created (Req 9.2). */
export const IDEMPOTENCY_WINDOW_SECONDS = 24 * 60 * 60;

/** 1–128 printable ASCII characters without space (Req 9.5). */
export const IdempotencyKey = z.string().regex(/^[\x21-\x7E]{1,128}$/, {
  message: 'Expected 1-128 printable ASCII characters without spaces',
});

/** Stored form of a key: its hash, so client-chosen values are not kept verbatim. */
export const idempotencyKeyHash = (key: string): string =>
  sha256Hex(new TextEncoder().encode(`idempotency-key|${key}`));

/**
 * Fingerprint of a request body: equal for bodies that are equal in canonical form (key order,
 * duplicate set entries), different otherwise (Req 9.2, 9.3).
 */
export const idempotencyRequestHash = (body: unknown): string =>
  sha256Hex(new TextEncoder().encode(`idempotency-body|${canonicalJson(body) ?? 'null'}`));
