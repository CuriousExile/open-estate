// Framework-free theme resolution (design: ThemeService, theme-config.json; Req 8.1, 8.3–8.5, 8.7).
// Kept free of Angular imports so it can be unit-tested with plain Jest.

/** One colour pair of the white-label theme. */
export interface ThemePalette {
  primary: string;
  secondary: string;
}

/** Fully resolved branding; every value is always set. */
export interface ThemeModel {
  logoUrl: string;
  /**
   * `primary`/`secondary` are the dark palette (the original single palette); `light` the palette
   * of the light theme, derived from them unless configured.
   */
  colors: ThemePalette & { light: ThemePalette };
  texts: { appTitle: string };
}

/** One invalid value in `theme-config.json`. Carries the path only, never the value. */
export interface ThemeProblem {
  path: string;
  reason: string;
}

export interface ResolvedTheme {
  theme: ThemeModel;
  problems: ThemeProblem[];
}

/**
 * Background of the light theme (`--color-page` in styles.scss). A derived light palette keeps at
 * least {@link LIGHT_CONTRAST_MIN} against it (WCAG AA for normal text).
 */
export const LIGHT_PAGE_BACKGROUND = '#F4EFE6';
export const LIGHT_CONTRAST_MIN = 4.5;

/** `#RGB` / `#RRGGBB` → `[r, g, b]` (0–255); the input is a validated hex colour. */
function rgb(hex: string): [number, number, number] {
  const digits = hex.length === 4 ? [...hex.slice(1)].map((d) => d + d).join('') : hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex([r, g, b]: readonly number[]): string {
  return `#${[r, g, b]
    .map((c) =>
      Math.round(c ?? 0)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`.toUpperCase();
}

/** WCAG 2 relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two hex colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `color`, darkened in 5 % steps towards black until it reaches `min` contrast on `background`. */
function darkenFor(color: string, background: string, min: number): string {
  if (contrastRatio(color, background) >= min) return color;
  const base = rgb(color);
  for (let step = 1; step <= 20; step++) {
    const darker = toHex(base.map((c) => c * (1 - step * 0.05)));
    if (contrastRatio(darker, background) >= min) return darker;
  }
  return '#000000';
}

/**
 * Light palette from the brand colours (used for every value `colors.light` leaves out): the
 * primary colour carries text, links and fills on the light background, so it is darkened until it
 * reaches AA contrast there; the secondary colour is the text on primary fills, white if it lacks
 * contrast on the (derived) primary.
 */
export function deriveLightPalette(
  brand: ThemePalette,
  light: Partial<ThemePalette> = {},
): ThemePalette {
  const primary =
    light.primary ?? darkenFor(brand.primary, LIGHT_PAGE_BACKGROUND, LIGHT_CONTRAST_MIN);
  const secondary =
    light.secondary ??
    (contrastRatio(brand.secondary, primary) >= LIGHT_CONTRAST_MIN ? brand.secondary : '#FFFFFF');
  return { primary, secondary };
}

/**
 * Documented defaults, used for every missing or invalid value (Req 8.3, 8.4).
 * Source for the theme-config documentation (Req 8.6).
 */
export const THEME_DEFAULTS: Readonly<ThemeModel> = Object.freeze({
  logoUrl: 'logo.svg',
  colors: Object.freeze({
    primary: '#12352B',
    secondary: '#A7E3C4',
    // = deriveLightPalette of the two above (the deep green already passes on the light page).
    light: Object.freeze({ primary: '#12352B', secondary: '#A7E3C4' }),
  }),
  texts: Object.freeze({ appTitle: 'Open Estate' }),
});

/** Maximum length of a branding text (after trimming). */
export const THEME_TEXT_MAX_LENGTH = 120;
/** Maximum length of the logo URL. */
export const THEME_URL_MAX_LENGTH = 2048;

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// Whitespace, control characters and backslashes (browsers treat `\` like `/`).
// eslint-disable-next-line no-control-regex
const UNSAFE_URL_CHARS = /[\s\u0000-\u001f\u007f\\]/;

type Check = (value: unknown) => string | undefined;

const checkColor: Check = (value) =>
  typeof value === 'string' && HEX_COLOR.test(value)
    ? undefined
    : 'expected hex color #RRGGBB or #RGB';

/** Relative URL (same origin) or absolute `https:` URL; protocol-relative `//host` is rejected. */
const checkLogoUrl: Check = (value) => {
  const reason = 'expected relative URL or https URL';
  if (typeof value !== 'string' || value.length === 0 || value.length > THEME_URL_MAX_LENGTH) {
    return reason;
  }
  if (UNSAFE_URL_CHARS.test(value) || value.startsWith('//')) return reason;
  if (!URL_SCHEME.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '' ? undefined : reason;
  } catch {
    return reason;
  }
};

const checkText: Check = (value) => {
  if (typeof value !== 'string' || value.trim().length === 0) return 'expected non-empty text';
  return value.trim().length > THEME_TEXT_MAX_LENGTH
    ? `expected at most ${THEME_TEXT_MAX_LENGTH} characters`
    : undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function has(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key) && record[key] !== undefined;
}

/** Collects problems while resolving; `undefined` input means "missing" (default, no problem). */
class Resolver {
  readonly problems: ThemeProblem[] = [];

  /** Object at `path`, or `undefined` if missing or not an object (the latter is a problem). */
  object(parent: Record<string, unknown> | undefined, key: string, path: string) {
    if (!parent || !has(parent, key)) return undefined;
    const value = parent[key];
    if (isRecord(value)) return value;
    this.problems.push({ path, reason: 'expected object' });
    return undefined;
  }

  /** Valid value at `path`, or `undefined` if missing or invalid (the latter is a problem). */
  value(parent: Record<string, unknown> | undefined, key: string, path: string, check: Check) {
    if (!parent || !has(parent, key)) return undefined;
    const value = parent[key];
    const reason = check(value);
    if (reason === undefined) return value as string;
    this.problems.push({ path, reason });
    return undefined;
  }
}

/**
 * Localized text: valid value of the active locale → valid value of the default locale →
 * documented default (Req 8.7). Every invalid locale entry is reported, independent of the
 * active locale, so the problem list is stable across locale switches.
 */
function resolveText(
  resolver: Resolver,
  texts: Record<string, unknown> | undefined,
  key: string,
  activeLocale: string,
  defaultLocale: string,
): string | undefined {
  const path = `texts.${key}`;
  const byLocale = resolver.object(texts, key, path);
  if (!byLocale) return undefined;
  const valid = new Map<string, string>();
  for (const locale of Object.keys(byLocale)) {
    const value = resolver.value(byLocale, locale, `${path}.${locale}`, checkText);
    if (value !== undefined) valid.set(locale, value.trim());
  }
  return valid.get(activeLocale) ?? valid.get(defaultLocale);
}

/**
 * Resolves raw `theme-config.json` into a complete `ThemeModel`. Each value is validated on its
 * own: valid values are used, missing ones fall back silently, invalid ones fall back and are
 * reported (Req 8.3–8.5). `raw === undefined` (file unavailable) yields the defaults.
 */
export function resolveTheme(
  raw: unknown,
  activeLocale: string,
  defaultLocale: string,
): ResolvedTheme {
  const resolver = new Resolver();
  let root: Record<string, unknown> | undefined;
  if (isRecord(raw)) root = raw;
  else if (raw !== undefined) resolver.problems.push({ path: '$', reason: 'expected object' });

  const colors = resolver.object(root, 'colors', 'colors');
  const light = resolver.object(colors, 'light', 'colors.light');
  const texts = resolver.object(root, 'texts', 'texts');
  const brand: ThemePalette = {
    primary:
      resolver.value(colors, 'primary', 'colors.primary', checkColor) ??
      THEME_DEFAULTS.colors.primary,
    secondary:
      resolver.value(colors, 'secondary', 'colors.secondary', checkColor) ??
      THEME_DEFAULTS.colors.secondary,
  };
  const lightPrimary = resolver.value(light, 'primary', 'colors.light.primary', checkColor);
  const lightSecondary = resolver.value(light, 'secondary', 'colors.light.secondary', checkColor);
  const theme: ThemeModel = {
    logoUrl: resolver.value(root, 'logoUrl', 'logoUrl', checkLogoUrl) ?? THEME_DEFAULTS.logoUrl,
    colors: {
      ...brand,
      light: deriveLightPalette(brand, {
        ...(lightPrimary !== undefined && { primary: lightPrimary }),
        ...(lightSecondary !== undefined && { secondary: lightSecondary }),
      }),
    },
    texts: {
      appTitle:
        resolveText(resolver, texts, 'appTitle', activeLocale, defaultLocale) ??
        THEME_DEFAULTS.texts.appTitle,
    },
  };
  return { theme, problems: resolver.problems };
}

/**
 * CSS custom properties set on `document.documentElement` (names match `styles.scss`): the dark
 * palette as `--brand-*` (unchanged names), the light palette as `--brand-light-*`. styles.scss
 * maps them to the semantic tokens of each theme (`--color-accent`, …).
 */
export function themeCssProperties(theme: ThemeModel): ReadonlyArray<readonly [string, string]> {
  return [
    ['--brand-primary', theme.colors.primary],
    ['--brand-secondary', theme.colors.secondary],
    ['--brand-light-primary', theme.colors.light.primary],
    ['--brand-light-secondary', theme.colors.light.secondary],
  ];
}

/** Applies the theme's CSS custom properties to a style declaration (DOM-free for tests). */
export function applyThemeCss(
  style: Pick<CSSStyleDeclaration, 'setProperty'>,
  theme: ThemeModel,
): void {
  for (const [name, value] of themeCssProperties(theme)) style.setProperty(name, value);
}

/** Returns a reporter that logs each problem path only once over its lifetime. */
export function createProblemReporter(
  log: (problem: ThemeProblem) => void,
): (problems: readonly ThemeProblem[]) => void {
  const reported = new Set<string>();
  return (problems) => {
    for (const problem of problems) {
      if (reported.has(problem.path)) continue;
      reported.add(problem.path);
      log(problem);
    }
  };
}
