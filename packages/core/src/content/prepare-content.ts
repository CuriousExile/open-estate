import {
  allowedAttributes,
  BINDABLE_ATTRIBUTES,
  PII_FIELD_PATHS,
  tourHostIndex,
  type PiiAllowlistConfig,
  type Taxonomy,
  type TourProvidersConfig,
} from '@open-estate/shared';
import type { z } from 'zod';
import { cleanMedia, type MediaDrop, type MediaTruncation } from './media-cleanup';
import { filterPii, type Candidate } from './pii-filter';

export interface FieldIssue {
  /** Dot-separated field path, e.g. `offers.0.price`. */
  readonly field: string;
  readonly reason: string;
}

/** PII allow-list and tour allow-list in lookup form; build once with `contentRules`. */
export interface ContentRules {
  readonly allowedPii: ReadonlySet<string>;
  /** Lower-cased host name → provider code (`tourHostIndex`). */
  readonly tourHosts: ReadonlyMap<string, string>;
  /**
   * Taxonomy whose group lists decide the allowed Objektmerkmale (duplicate-detection Req 2.5).
   * Every production wiring passes it; without it no merkmal is dropped (tests and tools only).
   */
  readonly taxonomy?: Taxonomy;
}

export interface ContentRulesConfig {
  /** Content of `pii-allowlist.json`; `undefined` (file missing) or empty ⇒ drop every PII field. */
  readonly piiAllowlist?: PiiAllowlistConfig;
  /** Content of `tour-providers.json`. */
  readonly tourProviders: TourProvidersConfig;
  /** Loaded taxonomy, for the Merkmalsbindung (see {@link ContentRules.taxonomy}). */
  readonly taxonomy?: Taxonomy;
}

export function contentRules(config: ContentRulesConfig): ContentRules {
  return {
    allowedPii: new Set(config.piiAllowlist?.allowedFields ?? []),
    tourHosts: tourHostIndex(config.tourProviders),
    ...(config.taxonomy !== undefined && { taxonomy: config.taxonomy }),
  };
}

interface PreparedContentBase {
  /** Removed PII field paths (never values), in `PII_FIELD_PATHS` order. */
  readonly droppedPii: readonly string[];
  /**
   * Removed Objektmerkmale not allowed for the group of the listing type (never values), in
   * `BINDABLE_ATTRIBUTES` order (duplicate-detection Req 2.5).
   */
  readonly droppedAttributes: readonly string[];
  readonly mediaDrops: readonly MediaDrop[];
  readonly mediaTruncations: readonly MediaTruncation[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Merkmalsbindung (duplicate-detection Req 2.5): removes the bindable Objektmerkmale that the
 * group of the candidate's listing type does not allow. A listing type outside the taxonomy is
 * left alone: the schema rejects it anyway. The input is not modified.
 */
export function bindAttributes(
  candidate: Candidate,
  taxonomy: Taxonomy | undefined,
): { candidate: Candidate; dropped: string[] } {
  const type = candidate['listingType'];
  const allowed =
    taxonomy === undefined || typeof type !== 'string'
      ? undefined
      : allowedAttributes(taxonomy, type);
  if (allowed === undefined) return { candidate, dropped: [] };

  const forbidden = BINDABLE_ATTRIBUTES.filter((attribute) => !allowed.has(attribute));
  const topLevel = new Set<string>(forbidden.filter((attribute) => !attribute.includes('.')));
  const inAddress = new Set<string>(
    forbidden.flatMap((attribute) =>
      attribute.startsWith('address.') ? [attribute.slice('address.'.length)] : [],
    ),
  );
  const address = candidate['address'];
  const dropped = forbidden.filter((attribute) =>
    attribute.startsWith('address.')
      ? isObject(address) && Object.hasOwn(address, attribute.slice('address.'.length))
      : Object.hasOwn(candidate, attribute),
  );
  if (dropped.length === 0) return { candidate, dropped };

  const result: Candidate = Object.fromEntries(
    Object.entries(candidate).filter(([key]) => !topLevel.has(key)),
  );
  if (isObject(address)) {
    result['address'] = Object.fromEntries(
      Object.entries(address).filter(([key]) => !inAddress.has(key)),
    );
  }
  return { candidate: result, dropped };
}

export type PreparedContent<T> =
  | (PreparedContentBase & { readonly ok: true; readonly content: T })
  | (PreparedContentBase & { readonly ok: false; readonly issues: readonly FieldIssue[] });

/**
 * Shared content preparation of import pipeline and Management_API (Req 4.3, 4.4, 4.10, 8.4 of
 * `listing-management`; Req 16.1–16.5, 16.11, 18.1–18.3 of `real-estate-platform`):
 * 1. PII filter — before validation, so an invalid but dropped PII value causes no rejection.
 * 2. Merkmalsbindung — Objektmerkmale the listing type's group does not allow are dropped
 *    (duplicate-detection Req 2.5), also before validation and for the same reason.
 * 3. Media/tour cleanup — before validation as well: an invalid medium or tour is dropped on its
 *    own instead of rejecting the listing.
 * 4. Validation against `schema` — on failure every field issue is returned.
 *
 * Dropped fields and media are returned in both cases so callers can log or report them.
 * The input is not modified.
 */
export function prepareContent<S extends z.ZodType>(
  candidate: Candidate,
  schema: S,
  rules: ContentRules,
): PreparedContent<z.output<S>> {
  const pii = filterPii(candidate, PII_FIELD_PATHS, rules.allowedPii);
  const bound = bindAttributes(pii.candidate, rules.taxonomy);
  const media = cleanMedia(bound.candidate, rules.tourHosts);
  const base: PreparedContentBase = {
    droppedPii: pii.dropped,
    droppedAttributes: bound.dropped,
    mediaDrops: media.drops,
    mediaTruncations: media.truncations,
  };
  const result = schema.safeParse(media.candidate);
  return result.success
    ? { ...base, ok: true, content: result.data }
    : { ...base, ok: false, issues: toFieldIssues(result.error.issues) };
}

/**
 * One issue per affected field. `unrecognized_keys` (e.g. rent fields on a `SALE` offer) names
 * several fields at once and is split so each one is reported. Zod messages describe types and
 * bounds, not input values.
 */
export function toFieldIssues(issues: readonly z.core.$ZodIssue[]): FieldIssue[] {
  return issues.flatMap((issue) => {
    const path = issue.path.map(String);
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        field: [...path, key].join('.'),
        reason: 'Unrecognized field',
      }));
    }
    return [{ field: path.length === 0 ? 'record' : path.join('.'), reason: issue.message }];
  });
}
