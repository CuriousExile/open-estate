// Feature: real-estate-platform, Property 28: Frontend-Locale-Bestimmung und Sprachauswahl-Liste
import fc from 'fast-check';
import { selectAvailableLocales } from '../src/app/locale/locale-catalog';
import { resolveLocale } from '../src/app/locale/resolve-locale';
import {
  I18nConfigSchema,
  type I18nConfig,
  type Translation,
} from '../src/app/startup/config-schemas';
import type { LoadState } from '../src/app/startup/initialize';

/**
 * Property 28: for any stored choice, browser preference list, set of enabled locales and set of
 * readable translation files, the language selection lists exactly the enabled locales with a
 * readable file (configuration order), and the active locale is the stored choice if available,
 * else the first browser language that matches an available locale exactly or via its primary
 * language (`de-AT` → `de`), else the default locale.
 *
 * The default locale's file is always readable here: otherwise the start aborts (Req 13.9).
 * The expected values come from an independent reference model below.
 *
 * **Validates: Requirements 13.4, 13.6, 13.11, 13.12**
 */

const POOL = [
  'de',
  'en',
  'fr',
  'es',
  'it',
  'pt',
  'pt-BR',
  'de-AT',
  'de-CH',
  'en-GB',
  'en-US',
  'fr-CA',
  'zh-Hant-TW',
  'sr-Latn',
] as const;

/** Random upper/lower casing per character — still a valid BCP 47 tag. */
const caseVariant = (tag: string): fc.Arbitrary<string> =>
  fc
    .array(fc.boolean(), { minLength: tag.length, maxLength: tag.length })
    .map((upper) =>
      [...tag].map((c, i) => (upper[i] ? c.toUpperCase() : c.toLowerCase())).join(''),
    );

type FileState = 'loaded' | 'failed' | 'missing';

interface Scenario {
  config: I18nConfig;
  /** Load result per enabled non-default locale (`missing` = no entry). */
  files: Record<string, FileState>;
  /** A bogus failed entry for the default locale, which must be ignored. */
  brokenDefaultEntry: boolean;
  stored: string | undefined;
  browser: string[];
}

const configArb: fc.Arbitrary<{ config: I18nConfig; files: Record<string, FileState> }> = fc
  .uniqueArray(fc.constantFrom(...POOL), { minLength: 1, maxLength: 7 })
  .chain((tags) => fc.tuple(...tags.map(caseVariant)))
  .chain((enabled) =>
    fc.record({
      config: fc.record({
        defaultLocale: fc.constantFrom(...enabled),
        enabled: fc.constant(enabled.map((locale) => ({ locale, label: `Label ${locale}` }))),
      }),
      files: fc.tuple(
        ...enabled.map(() => fc.constantFrom<FileState>('loaded', 'failed', 'missing')),
      ),
    }),
  )
  .map(({ config, files }) => ({
    config,
    files: Object.fromEntries(
      config.enabled.map(({ locale }, i) => [locale, files[i] ?? 'missing']),
    ),
  }));

/** A candidate tag derived from the configuration, the pool or junk. */
function tagArb(config: I18nConfig, withSpaces: boolean): fc.Arbitrary<string> {
  const enabled = config.enabled.map((e) => e.locale);
  const pad = (arb: fc.Arbitrary<string>): fc.Arbitrary<string> =>
    withSpaces
      ? fc.tuple(arb, fc.constantFrom('', ' ', '  ')).map(([t, s]) => `${s}${t}${s}`)
      : arb;
  return fc.oneof(
    // exact enabled locale in any casing
    pad(fc.constantFrom(...enabled).chain(caseVariant)),
    // regional variant of an enabled locale's primary language (de-AT → de)
    pad(
      fc
        .tuple(fc.constantFrom(...enabled), fc.constantFrom('AT', 'ch', 'BR', 'Latn', 'US', '419'))
        .chain(([l, r]) => caseVariant(`${l.split('-')[0]}-${r}`)),
    ),
    // bare primary language of an enabled (possibly regional) locale (pt-BR → pt)
    pad(fc.constantFrom(...enabled).map((l) => l.slice(0, `${l}-`.indexOf('-')))),
    // any pool tag (may or may not be enabled)
    pad(fc.constantFrom(...POOL).chain(caseVariant)),
    // invalid / junk tags
    fc.constantFrom('', ' ', '*', 'de_AT', 'xx', '-de', 'en--', 'qq-AT', '12'),
    fc.string({ maxLength: 8 }),
  );
}

