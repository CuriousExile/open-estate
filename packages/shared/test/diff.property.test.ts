// Feature: listing-management, Property 16: Diff-Round-Trip
import fc from 'fast-check';
import { applyDiff, diffState, type DiffEntry, type VersionedState } from '../src';
import { arbVersionedState } from './arbitraries/management';

/**
 * For any two versioned states a, b: `applyDiff(a, diffState(a, b)) = b`, `diffState(a, a) = []`,
 * and every diff entry carries its path plus the old and/or new value according to its kind.
 *
 * **Validates: Requirements 7.6, 7.7**
 */

type Json = Record<string, unknown>;

/** Mixes the top-level and content keys of a and b, so pairs share parts (sparse, nested diffs). */
const arbStatePair: fc.Arbitrary<[VersionedState, VersionedState]> = fc.oneof(
  fc.tuple(arbVersionedState(), arbVersionedState()),
  fc
    .tuple(arbVersionedState(), arbVersionedState(), fc.func(fc.boolean()))
    .map(([a, other, pickOther]): [VersionedState, VersionedState] => {
      const blend = (x: Json, y: Json): Json => {
        const out: Json = {};
        for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
          const v = pickOther(k) ? y[k] : x[k];
          if (v !== undefined) out[k] = v;
        }
        return out;
      };
      const b = blend(a as unknown as Json, other as unknown as Json);
      b.content = blend(a.content as unknown as Json, other.content as unknown as Json);
      return [a, b as unknown as VersionedState];
    }),
);

/** Entry shape per kind: non-empty path; add → value, remove → oldValue, change → both. */
function hasShapeOfKind(e: DiffEntry): boolean {
  if (!Array.isArray(e.path) || e.path.length === 0) return false;
  if (!e.path.every((s) => typeof s === 'string' || typeof s === 'number')) return false;
  switch (e.op) {
    case 'add':
      return 'value' in e && !('oldValue' in e);
    case 'remove':
      return 'oldValue' in e && !('value' in e);
    case 'change':
      return 'oldValue' in e && 'value' in e;
    default:
      return false;
  }
}

describe('Property 16: Diff-Round-Trip', () => {
  it('applyDiff(a, diffState(a, b)) = b, diffState(a, a) = [], entries carry path and values', () => {
    fc.assert(
      fc.property(arbStatePair, ([a, b]) => {
        const aBefore = structuredClone(a);
        const d = diffState(a, b);

        expect(applyDiff(a, d)).toEqual(b);
        expect(a).toEqual(aBefore);
        expect(diffState(a, a)).toEqual([]);
        expect(diffState(a, structuredClone(a))).toEqual([]);
        for (const e of d) expect(hasShapeOfKind(e)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
