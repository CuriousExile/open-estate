// Framework-free parsing of `GET /meta` for the search form (design: Search_API, Frontend).
import {
  buildSchemas,
  Currency,
  ExchangeRatesConfig,
  LocaleTag,
  TaxonomyConfig,
  validateTaxonomy,
  type LocaleConfig,
  type Schemas,
  type Taxonomy,
} from '@open-estate/shared';
import * as z from 'zod';

/**
 * `/meta` as far as the frontend uses it. Each part is validated on its own so a broken optional
 * part does not hide the others. Field bounds are not read from `/meta`: the frontend uses the same
 * `LISTING_BOUNDS` from `shared` that produce them (Req 4.7).
 */
const MetaSchema = z.object({
  taxonomy: z.unknown().optional(),
  locales: z
    .union([
      z.array(LocaleTag),
      z.object({
        defaultLocale: LocaleTag,
        enabled: z.array(z.object({ locale: LocaleTag, label: z.string() })),
      }),
    ])
    .optional()
    .catch(undefined),
  defaultCurrency: Currency.optional().catch(undefined),
  tourProviders: z.array(z.string().min(1)).optional().catch(undefined),
  exchangeRates: ExchangeRatesConfig.optional().catch(undefined),
});

/** Validated `/meta` plus the request schemas built from it (once, not per submit). */
export interface SearchMeta {
  /** `undefined` if missing or invalid: group/type selection is hidden (Req 7.1 degrades). */
  readonly taxonomy?: Taxonomy;
  readonly defaultCurrency?: string;
  readonly tourProviders?: readonly string[];
  /** Static exchange rates; `undefined` if not configured or invalid (no conversion). */
  readonly exchangeRates?: ExchangeRatesConfig;
  readonly schemas: Schemas;
}

/** Placeholder: the search form never sends `lang`, so the locale enum does not affect it. */
const NO_LOCALES: LocaleConfig = { defaultLocale: 'und', enabled: [] };

function toLocaleConfig(locales: z.infer<typeof MetaSchema>['locales']): LocaleConfig {
  if (locales === undefined) return NO_LOCALES;
  if (Array.isArray(locales)) {
    return {
      defaultLocale: locales[0] ?? NO_LOCALES.defaultLocale,
      enabled: locales.map((locale) => ({ locale, label: locale })),
    };
  }
  return locales;
}

function toTaxonomy(raw: unknown): Taxonomy | undefined {
  const config = TaxonomyConfig.safeParse(raw);
  if (!config.success) return undefined;
  const result = validateTaxonomy(config.data);
  return result.success && result.taxonomy.groups.length > 0 ? result.taxonomy : undefined;
}

/** Search metadata without `/meta`: empty taxonomy, every other filter works. */
export const FALLBACK_SEARCH_META: SearchMeta = {
  schemas: buildSchemas({ groups: [] }, NO_LOCALES),
};

/**
 * Validates a raw `/meta` response. Never throws: a missing or non-object response yields
 * {@link FALLBACK_SEARCH_META}; an invalid taxonomy only drops the taxonomy.
 */
export function parseSearchMeta(raw: unknown): SearchMeta {
  const meta = MetaSchema.safeParse(raw);
  if (!meta.success) return FALLBACK_SEARCH_META;
  const taxonomy = toTaxonomy(meta.data.taxonomy);
  const { defaultCurrency, tourProviders, exchangeRates } = meta.data;
  return {
    ...(taxonomy !== undefined && { taxonomy }),
    ...(defaultCurrency !== undefined && { defaultCurrency }),
    ...(tourProviders !== undefined && { tourProviders }),
    ...(exchangeRates !== undefined && { exchangeRates }),
    schemas: buildSchemas(taxonomy ?? { groups: [] }, toLocaleConfig(meta.data.locales)),
  };
}