const scenarioArb: fc.Arbitrary<Scenario> = configArb.chain(({ config, files }) =>
  fc.record({
    config: fc.constant(config),
    files: fc.constant(files),
    brokenDefaultEntry: fc.boolean(),
    stored: fc.option(tagArb(config, false), { nil: undefined }),
    browser: fc.array(tagArb(config, true), { maxLength: 5 }),
  }),
);

// --- reference model ------------------------------------------------------------------------

/** Available locales: enabled and readable; the default locale is always readable. */
function expectedAvailable({ config, files }: Scenario): string[] {
  return config.enabled
    .map(({ locale }) => locale)
    .filter((locale) => locale === config.defaultLocale || files[locale] === 'loaded');
}

function expectedActive(s: Scenario, available: readonly string[]): string {
  const byKey = new Map(available.map((l) => [l.toLowerCase(), l] as const));
  const lookup = (tag: string): string | undefined => byKey.get(tag.trim().toLowerCase());
  // Stored choice: exact (case-insensitive) only — no primary-language matching (Req 13.11).
  const storedHit = s.stored === undefined ? undefined : lookup(s.stored);
  if (storedHit !== undefined) return storedHit;
  for (const language of s.browser) {
    const key = language.trim().toLowerCase();
    if (key === '') continue;
    const hit = byKey.get(key) ?? byKey.get(key.slice(0, (key + '-').indexOf('-')));
    if (hit !== undefined) return hit;
  }
  return s.config.defaultLocale;
}

// --- property -------------------------------------------------------------------------------

describe('Property 28: Frontend-Locale-Bestimmung und Sprachauswahl-Liste', () => {
  it('lists exactly the available locales and resolves stored choice → browser → default', () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        // Generated configs are valid i18n configurations (unique locales, default enabled).
        expect(I18nConfigSchema.safeParse(s.config).success).toBe(true);

        const defaultTranslation: Translation = { 'app.title': 'default' };
        const states: Record<string, LoadState<Translation>> = {};
        for (const { locale } of s.config.enabled) {
          if (locale === s.config.defaultLocale) continue;
          const file = s.files[locale];
          if (file === 'loaded') states[locale] = { status: 'loaded', value: { k: locale } };
          if (file === 'failed') states[locale] = { status: 'failed', error: 'unreadable' };
        }
        if (s.brokenDefaultEntry) {
          states[s.config.defaultLocale] = { status: 'failed', error: 'stale' };
        }

        const catalog = selectAvailableLocales(s.config, defaultTranslation, states);
        const available = expectedAvailable(s);

        // Language selection: exactly enabled ∩ readable, configuration order, with labels.
        expect(catalog.options).toEqual(
          available.map((locale) => ({ locale, label: `Label ${locale}` })),
        );
        expect(Object.keys(catalog.translations).sort()).toEqual([...available].sort());
        expect(catalog.translations[s.config.defaultLocale]).toBe(defaultTranslation);
        expect(catalog.unavailable.map((u) => u.locale)).toEqual(
          s.config.enabled.map((e) => e.locale).filter((l) => !available.includes(l)),
        );

        // Active locale, in configured spelling, and always one of the offered options.
        const active = resolveLocale(
          s.stored,
          s.browser,
          catalog.options.map((o) => o.locale),
          s.config.defaultLocale,
        );
        expect(active).toBe(expectedActive(s, available));
        expect(available).toContain(active);
      }),
      { numRuns: 100 },
    );
  });
});
