import { sha256Hex } from '../sha256';
import { words } from './normalize';

// SimHash of a text (duplicate-detection design: "Textähnlichkeit"). 64 bits as 16 hex
// characters: compact enough to store with every Merkmalsprofil, and no clear text reaches the
// Duplikat_Index (Req 12.1). Two texts count as nearly equal when their signatures differ in at
// most `textNearHamming` bits; the candidate search exploits that with banding (see `blocks.ts`).

/** Bits of a signature. */
export const SIMHASH_BITS = 64;

/** Hex characters of a signature. */
export const SIMHASH_HEX_LENGTH = SIMHASH_BITS / 4;

const ZERO = '0'.repeat(SIMHASH_HEX_LENGTH);

/**
 * Features of a text: word bigrams, so word order matters but small edits do not; a single word
 * is its own feature. An empty text has no feature and yields the zero signature.
 */
export function textFeatures(text: string): string[] {
  const tokens = words(text);
  if (tokens.length <= 1) return tokens;
  return tokens.slice(0, -1).map((token, index) => `${token} ${tokens[index + 1]}`);
}

/** 64-bit hash of one feature as 16 hex characters. */
const featureHash = (feature: string): string =>
  sha256Hex(new TextEncoder().encode(`simhash|${feature}`)).slice(0, SIMHASH_HEX_LENGTH);

/** Bits of a hex string, most significant first. */
function bits(hex: string): number[] {
  const out: number[] = [];
  for (const character of hex) {
    const nibble = Number.parseInt(character, 16);
    out.push((nibble >> 3) & 1, (nibble >> 2) & 1, (nibble >> 1) & 1, nibble & 1);
  }
  return out;
}

/**
 * SimHash of a text: every feature votes for each bit (+1 set, −1 unset), the sign decides.
 * Deterministic and independent of the platform (pure SHA-256, no locale-dependent step).
 */
export function simhash(text: string): string {
  const features = textFeatures(text);
  if (features.length === 0) return ZERO;
  const votes = new Array<number>(SIMHASH_BITS).fill(0);
  for (const feature of features) {
    const featureBits = bits(featureHash(feature));
    for (let i = 0; i < SIMHASH_BITS; i += 1) {
      votes[i] = (votes[i] ?? 0) + ((featureBits[i] ?? 0) === 1 ? 1 : -1);
    }
  }
  let hex = '';
  for (let i = 0; i < SIMHASH_BITS; i += 4) {
    const nibble =
      (((votes[i] ?? 0) > 0 ? 1 : 0) << 3) |
      (((votes[i + 1] ?? 0) > 0 ? 1 : 0) << 2) |
      (((votes[i + 2] ?? 0) > 0 ? 1 : 0) << 1) |
      ((votes[i + 3] ?? 0) > 0 ? 1 : 0);
    hex += nibble.toString(16);
  }
  return hex;
}

const POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/** Number of differing bits of two signatures (0 … 64). */
export function hamming(a: string, b: string): number {
  let distance = 0;
  for (let i = 0; i < SIMHASH_HEX_LENGTH; i += 1) {
    const left = Number.parseInt(a[i] ?? '0', 16);
    const right = Number.parseInt(b[i] ?? '0', 16);
    distance += POPCOUNT[(left ^ right) & 0xf] ?? 0;
  }
  return distance;
}

/**
 * Splits a signature into `count` bands of equal width (the last band takes the remainder).
 * Two signatures with a distance ≤ `count − 1` share at least one band (pigeonhole principle),
 * which makes the candidate search for nearly equal texts lossless (Property 9).
 */
export function bands(signature: string, count: number): string[] {
  const width = Math.floor(SIMHASH_HEX_LENGTH / count);
  return Array.from({ length: count }, (_, index) =>
    index === count - 1
      ? signature.slice(index * width)
      : signature.slice(index * width, (index + 1) * width),
  );
}
