import type { VersionedState } from './management';

// Diff of two versioned states (design: "Diff", Req 5.5, 7.6, 7.7, 8.6). Pure functions over
// JSON-like values: objects recursively with sorted keys, arrays position by position (media
// and offers have a business order). Diffs are never stored, only computed from two snapshots.

/** Path segment: object key or array index. */
export type DiffPath = (string | number)[];

export type DiffEntry =
  | { op: 'add'; path: DiffPath; value: unknown }
  | { op: 'remove'; path: DiffPath; oldValue: unknown }
  | { op: 'change'; path: DiffPath; oldValue: unknown; value: unknown };

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep copy so diff entries and applied states never alias their inputs. */
function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clone) as T;
  if (isObject(v)) {
    const out: JsonObject = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = clone(x);
    return out as T;
  }
  return v;
}

/** Keys with a defined value, sorted; `undefined` counts as absent (like JSON). */
const definedKeys = (o: JsonObject): string[] =>
  Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();

function diffValue(a: unknown, b: unknown, path: DiffPath, out: DiffEntry[]): void {
  if (isObject(a) && isObject(b)) {
    diffObject(a, b, path, out);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    diffArray(a, b, path, out);
  } else if (!Object.is(a, b)) {
    out.push({ op: 'change', path, oldValue: clone(a), value: clone(b) });
  }
}

function diffObject(a: JsonObject, b: JsonObject, path: DiffPath, out: DiffEntry[]): void {
  const keys = [...new Set([...definedKeys(a), ...definedKeys(b)])].sort();
  for (const key of keys) {
    const p = [...path, key];
    if (a[key] === undefined) out.push({ op: 'add', path: p, value: clone(b[key]) });
    else if (b[key] === undefined) out.push({ op: 'remove', path: p, oldValue: clone(a[key]) });
    else diffValue(a[key], b[key], p, out);
  }
}

function diffArray(a: unknown[], b: unknown[], path: DiffPath, out: DiffEntry[]): void {
  const common = Math.min(a.length, b.length);
  for (let i = 0; i < common; i++) diffValue(a[i], b[i], [...path, i], out);
  for (let i = common; i < b.length; i++)
    out.push({ op: 'add', path: [...path, i], value: clone(b[i]) });
  // Removals from the end, so applying the entries in order keeps the indices valid.
  for (let i = a.length - 1; i >= common; i--) {
    out.push({ op: 'remove', path: [...path, i], oldValue: clone(a[i]) });
  }
}

/** Differences from `a` to `b`; empty iff both states are equal. Order is deterministic. */
export function diffState(a: VersionedState, b: VersionedState): DiffEntry[] {
  const out: DiffEntry[] = [];
  diffValue(a, b, [], out);
  return out;
}

/** Applies `d` (as produced by {@link diffState}) to a copy of `a`; `a` stays unchanged. */
export function applyDiff(a: VersionedState, d: DiffEntry[]): VersionedState {
  const root = clone(a) as unknown as JsonObject;
  for (const entry of d) {
    if (entry.path.length === 0) throw new Error('applyDiff: empty path');
    const parent = entry.path
      .slice(0, -1)
      .reduce<unknown>((node, seg) => (node as JsonObject)[seg as string], root);
    const last = entry.path[entry.path.length - 1];
    if (Array.isArray(parent)) {
      if (typeof last !== 'number') throw new Error('applyDiff: array index expected');
      if (entry.op === 'remove') parent.splice(last, 1);
      else parent[last] = clone(entry.value);
    } else if (isObject(parent)) {
      if (entry.op === 'remove') Reflect.deleteProperty(parent, String(last));
      else parent[String(last)] = clone(entry.value);
    } else {
      throw new Error(`applyDiff: no container at ${JSON.stringify(entry.path.slice(0, -1))}`);
    }
  }
  return root as unknown as VersionedState;
}
