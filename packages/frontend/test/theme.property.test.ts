// Feature: real-estate-platform, Property 30: Theme-Auflösung ist total
import fc from 'fast-check';
import {
  createProblemReporter,
  deriveLightPalette,
  resolveTheme,
  THEME_DEFAULTS,
  THEME_TEXT_MAX_LENGTH,
  THEME_URL_MAX_LENGTH,
  type ThemeModel,
  type ThemeProblem,
} from '../src/app/theme/resolve-theme';

/**
 * Property 30: for any Theme_Config (missing, invalid or partially localized values, junk)
 * `resolveTheme` returns a complete theme model. Per value: the valid input of the active
 * locale, else the valid value of the default locale, else the documented default. Every
 * invalid value yields exactly one log entry.
 *
 * Validity is known by construction (each generated value is labelled valid/invalid), so the
 * expected result is computed without the production validators.
 *
 * **Validates: Requirements 8.1, 8.3, 8.4, 8.5, 8.7**
 */

/** A generated config entry: omitted key, explicit `undefined`, valid or invalid value. */
type Field =
  | { kind: 'absent' }
  | { kind: 'undefined' }
  | { kind: 'valid'; value: unknown; expected: string }
  | { kind: 'invalid'; value: unknown };

/** An object-valued entry (`colors`, `texts`, `texts.appTitle`). */
type Group<T> =
  | { kind: 'absent' }
  | { kind: 'undefined' }
  | { kind: 'notObject'; value: unknown }
  | { kind: 'object'; fields: T };

interface ConfigCase {
  logoUrl: Field;
  colors: Group<{ primary: Field; secondary: Field; light: Group<Palette> }>;
  texts: Group<{ appTitle: Group<Array<[string, Field]>> }>;
  extra: Record<string, unknown>;
}

interface Palette {
  primary: Field;
  secondary: Field;
}

type RootCase =
  { kind: 'undefined' } | { kind: 'junk'; value: unknown } | { kind: 'config'; config: ConfigCase };

const LOCALES = ['de', 'en', 'fr', 'es', 'pt-BR'] as const;

// --- value generators (valid / invalid by construction) ---------------------------------

const nonString = fc.oneof(
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.jsonValue(), { maxLength: 3 }),
  fc.dictionary(fc.string({ maxLength: 5 }), fc.jsonValue(), { maxKeys: 3 }),
);

