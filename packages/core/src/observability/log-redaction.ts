import { PII_FIELD_PATHS } from '@open-estate/shared';

// Value-free logs (Req 18.2, design: "Observability"). Powertools Logger has no built-in
// redaction, so every log attribute passes through `redactLogValue` (see `RedactingLogFormatter`):
// PII fields of the listing schema, credential headers and error messages never reach a log line.

export const REDACTED = '[REDACTED]';

/**
 * Header and attribute names whose values are credentials. Compared case-insensitively and
 * without separators, so `Authorization`, `x-api-key`, `X_API_KEY` and `apiKey` all match.
 */
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'xapikey',
  'apikey',
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** PII paths as segments without array markers, e.g. `contact.email` → `['contact', 'email']`. */
const PII_SEGMENTS: readonly (readonly string[])[] = PII_FIELD_PATHS.map((path) =>
  path.split('.').map((segment) => segment.replace(/\[\]$/, '')),
);

/**
 * A value is PII when its key path ends with a PII path, wherever the listing sits in the logged
 * object (`listing.contact.email`, `items[].contact.phone`, a bare `contact` object).
 */
function isPiiPath(path: readonly string[]): boolean {
  return PII_SEGMENTS.some(
    (pii) =>
      pii.length <= path.length && pii.every((s, i) => path[path.length - pii.length + i] === s),
  );
}

const MAX_DEPTH = 16;

function redact(value: unknown, path: string[], seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  // Error messages and stacks may carry request values or ARNs; only the class name is logged.
  if (value instanceof Error) return { name: value.name };
  if (value instanceof Date) return value;
  if (seen.has(value) || path.length >= MAX_DEPTH) return REDACTED;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redact(item, path, seen));
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...path, key];
      out[key] =
        CREDENTIAL_KEYS.has(normalizeKey(key)) || isPiiPath(childPath)
          ? REDACTED
          : redact(child, childPath, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Copy of `value` with every PII field (by schema path suffix) and every credential header or
 * attribute replaced by `[REDACTED]`, errors reduced to `{ name }`. Cycles and nesting beyond
 * 16 levels are cut off. The input is not modified.
 */
export function redactLogValue(value: unknown): unknown {
  return redact(value, [], new WeakSet());
}

/** `redactLogValue` for a top-level attribute map. */
export function redactLogAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  return redactLogValue(attributes) as Record<string, unknown>;
}
