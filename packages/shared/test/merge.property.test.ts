// Feature: listing-management, Property 19: Zusammenführung beim Import
import fc from 'fast-check';
import {
  CONTENT_FIELDS,
  formatDecimal,
  ListingContent,
  ListingContentBase,
  mergeImport,
  type ImportMode,
  type ImportRecord,
  type ListingContentInput,
  type MergedContent,
} from '../src';
import { arbImportRecord, arbListingContent, type NullMode } from './arbitraries/management';

/**
 * For any stored Listing_Inhalt and Import_Datensatz (deep subset with `null` anywhere), in mode
 * `MERGE` every path delivered down to a scalar or list has the delivered value afterwards (lists
 * element-equal, in delivered order); a path delivered as `null` itself or below an object
 * delivered as `null` is absent; an undelivered path is unchanged. In mode `REPLACE` the content
 * equals the delivered one. On creation, undelivered optional fields carry their schema default or
 * are absent. An invalid result is rejected with field errors and the stored content is unchanged.
 *
 * **Validates: Requirements 12.6, 12.7, 12.8, 12.9**
 */

type Obj = Record<string, unknown>;

const isPlainObject = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Content fields of an Import_Datensatz (drops `id`, `customId`, `status`). */
const deliveredContent = (record: ImportRecord): Obj =>
  Object.fromEntries(
    CONTENT_FIELDS.flatMap((field) => {
      const value = (record as Obj)[field];
      return value === undefined ? [] : [[field, value]];
    }),
  );

/** Leaf paths: objects resolved recursively, lists, scalars and `null` are leaves. */
function leafPaths(value: Obj, prefix: string[] = []): string[][] {
  return Object.entries(value).flatMap(([key, child]) => {
    if (child === undefined) return [];
    const path = [...prefix, key];
    return isPlainObject(child) ? leafPaths(child, path) : [path];
  });
}

const getPath = (value: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((node, key) => (isPlainObject(node) ? node[key] : undefined), value);

/** What the record says about `path`: removed (`null` on it or above), a value, or nothing. */
function delivered(
  record: Obj,
  path: readonly string[],
): { kind: 'removed' } | { kind: 'value'; value: unknown } | { kind: 'absent' } {
  let node: unknown = record;
  for (const key of path) {
    if (!isPlainObject(node)) return { kind: 'absent' };
    node = node[key];
    if (node === null) return { kind: 'removed' };
    if (node === undefined) return { kind: 'absent' };
  }
  return { kind: 'value', value: node };
}

/**
 * Reference check of the per-path rule against `base` (stored content for `MERGE`, `{}` for
 * `REPLACE` and the delivered part of a creation): the result has exactly the leaves of `base`
 * and the record, with the record's value, removed under `null`, else the base value.
 */
function expectPathwiseMerge(base: Obj, record: Obj, merged: MergedContent): void {
  const result = merged as Obj;
  const keyOf = (path: readonly string[]): string => path.join('.');
  const candidates = new Map<string, string[]>();
  for (const path of [...leafPaths(base), ...leafPaths(record)]) candidates.set(keyOf(path), path);
  for (const path of candidates.values()) {
    const fromRecord = delivered(record, path);
    const actual = getPath(result, path);
    if (fromRecord.kind === 'removed') expect(actual).toBeUndefined();
    else if (fromRecord.kind === 'value') expect(actual).toEqual(fromRecord.value);
    else expect(actual).toEqual(getPath(base, path));
  }
  // No leaf appears that neither side carried.
  for (const path of leafPaths(result)) expect(candidates.has(keyOf(path))).toBe(true);
}

/** Internal Listing_Inhalt → API representation (amounts and area as decimal strings). */
function toInput(content: Obj): Obj {
  const input = { ...content };
  if (typeof input['area'] === 'number') input['area'] = formatDecimal(input['area']);
  if (Array.isArray(input['offers'])) {
    input['offers'] = (input['offers'] as Obj[]).map((offer) =>
      Object.fromEntries(
        Object.entries(offer).map(([key, value]) => [
          key,
          typeof value === 'number' ? formatDecimal(value) : value,
        ]),
      ),
    );
  }
  return input;
}

/**
 * Validation step (Req 12.9): a valid result is a fixed point of the schema (nothing missing,
 * nothing added); an invalid one yields field errors.
 */
function expectValidationOutcome(merged: MergedContent): void {
  const parsed = ListingContent.safeParse(toInput(merged as Obj) as ListingContentInput);
  if (parsed.success) {
    expect(parsed.data).toEqual(merged);
  } else {
    expect(parsed.error.issues.length).toBeGreaterThan(0);
    for (const issue of parsed.error.issues) expect(typeof issue.message).toBe('string');
  }
}

/** Schema default of a top-level content field (undefined if it has none). */
function schemaDefault(field: (typeof CONTENT_FIELDS)[number]): unknown {
  const parsed = ListingContentBase.shape[field].safeParse(undefined);
  return parsed.success ? parsed.data : undefined;
}

const arbNulls: fc.Arbitrary<NullMode> = fc.constantFrom('optional', 'any', 'none');
const arbRecord = arbNulls.chain((nulls) => arbImportRecord({ nulls }).map(({ record }) => record));

describe('Property 19: Zusammenführung beim Import', () => {
  it.each<ImportMode>(['MERGE', 'REPLACE'])(
    '%s on an existing listing follows the per-path rule and leaves the inputs untouched',
    (mode) => {
      fc.assert(
        fc.property(arbListingContent(), arbRecord, (existing, record) => {
          const existingBefore = structuredClone(existing);
          const recordBefore = structuredClone(record);

          const merged = mergeImport(existing, record, mode);

          const base = mode === 'MERGE' ? (existing as Obj) : {};
          expectPathwiseMerge(base, deliveredContent(record), merged);
          expectValidationOutcome(merged);
          // Rejected or not, the stored listing content (and the record) are not modified.
          expect(existing).toEqual(existingBefore);
          expect(record).toEqual(recordBefore);
        }),
        { numRuns: 100 },
      );
    },
  );

  it.each<ImportMode>(['MERGE', 'REPLACE'])(
    'creation in mode %s keeps delivered fields and fills undelivered ones with schema defaults',
    (mode) => {
      fc.assert(
        fc.property(arbRecord, (record) => {
          const recordBefore = structuredClone(record);
          const content = deliveredContent(record);

          const merged = mergeImport(undefined, record, mode);

          const result = merged as Obj;
          for (const field of CONTENT_FIELDS) {
            const value = content[field];
            if (value === undefined || value === null) {
              expect(result[field]).toEqual(schemaDefault(field));
            }
          }
          // Delivered part: same per-path rule as a merge into the defaults.
          const defaults = Object.fromEntries(
            CONTENT_FIELDS.flatMap((field) => {
              const value = schemaDefault(field);
              return value === undefined ? [] : [[field, value]];
            }),
          );
          // A top-level `null` counts as not delivered on creation (default applies, see above).
          const deliveredFields = Object.fromEntries(
            Object.entries(content).filter(([, value]) => value !== null),
          );
          expectPathwiseMerge(defaults, deliveredFields, merged);
          expectValidationOutcome(merged);
          expect(record).toEqual(recordBefore);
        }),
        { numRuns: 100 },
      );
    },
  );
});