const nonObject = fc.oneof(
  fc.string({ maxLength: 10 }),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.jsonValue(), { maxLength: 3 }),
);

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const validColor = fc.stringMatching(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
const invalidColor = fc.oneof(
  fc.constantFrom(
    'red',
    'rgb(0,0,0)',
    '#abcd',
    '#12345',
    '#ggg',
    'abc',
    '123456',
    '',
    ' #abc',
    '#abc ',
  ),
  fc.stringMatching(/^#[0-9a-f]{7,9}$/),
  fc.string({ maxLength: 10 }).filter((s) => !HEX.test(s)),
  nonString,
);

const segment = fc.stringMatching(/^[a-z0-9_-]{1,12}$/);
const relativeUrl = fc
  .tuple(
    fc.boolean(),
    fc.array(segment, { minLength: 0, maxLength: 3 }),
    segment,
    fc.constantFrom('svg', 'png'),
  )
  .map(([abs, dirs, name, ext]) => `${abs ? '/' : ''}${[...dirs, `${name}.${ext}`].join('/')}`);
const httpsUrl = fc
  .tuple(fc.constantFrom('https', 'HTTPS'), fc.domain(), fc.array(segment, { maxLength: 3 }))
  .map(([scheme, host, path]) => `${scheme}://${host}/${path.join('/')}`);
const validLogo = fc.oneof(
  relativeUrl,
  httpsUrl,
  fc.constant(`${'a'.repeat(THEME_URL_MAX_LENGTH - 4)}.svg`),
);
const invalidLogo = fc.oneof(
  fc.constantFrom(
    '',
    'https://',
    'javascript:alert(1)',
    'data:image/svg+xml,<svg/>',
    `${'a'.repeat(THEME_URL_MAX_LENGTH - 3)}.svg`,
  ),
  fc
    .tuple(fc.constantFrom('http', 'ftp', 'javascript', 'file'), fc.domain())
    .map(([s, h]) => `${s}://${h}/logo.svg`),
  fc.domain().map((h) => `//${h}/logo.svg`),
  fc
    .tuple(relativeUrl, fc.constantFrom(' ', '\t', '\n', '\\', '\u0000', '\u007f'), fc.nat())
    .map(([url, bad, at]) => {
      const i = at % (url.length + 1);
      return url.slice(0, i) + bad + url.slice(i);
    }),
  nonString,
);

const validText = fc
  .tuple(
    fc
      .string({ minLength: 1, maxLength: THEME_TEXT_MAX_LENGTH })
      .filter((s) => s.trim().length > 0),
    fc.stringMatching(/^ {0,3}$/),
    fc.stringMatching(/^ {0,3}$/),
  )
  .filter(([core]) => core.trim().length <= THEME_TEXT_MAX_LENGTH)
  .map(([core, pre, post]) => `${pre}${core}${post}`);
const invalidText = fc.oneof(
  fc.stringMatching(/^[ \t\n]{0,4}$/),
  fc
    .integer({ min: THEME_TEXT_MAX_LENGTH + 1, max: THEME_TEXT_MAX_LENGTH + 30 })
    .map((n) => 'x'.repeat(n)),
  nonString,
);

function field(
  valid: fc.Arbitrary<unknown>,
  invalid: fc.Arbitrary<unknown>,
  trim = false,
): fc.Arbitrary<Field> {
  return fc.oneof(
    fc.constant<Field>({ kind: 'absent' }),
    fc.constant<Field>({ kind: 'undefined' }),
    valid.map<Field>((value) => ({
      kind: 'valid',
      value,
      expected: trim ? (value as string).trim() : (value as string),
    })),
    invalid.map<Field>((value) => ({ kind: 'invalid', value })),
  );
}

function group<T>(fields: fc.Arbitrary<T>): fc.Arbitrary<Group<T>> {
  return fc.oneof(
    { weight: 1, arbitrary: fc.constant<Group<T>>({ kind: 'absent' }) },
    { weight: 1, arbitrary: fc.constant<Group<T>>({ kind: 'undefined' }) },
    { weight: 1, arbitrary: nonObject.map<Group<T>>((value) => ({ kind: 'notObject', value })) },
    { weight: 4, arbitrary: fields.map<Group<T>>((f) => ({ kind: 'object', fields: f })) },
  );
}

const textField = field(validText, invalidText, true);
const appTitle = group(
  fc
    .uniqueArray(fc.constantFrom(...LOCALES), { maxLength: LOCALES.length })
    .chain((locales) =>
      fc.tuple(...locales.map((l) => textField.map((f): [string, Field] => [l, f]))),
    ),
);
const configCase: fc.Arbitrary<ConfigCase> = fc.record({
  logoUrl: field(validLogo, invalidLogo),
  colors: group(
    fc.record({
      primary: field(validColor, invalidColor),
      secondary: field(validColor, invalidColor),
      light: group(
        fc.record({
          primary: field(validColor, invalidColor),
          secondary: field(validColor, invalidColor),
        }),
      ),
    }),
  ),
  texts: group(fc.record({ appTitle })),
  // Unknown keys are not branding values and are ignored.
  extra: fc.dictionary(fc.constantFrom('version', 'comment', 'favicon'), fc.jsonValue(), {
    maxKeys: 2,
  }),
});
const rootCase: fc.Arbitrary<RootCase> = fc.oneof(
  { weight: 1, arbitrary: fc.constant<RootCase>({ kind: 'undefined' }) },
  { weight: 1, arbitrary: nonObject.map<RootCase>((value) => ({ kind: 'junk', value })) },
  { weight: 8, arbitrary: configCase.map<RootCase>((config) => ({ kind: 'config', config })) },
);

// --- building the raw config ------------------------------------------------------------

function put(
  target: Record<string, unknown>,
  key: string,
  entry: Field | Group<unknown>,
  build: (fields: never) => unknown,
): void {
  if (entry.kind === 'absent') return;
  if (entry.kind === 'undefined') target[key] = undefined;
  else if (entry.kind === 'object') target[key] = build(entry.fields as never);
  else target[key] = entry.value;
}

const noBuild = (): never => {
  throw new Error('unreachable');
};

function buildRaw(root: RootCase): unknown {
  if (root.kind === 'undefined') return undefined;
  if (root.kind === 'junk') return root.value;
  const { config } = root;
  const raw: Record<string, unknown> = { ...config.extra };
  put(raw, 'logoUrl', config.logoUrl, noBuild);
  put(
    raw,
    'colors',
    config.colors,
    (f: { primary: Field; secondary: Field; light: Group<Palette> }) => {
      const colors: Record<string, unknown> = {};
      put(colors, 'primary', f.primary, noBuild);
      put(colors, 'secondary', f.secondary, noBuild);
      put(colors, 'light', f.light, (l: Palette) => {
        const light: Record<string, unknown> = {};
        put(light, 'primary', l.primary, noBuild);
        put(light, 'secondary', l.secondary, noBuild);
        return light;
      });
      return colors;
    },
  );
  put(raw, 'texts', config.texts, (f: { appTitle: Group<Array<[string, Field]>> }) => {
    const texts: Record<string, unknown> = {};
    put(texts, 'appTitle', f.appTitle, (entries: Array<[string, Field]>) => {
      const byLocale: Record<string, unknown> = {};
      for (const [locale, entry] of entries) put(byLocale, locale, entry, noBuild);
      return byLocale;
    });
    return texts;
  });
  return raw;
}

// --- independent reference resolution ---------------------------------------------------

interface Expected {
  theme: ThemeModel;
  invalidPaths: string[];
}

function expectedResolution(root: RootCase, activeLocale: string, defaultLocale: string): Expected {
  const invalidPaths: string[] = [];
  const pick = (entry: Field, path: string): string | undefined => {
    if (entry.kind === 'invalid') invalidPaths.push(path);
    return entry.kind === 'valid' ? entry.expected : undefined;
  };
  const open = <T>(entry: Group<T>, path: string): T | undefined => {
    if (entry.kind === 'notObject') invalidPaths.push(path);
    return entry.kind === 'object' ? entry.fields : undefined;
  };

  if (root.kind !== 'config') {
    if (root.kind === 'junk') invalidPaths.push('$');
    return { theme: THEME_DEFAULTS, invalidPaths };
  }
  const { config } = root;
  const logoUrl = pick(config.logoUrl, 'logoUrl');
  const colors = open(config.colors, 'colors');
  const primary = colors && pick(colors.primary, 'colors.primary');
  const secondary = colors && pick(colors.secondary, 'colors.secondary');
  const light = colors && open(colors.light, 'colors.light');
  const lightPrimary = light && pick(light.primary, 'colors.light.primary');
  const lightSecondary = light && pick(light.secondary, 'colors.light.secondary');
  const brand = {
    primary: primary ?? THEME_DEFAULTS.colors.primary,
    secondary: secondary ?? THEME_DEFAULTS.colors.secondary,
  };
  const texts = open(config.texts, 'texts');
  const entries = texts && open(texts.appTitle, 'texts.appTitle');
  const titles = new Map<string, string | undefined>(
    (entries ?? []).map(([locale, entry]) => [locale, pick(entry, `texts.appTitle.${locale}`)]),
  );
  return {
    theme: {
      logoUrl: logoUrl ?? THEME_DEFAULTS.logoUrl,
      colors: {
        ...brand,
        // Missing light values are derived from the dark palette (unit-tested on their own).
        light: deriveLightPalette(brand, {
          ...(lightPrimary !== undefined && { primary: lightPrimary }),
          ...(lightSecondary !== undefined && { secondary: lightSecondary }),
        }),
      },
      texts: {
        appTitle:
          titles.get(activeLocale) ?? titles.get(defaultLocale) ?? THEME_DEFAULTS.texts.appTitle,
      },
    },
    invalidPaths,
  };
}

const sorted = (values: string[]): string[] => [...values].sort();

describe('Property 30: Theme-Auflösung ist total', () => {
  it('Feature: real-estate-platform, Property 30: Theme-Auflösung ist total', () => {
    fc.assert(
      fc.property(
        rootCase,
        fc.constantFrom(...LOCALES),
        fc.constantFrom(...LOCALES),
        (root, activeLocale, defaultLocale) => {
          const raw = buildRaw(root);
          const expected = expectedResolution(root, activeLocale, defaultLocale);

          const { theme, problems } = resolveTheme(raw, activeLocale, defaultLocale);

          // Complete model: exactly the documented keys, every value a non-empty string.
          expect(Object.keys(theme).sort()).toEqual(['colors', 'logoUrl', 'texts']);
          expect(Object.keys(theme.colors).sort()).toEqual(['light', 'primary', 'secondary']);
          expect(Object.keys(theme.colors.light).sort()).toEqual(['primary', 'secondary']);
          expect(Object.keys(theme.texts)).toEqual(['appTitle']);
          for (const value of [
            theme.logoUrl,
            theme.colors.primary,
            theme.colors.secondary,
            theme.colors.light.primary,
            theme.colors.light.secondary,
            theme.texts.appTitle,
          ]) {
            expect(typeof value).toBe('string');
            expect(value.length).toBeGreaterThan(0);
          }

          // Per-value fallback chain: active locale → default locale → documented default.
          expect(theme).toEqual(expected.theme);

          // Exactly one problem and one log entry per invalid value.
          expect(sorted(problems.map((p) => p.path))).toEqual(sorted(expected.invalidPaths));
          const logged: ThemeProblem[] = [];
          createProblemReporter((problem) => logged.push(problem))(problems);
          expect(sorted(logged.map((p) => p.path))).toEqual(sorted(expected.invalidPaths));
          for (const problem of logged) expect(problem.reason).toEqual(expect.any(String));
        },
      ),
      { numRuns: 100 },
    );
  });
});
