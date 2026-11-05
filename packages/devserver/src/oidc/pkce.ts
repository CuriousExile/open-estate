import { createHash, timingSafeEqual } from 'node:crypto';

// DEV ONLY: PKCE (RFC 7636) check of the local OIDC provider. Only `S256` is accepted, like
// Cognito with a public client.

/** RFC 7636 §4.1: 43–128 characters of the unreserved set. */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
/** base64url of a SHA-256 digest: 43 characters without padding. */
const CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;

/** `BASE64URL(SHA256(verifier))`, the S256 code challenge of `verifier`. */
export function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export const isValidCodeChallenge = (challenge: string, method: string | undefined): boolean =>
  method === 'S256' && CHALLENGE.test(challenge);

/** True iff `verifier` is well-formed and its S256 challenge equals `challenge`. */
export function verifyPkce(verifier: string | undefined, challenge: string): boolean {
  if (verifier === undefined || !VERIFIER.test(verifier) || !CHALLENGE.test(challenge)) {
    return false;
  }
  const expected = Buffer.from(s256Challenge(verifier), 'ascii');
  const actual = Buffer.from(challenge, 'ascii');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
