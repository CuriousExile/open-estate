// Feature: real-estate-platform, Property 29: Text-Fallback-Kette
import fc from 'fast-check';
import {
  CODE_LABEL_KINDS,
  codeLabelKey,
  createMissingTranslationReporter,
  resolveText,
  untranslatedDisplay,
  type MissingTranslation,
  type TranslationMap,
} from '../src/app/locale/text-fallback';

/**
 * Property 29: for any translation key, active locale and translation files the text of the
 * active locale is shown if present, else the text of the default locale, else the key itself
 * (for code-label keys: the code) — in the last case with exactly one log entry with locale and
 * key, however often the text is rendered.
 *
 * Covered: the framework-free chain that `FallbackMissingHandler` is built from (`resolveText`,
 * `createMissingTranslationReporter`, `untranslatedDisplay`), composed the same way as in the
 * handler. Transloco itself (calling the handler for absent/empty entries) is not exercised: the
 * frontend Jest setup has no Angular/Transloco runtime.
 *
 * Empty strings count as absent (implementation and Transloco `allowEmpty: false`): an empty entry
 * shows no text, so it is no usable entry in the sense of Req 13.7/13.8.
 *
 * **Validates: Requirements 13.1, 13.7, 13.8**
 */

const LOCALES = ['de', 'en', 'fr', 'pt-BR', 'de.a'] as const;

/** Keys: flat, dotted ("nested"), code labels, and names of inherited object properties. */
const segment = fc.constantFrom('home', 'title', 'search', 'a', 'b', 'SALE', 'villa', 'x-y');
const keyArb = fc.oneof(
  segment,
  fc.array(segment, { minLength: 2, maxLength: 4 }).map((s) => s.join('.')),
  fc.tuple(fc.constantFrom(...CODE_LABEL_KINDS), segment).map(([k, c]) => codeLabelKey(k, c)),
  fc.constantFrom('toString', 'constructor', '__proto__', 'hasOwnProperty', 'taxonomy.type.'),
);

/** Values: mostly real texts, some empty strings (count as absent). */
const valueArb = fc.oneof(
  { weight: 3, arbitrary: fc.string({ minLength: 1, maxLength: 8 }) },
  { weight: 1, arbitrary: fc.constant('') },
);

interface Scenario {
  translations: Record<string, TranslationMap>;
  defaultLocale: string;
  /** Rendered (active locale, key) pairs, with repetitions. */
  lookups: Array<{ locale: string; key: string }>;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .uniqueArray(keyArb, { minLength: 1, maxLength: 12 })
  .chain((keys) =>
    fc.record({
      // A locale may have no file at all; maps share keys (overlaps) and lack others (gaps).
      translations: fc
        .array(
          fc.tuple(
            fc.constantFrom(...LOCALES),
            fc.array(fc.tuple(fc.constantFrom(...keys), valueArb), { maxLength: keys.length }),
          ),
          { maxLength: LOCALES.length },
        )
        // Object.fromEntries defines own properties, so `__proto__` becomes a real entry.
        .map((files) =>
          Object.fromEntries(
            files.map(([locale, entries]) => [locale, Object.fromEntries(entries)]),
          ),
        ),
      defaultLocale: fc.constantFrom(...LOCALES),
      lookups: fc.array(
        fc.record({
          locale: fc.constantFrom(...LOCALES),
          // Mostly known keys; occasionally a key that is in no file.
          key: fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...keys) }, keyArb),
        }),
        { minLength: 1, maxLength: 30 },
      ),
    }),
  );

// --- independent reference --------------------------------------------------------------

function entry(
  translations: Record<string, TranslationMap>,
  locale: string,
  key: string,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(translations, locale)) return undefined;
  const file = translations[locale];
  if (file === undefined || !Object.prototype.hasOwnProperty.call(file, key)) return undefined;
  const value = file[key];
  return value === '' ? undefined : value;
}

function expectedText(s: Scenario, locale: string, key: string): string | undefined {
  return entry(s.translations, locale, key) ?? entry(s.translations, s.defaultLocale, key);
}

function expectedDisplay(key: string): string {
  for (const kind of ['offerType', 'taxonomy.group', 'taxonomy.type']) {
    if (key.startsWith(`${kind}.`) && key.length > kind.length + 1) {
      return key.slice(kind.length + 1);
    }
  }
  return key;
}

// --- property ---------------------------------------------------------------------------

describe('Property 29: Text-Fallback-Kette', () => {
  it('shows active-locale text, else default-locale text, else key/code with one log entry', () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const logged: MissingTranslation[] = [];
        const report = createMissingTranslationReporter((m) => logged.push(m));
        const expectedLog: MissingTranslation[] = [];
        const seen = new Set<string>();

        for (const { locale, key } of s.lookups) {
          const result = resolveText(key, locale, s.translations, s.defaultLocale);
          // Same composition as FallbackMissingHandler.handle (without parameter transpiling).
          if (result.missing) report(result.missing);
          const shown = result.missing ? untranslatedDisplay(key) : result.text;

          const text = expectedText(s, locale, key);
          if (text !== undefined) {
            expect(result).toEqual({ text });
            expect(shown).toBe(text);
          } else {
            expect(result).toEqual({ text: key, missing: { locale, key } });
            expect(shown).toBe(expectedDisplay(key));
            const id = `${locale}\u0000${key}`;
            if (!seen.has(id)) {
              seen.add(id);
              expectedLog.push({ locale, key });
            }
          }
        }

        // Exactly one entry per missing (locale, key), in first-render order; none for found texts.
        expect(logged).toEqual(expectedLog);
      }),
      { numRuns: 100 },
    );
  });
});
