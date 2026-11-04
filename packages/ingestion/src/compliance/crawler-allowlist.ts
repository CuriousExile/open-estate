import { z } from 'zod';

/** Object key of the crawler allowlist in the private config bucket. */
export const CRAWLER_ALLOWLIST_CONFIG_KEY = 'crawler-allowlist.json';

/** Admissible crawl rate per target in requests per second (Req 6.5). */
export const MIN_RATE_PER_SECOND = 0.1;
export const MAX_RATE_PER_SECOND = 100;

/**
 * Canonical origin of an http(s) URL: lowercase scheme and host, punycode
 * host, default port dropped (`https://Partner.Example:443` →
 * `https://partner.example`). Returns `undefined` for anything that is not an
 * absolute http(s) URL.
 */
export function normalizeOrigin(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return url.origin;
}

/**
 * True if `input` denotes an origin only: no credentials, path, query or
 * fragment (a single trailing `/` is tolerated).
 */
function isBareOrigin(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      // URL drops an empty `?`/`#`, so check the raw input as well.
      !input.includes('?') &&
      !input.includes('#')
    );
  } catch {
    return false;
  }
}

export const crawlerTargetSchema = z.strictObject({
  /** `scheme://host[:port]`; normalized to the canonical origin on load. */
  origin: z
    .string()
    .refine((o) => normalizeOrigin(o) !== undefined && isBareOrigin(o), {
      message: 'must be an http(s) origin without path, query, fragment or credentials',
    })
    .transform((o) => normalizeOrigin(o) ?? o),
  /**
   * Legal basis for crawling this target. Deliberately NOT rejected on load
   * when missing, null or blank: the ComplianceChecker denies such targets at
   * runtime with the reason „fehlende Rechtsgrundlage", so the crawl log
   * records the reason per target (Req 6.9, design „crawler-allowlist.json").
   */
  legalBasis: z.string().nullish(),
  /** Maximum request rate against this origin (Req 6.5); enforced by the RateLimiter. */
  ratePerSecond: z.number().min(MIN_RATE_PER_SECOND).max(MAX_RATE_PER_SECOND).optional(),
  notes: z.string().optional(),
});

export const crawlerAllowlistSchema = z
  .strictObject({ targets: z.array(crawlerTargetSchema) })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.targets.forEach((target, index) => {
      if (seen.has(target.origin)) {
        ctx.addIssue({
          code: 'custom',
          path: ['targets', index, 'origin'],
          message: `duplicate origin "${target.origin}"`,
        });
      }
      seen.add(target.origin);
    });
  });

export type CrawlerTarget = z.infer<typeof crawlerTargetSchema>;
export type CrawlerAllowlist = z.infer<typeof crawlerAllowlistSchema>;
