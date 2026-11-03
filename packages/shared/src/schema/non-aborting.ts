import { z } from 'zod';

// Non-aborting replacements for Zod checks that end validation of the whole object.
//
// Object-level cross-field rules run with `when: () => true` so that they report their errors
// together with field errors (Req 1.10, 4.9, 15.7). Zod 4.6 still skips such a rule as soon as
// any issue carries `continue: false` (`util.explicitlyAborted`). In Zod 4.6.7 these checks set it:
// - `z.number().int()` / `z.int()` on a non-integer number (`invalid_type`);
// - `z.array(…).max(n)` on a longer array (size cap: no element is parsed, `too_big`).
// The helpers below report the same violation without aborting and keep the JSON Schema output.

/** `z.number().int()` that does not abort; JSON Schema stays `type: 'integer'`. */
export const integer = () =>
  z.number().refine(Number.isInteger, { message: 'Expected an integer' }).meta({ type: 'integer' });

/**
 * `schema.max(max)` for arrays that does not abort: all elements are parsed, an over-long array
 * yields the same `too_big` issue as `.max()`, and `maxItems` stays in the JSON Schema.
 */
export function maxItems<T extends z.ZodArray>(schema: T, max: number) {
  return schema
    .superRefine(
      (items, ctx) => {
        if (items.length > max) {
          ctx.addIssue({
            code: 'too_big',
            origin: 'array',
            maximum: max,
            inclusive: true,
            input: items,
          });
        }
      },
      // Like `.max()`: also check the length when elements failed.
      { when: (payload) => Array.isArray(payload.value) },
    )
    .meta({ maxItems: max });
}
