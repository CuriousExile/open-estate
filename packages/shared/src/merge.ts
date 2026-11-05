import { CONTENT_FIELDS, ListingContentBase, type ListingContent } from './content';
import type { ImportMode, ImportRecord } from './management';

// Import merge (design: "Import-Pipeline", step 4; Req 12.6, 12.7, 12.8, 12.16). Pure functions;
// the result is not validated – the pipeline validates it afterwards (Req 12.9).

/** Deep subset without `null`: objects resolved recursively, lists whole. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

/**
 * Merged, not yet validated Listing_Inhalt. It may lack required fields (e.g. after `null` on a
 * required field or a partial record on creation); validation rejects it then.
 */
export type MergedContent = DeepPartial<ListingContent>;

type Obj = Record<string, unknown>;

const isPlainObject = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Content fields of `value` only (drops `id`, `customId`, `status`, provenance, …). */
function pickContent(value: object): Obj {
  const source = value as Obj;
  const picked: Obj = {};
  for (const field of CONTENT_FIELDS) {
    if (source[field] !== undefined) picked[field] = source[field];
  }
  return picked;
}

/**
 * Recursive `MERGE` of `patch` into `base`: delivered objects are merged key by key, lists and
 * scalars replace, `null` removes, `undefined` keeps. An object that ends up empty is omitted
 * (it carries no Inhaltsfeld and would only change the Inhalts_Hash).
 */
function mergeObject(base: Obj, patch: Obj): Obj {
  const result = new Map<string, unknown>(Object.entries(base));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) {
      result.delete(key);
    } else if (isPlainObject(value)) {
      const current = result.get(key);
      const merged = mergeObject(isPlainObject(current) ? current : {}, value);
      if (Object.keys(merged).length === 0) result.delete(key);
      else result.set(key, merged);
    } else {
      result.set(key, value);
    }
  }
  return Object.fromEntries(result);
}

/**
 * Schema defaults of the Listing_Inhalt: every top-level content field whose schema accepts a
 * missing value and yields a value for it (`.default(…)`). Optional fields without default stay
 * absent (Req 12.8). Derived from the schema, so defaults added there apply automatically.
 */
function contentDefaults(): Obj {
  const defaults: Obj = {};
  const shape = ListingContentBase.shape;
  for (const field of CONTENT_FIELDS) {
    const parsed = shape[field].safeParse(undefined);
    if (parsed.success && parsed.data !== undefined) defaults[field] = parsed.data;
  }
  return defaults;
}

/**
 * Merges an Import_Datensatz into the stored Listing_Inhalt (design: "Import-Pipeline", step 4).
 *
 * - creation (`existing` undefined): delivered fields; missing optional fields get their schema
 *   default or stay absent (Req 12.8); `null` counts as missing;
 * - `MERGE` (Req 12.6): recursive – objects (`address`, `geo`, `contact`) key by key, lists and
 *   scalars replace, `null` on any level removes the field or object, the rest stays;
 * - `REPLACE` (Req 12.7): result = delivered content; `null` counts as missing.
 *
 * Identity and status (`id`, `customId`, `status`) are no content and are ignored. Inputs are not
 * mutated. The result is not validated.
 */
export function mergeImport(
  existing: ListingContent | undefined,
  record: ImportRecord,
  mode: ImportMode,
): MergedContent {
  const delivered = pickContent(record);
  if (existing === undefined) return mergeObject(contentDefaults(), delivered) as MergedContent;
  const base = mode === 'MERGE' ? pickContent(existing) : {};
  return mergeObject(base, delivered) as MergedContent;
}

/**
 * Importmodus of a connector (Req 12.16): configuration, else the module's default, else
 * `MERGE`.
 */
export const resolveImportMode = (
  config: { importMode?: ImportMode },
  module: { defaultImportMode?: ImportMode },
): ImportMode => config.importMode ?? module.defaultImportMode ?? 'MERGE';
