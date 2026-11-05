import * as z from 'zod';
import { LISTING_BOUNDS, ListingBase, piiFieldPaths } from './listing';

// Import configuration files (design: "Konfigurationsmodelle"). Validated with these schemas at
// `cdk synth` and at Lambda init, like every other config file.

/** Paths of all PII-marked listing fields, e.g. `contact.email` (Req 18.1). */
export const PII_FIELD_PATHS = piiFieldPaths(ListingBase) as [string, ...string[]];

/**
 * `pii-allowlist.json`: PII fields the import may keep, e.g. `{ "allowedFields": ["contact.name"] }`.
 * Only known PII paths are accepted, so a typo fails at deploy time instead of silently dropping
 * the field. A missing file or an empty list means: drop every PII field (Req 18.3).
 */
export const PiiAllowlistConfig = z.strictObject({
  allowedFields: z.array(z.enum(PII_FIELD_PATHS)),
});
export type PiiAllowlistConfig = z.infer<typeof PiiAllowlistConfig>;

/** Host name as compared against tour URLs: non-empty, no scheme, port or path. */
const Hostname = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.-]+$/, { message: 'Expected a bare host name' });

/**
 * `tour-providers.json`: `{ "providers": [ { "code": "matterport", "hostnames": ["my.matterport.com"] } ] }`.
 * Provider codes and host names are unique; host names are compared case-insensitively and
 * exactly, without wildcards (Req 16.2, 16.4).
 */
export const TourProvidersConfig = z
  .strictObject({
    providers: z.array(
      z.strictObject({
        code: z.string().min(LISTING_BOUNDS.providerCode.min).max(LISTING_BOUNDS.providerCode.max),
        hostnames: z.array(Hostname).min(1),
      }),
    ),
  })
  .superRefine(({ providers }, ctx) => {
    const codes = new Set<string>();
    const hosts = new Set<string>();
    providers.forEach((provider, p) => {
      if (codes.has(provider.code)) {
        ctx.addIssue({
          code: 'custom',
          path: ['providers', p, 'code'],
          message: `Provider code ${provider.code} occurs more than once`,
        });
      }
      codes.add(provider.code);
      provider.hostnames.forEach((hostname, h) => {
        const key = hostname.toLowerCase();
        if (hosts.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['providers', p, 'hostnames', h],
            message: `Host name ${hostname} occurs more than once`,
          });
        }
        hosts.add(key);
      });
    });
  });
export type TourProvidersConfig = z.infer<typeof TourProvidersConfig>;

/** Lower-cased host name → provider code, for exact case-insensitive lookups. */
export function tourHostIndex(config: TourProvidersConfig): ReadonlyMap<string, string> {
  return new Map(
    config.providers.flatMap(({ code, hostnames }) =>
      hostnames.map((hostname) => [hostname.toLowerCase(), code] as const),
    ),
  );
}
