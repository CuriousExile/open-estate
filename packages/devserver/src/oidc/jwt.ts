import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';

// DEV ONLY: minimal RS256 JWT signing and verification with node:crypto for the local OIDC
// provider. The key pair is generated per process and never persisted.

/** Public signing key as published in the JWKS. */
export interface PublicJwk extends JsonWebKey {
  kty: string;
  n: string;
  e: string;
  kid: string;
  alg: 'RS256';
  use: 'sig';
}

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicJwk: PublicJwk;
}

export type JwtClaims = Record<string, unknown>;

const encodeJson = (value: unknown) =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Fresh RSA-2048 key pair; `kid` is derived from the modulus. */
export function generateSigningKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const { kty, n, e } = jwk;
  if (kty === undefined || n === undefined || e === undefined) {
    throw new Error('RSA public key without kty/n/e');
  }
  const kid = createHash('sha256').update(n).digest('base64url').slice(0, 16);
  return { kid, privateKey, publicJwk: { kty, n, e, kid, alg: 'RS256', use: 'sig' } };
}

/** Compact JWS (`header.payload.signature`) with `alg: RS256` and the key's `kid`. */
export function signJwt(claims: JwtClaims, key: SigningKey): string {
  const input = `${encodeJson({ alg: 'RS256', typ: 'JWT', kid: key.kid })}.${encodeJson(claims)}`;
  const signature = sign('sha256', Buffer.from(input, 'utf8'), key.privateKey);
  return `${input}.${signature.toString('base64url')}`;
}

/** Header and claims without any check; `null` if the token is not a well-formed JWS. */
export function decodeJwt(jwt: string): { header: JwtClaims; claims: JwtClaims } | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const header = decodeJson(parts[0] ?? '');
  const claims = decodeJson(parts[1] ?? '');
  return header === null || claims === null ? null : { header, claims };
}

/**
 * Claims of `jwt` if its RS256 signature verifies against a key of `jwks` (matched by `kid`) and
 * it is not expired at `nowMs` (`exp` in seconds); otherwise `null`.
 */
export function verifyJwt(
  jwt: string,
  jwks: readonly PublicJwk[],
  nowMs: number,
): JwtClaims | null {
  const decoded = decodeJwt(jwt);
  if (decoded === null || decoded.header['alg'] !== 'RS256') return null;
  const jwk = jwks.find((key) => key.kid === decoded.header['kid']);
  if (jwk === undefined) return null;
  const [header, payload, signature] = jwt.split('.') as [string, string, string];
  let valid: boolean;
  try {
    valid = verify(
      'sha256',
      Buffer.from(`${header}.${payload}`, 'utf8'),
      createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return null;
  }
  if (!valid) return null;
  const exp = decoded.claims['exp'];
  if (typeof exp !== 'number' || exp * 1000 <= nowMs) return null;
  return decoded.claims;
}
