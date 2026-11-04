import { z } from 'zod';
import type { RawRecord } from '../connector';

/** Highest array index a path may address; keeps a typo from allocating a huge sparse array. */
export const MAX_PATH_INDEX = 99;

/** Keys that could reach the prototype chain; never accepted as a path segment. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** `name` or `name[3]`, joined by dots: `address.city`, `offers[0].price`. */
const PATH =
  /^[A-Za-z_][A-Za-z0-9_-]*(?:\[\d{1,2}\])*(?:\.[A-Za-z_][A-Za-z0-9_-]*(?:\[\d{1,2}\])*)*$/;
const SEGMENT = /([A-Za-z_][A-Za-z0-9_-]*)|\[(\d{1,2})\]/g;

type Segment = string | number;

/** Splits a path into keys and indices; `undefined` if it is not a valid, safe path. */
export function parsePath(path: string): Segment[] | undefined {
  if (path.length > 256 || !PATH.test(path)) return undefined;
  const segments: Segment[] = [];
  for (const match of path.matchAll(SEGMENT)) {
    if (match[1] !== undefined) {
      if (FORBIDDEN_KEYS.has(match[1])) return undefined;
      segments.push(match[1]);
    } else {
      const index = Number(match[2]);
      if (index > MAX_PATH_INDEX) return undefined;
      segments.push(index);
    }
  }
  return segments;
}

export const fieldPathSchema = z
  .string()
  .refine(
    (path) => parsePath(path) !== undefined,
    'must be a dot path like "address.city" or "offers[0].price"',
  );

/**
 * Field mapping from a source record into the listing input format.
 * Pure data: paths and constant values, no expressions, templates or code.
 */
export const fieldMappingSchema = z
  .strictObject({
    /** Target path (listing input) → source path (record or row). */
    fields: z.record(fieldPathSchema, fieldPathSchema),
    /** Target path → fixed value, e.g. `originalLocale: "de"`. Applied after `fields`. */
    constants: z.record(fieldPathSchema, z.json()).default({}),
  })
  .refine((m) => Object.keys(m.fields).length + Object.keys(m.constants).length > 0, {
    message: 'must map at least one field',
  });

export type FieldMapping = z.output<typeof fieldMappingSchema>;

/** Reads a value by path; `undefined` if any step is missing. Own properties only. */
export function getPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of parsePath(path) ?? []) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (current === null || typeof current !== 'object' || Array.isArray(current))
        return undefined;
      if (!Object.hasOwn(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

/** Writes `value` at `path`, creating objects/arrays on the way. Conflicting shapes are overwritten. */
function setPath(target: Record<string, unknown>, segments: Segment[], value: unknown): void {
  let current: Record<string | number, unknown> = target;
  segments.forEach((segment, i) => {
    if (i === segments.length - 1) {
      current[segment] = value;
      return;
    }
    const nextIsIndex = typeof segments[i + 1] === 'number';
    const existing = current[segment];
    const fits = nextIsIndex
      ? Array.isArray(existing)
      : existing !== null && typeof existing === 'object' && !Array.isArray(existing);
    if (!fits) current[segment] = nextIsIndex ? [] : {};
    current = current[segment] as Record<string | number, unknown>;
  });
}

/**
 * Builds one raw record in the listing input format (pipeline step 1 expects it).
 * Missing or `null` source values are skipped, so the target field stays absent and
 * the pipeline's validation decides whether that is acceptable.
 */
export function applyFieldMapping(source: unknown, mapping: FieldMapping): RawRecord {
  const result: Record<string, unknown> = {};
  for (const [target, sourcePath] of Object.entries(mapping.fields)) {
    const value = getPath(source, sourcePath);
    const segments = parsePath(target);
    if (value !== undefined && value !== null && segments) setPath(result, segments, value);
  }
  for (const [target, value] of Object.entries(mapping.constants)) {
    const segments = parsePath(target);
    if (segments) setPath(result, segments, structuredClone(value));
  }
  return result;
}
