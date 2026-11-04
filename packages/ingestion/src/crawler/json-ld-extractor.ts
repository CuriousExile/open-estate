import type { RawRecord } from '../connector';

/**
 * Maps one fetched page to raw records for the import pipeline. Pure and synchronous:
 * no network access, the crawler alone decides what is fetched.
 */
export type ListingExtractor = (html: string, url: string) => RawRecord[];

/** schema.org types whose JSON-LD nodes the default extractor hands to the pipeline. */
export const JSON_LD_LISTING_TYPES: readonly string[] = [
  'RealEstateListing',
  'Offer',
  'SingleFamilyResidence',
  'Apartment',
  'House',
];

// Two simple passes instead of one combined pattern: no nested quantifiers, linear matching.
const SCRIPT_ELEMENT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const JSON_LD_TYPE_ATTR = /\btype\s*=\s*["']?application\/ld\+json(?:["'\s;]|$)/i;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Contents of every `<script type="application/ld+json">` that parses as JSON. */
export function jsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  for (const [, attributes = '', body = ''] of html.matchAll(SCRIPT_ELEMENT)) {
    if (!JSON_LD_TYPE_ATTR.test(attributes)) continue;
    try {
      blocks.push(JSON.parse(body));
    } catch {
      // Malformed blocks are skipped; other blocks of the page stay usable.
    }
  }
  return blocks;
}

/** Top-level nodes of a JSON-LD document: arrays and `@graph` are flattened one level. */
function topLevelNodes(block: unknown): JsonObject[] {
  const items = Array.isArray(block) ? block : [block];
  return items.filter(isObject).flatMap((node) => {
    const graph = node['@graph'];
    return Array.isArray(graph) ? graph.filter(isObject) : [node];
  });
}

function hasListingType(node: JsonObject): boolean {
  const type = node['@type'];
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === 'string' && JSON_LD_LISTING_TYPES.includes(t));
}

/**
 * Default extractor (`json-ld`): every top-level JSON-LD node typed as one of
 * {@link JSON_LD_LISTING_TYPES} becomes one raw record. JSON-LD keywords (`@…`) are
 * removed and `sourceUrl` defaults to the page URL.
 *
 * The node is expected to carry the listing fields in the project's own input format
 * (`id`, `title`, `offers`, …), e.g. on partner pages built for this purpose. Plain
 * schema.org vocabulary is not translated: the pipeline drops unknown fields and
 * rejects the incomplete record with its field issues. Sources with their own markup
 * register a dedicated extractor instead.
 */
export const jsonLdExtractor: ListingExtractor = (html, url) =>
  jsonLdBlocks(html)
    .flatMap(topLevelNodes)
    .filter(hasListingType)
    .map((node) => {
      const record: JsonObject = { sourceUrl: url };
      for (const [key, value] of Object.entries(node)) {
        if (!key.startsWith('@')) record[key] = value;
      }
      return record;
    });
