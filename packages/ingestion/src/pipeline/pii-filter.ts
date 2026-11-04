export type Candidate = Record<string, unknown>;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface PiiFilterResult {
  readonly candidate: Candidate;
  /** Paths of the removed fields, in `piiPaths` order. Never the values. */
  readonly dropped: readonly string[];
}

/**
 * Removes every present PII field whose path is not allow-listed (Req 18.1, 18.3). Works on the
 * raw candidate (before validation), copy-on-write: the input is not modified. Paths are
 * dot-separated object paths (`contact.email`); array paths (`[]`) do not occur in the schema.
 */
export function filterPii(
  candidate: Candidate,
  piiPaths: readonly string[],
  allowed: ReadonlySet<string>,
): PiiFilterResult {
  let result = candidate;
  const dropped: string[] = [];
  for (const path of piiPaths) {
    if (allowed.has(path)) continue;
    const next = removePath(result, path.split('.'));
    if (next !== undefined) {
      result = next;
      dropped.push(path);
    }
  }
  return { candidate: result, dropped };
}

/** Returns a copy without the field at `keys`, or `undefined` if the field is absent. */
function removePath(object: Candidate, keys: readonly string[]): Candidate | undefined {
  const [key, ...rest] = keys;
  if (key === undefined || !Object.hasOwn(object, key)) return undefined;
  if (rest.length === 0) {
    return Object.fromEntries(Object.entries(object).filter(([k]) => k !== key));
  }
  const child = object[key];
  if (!isRecord(child)) return undefined;
  const nextChild = removePath(child, rest);
  return nextChild === undefined ? undefined : { ...object, [key]: nextChild };
}
