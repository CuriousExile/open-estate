import fc from 'fast-check';
import {
  applyThemeCss,
  contrastRatio,
  createProblemReporter,
  deriveLightPalette,
  LIGHT_CONTRAST_MIN,
  LIGHT_PAGE_BACKGROUND,
  resolveTheme,
  THEME_DEFAULTS,
  THEME_TEXT_MAX_LENGTH,
  type ThemeProblem,
} from '../src/app/theme/resolve-theme';

const VALID = {
  logoUrl: 'https://cdn.example.org/logo.svg',
  colors: { primary: '#0B5FFF', secondary: '#fb0' },
  texts: { appTitle: { de: 'Mein Portal', en: 'My Portal' } },
};

const paths = (problems: ThemeProblem[]): string[] => problems.map((p) => p.path).sort();

describe('resolveTheme', () => {
  it('uses all valid values (Req 8.1)', () => {
    expect(resolveTheme(VALID, 'de', 'en')).toEqual({
      theme: {
        logoUrl: 'https://cdn.example.org/logo.svg',
        colors: {
          primary: '#0B5FFF',
          secondary: '#fb0',
          light: deriveLightPalette({ primary: '#0B5FFF', secondary: '#fb0' }),
        },
        texts: { appTitle: 'Mein Portal' },
      },
      problems: [],
    });
  });

  it.each([undefined, {}, { colors: {}, texts: { appTitle: {} } }])(
    'falls back to documented defaults without problems for missing values: %j (Req 8.3)',
    (raw) => {
      expect(resolveTheme(raw, 'de', 'en')).toEqual({ theme: THEME_DEFAULTS, problems: [] });
    },
  );

  it('replaces invalid values by defaults and reports each path (Req 8.4)', () => {
    const raw = {
      logoUrl: 'javascript:alert(1)',
      colors: { primary: 'red', secondary: '#12345' },
      texts: { appTitle: { en: '   ', de: 42 } },
    };
    const { theme, problems } = resolveTheme(raw, 'de', 'en');
    expect(theme).toEqual(THEME_DEFAULTS);
    expect(paths(problems)).toEqual([
      'colors.primary',
      'colors.secondary',
      'logoUrl',
      'texts.appTitle.de',
      'texts.appTitle.en',
    ]);
  });

  it('reports the path but never the invalid value', () => {
    const { problems } = resolveTheme({ logoUrl: 'http://secret.example' }, 'en', 'en');
    expect(problems).toEqual([{ path: 'logoUrl', reason: expect.any(String) }]);
    expect(JSON.stringify(problems)).not.toContain('secret');
  });

  it.each([
    ['root', 'not-an-object', '$'],
    ['colors', { colors: '#000' }, 'colors'],
    ['texts', { texts: [] }, 'texts'],
    ['appTitle', { texts: { appTitle: 'Portal' } }, 'texts.appTitle'],
  ])('reports a non-object %s and uses defaults', (_name, raw, path) => {
    const { theme, problems } = resolveTheme(raw, 'en', 'en');
    expect(theme).toEqual(THEME_DEFAULTS);
    expect(paths(problems)).toEqual([path]);
  });

  it('keeps valid values next to invalid ones (Req 8.5)', () => {
    const raw = { ...VALID, colors: { primary: 'nope', secondary: '#A7E3C4' } };
    const { theme, problems } = resolveTheme(raw, 'en', 'en');
    expect(theme).toEqual({
      logoUrl: VALID.logoUrl,
      colors: {
        primary: THEME_DEFAULTS.colors.primary,
        secondary: '#A7E3C4',
        light: { primary: THEME_DEFAULTS.colors.primary, secondary: '#A7E3C4' },
      },
      texts: { appTitle: 'My Portal' },
    });
    expect(paths(problems)).toEqual(['colors.primary']);
  });

  describe('light palette (colors.light)', () => {
    it('derives the light palette from the dark one when it is missing (backward compatible)', () => {
      const { theme, problems } = resolveTheme(
        { colors: { primary: '#12352B', secondary: '#A7E3C4' } },
        'en',
        'en',
      );
      expect(theme.colors.light).toEqual({ primary: '#12352B', secondary: '#A7E3C4' });
      expect(problems).toEqual([]);
    });

    it('uses configured light values and derives only the missing one', () => {
      const raw = { colors: { primary: '#fb0', light: { primary: '#1D3557' } } };
      const { theme, problems } = resolveTheme(raw, 'en', 'en');
      expect(theme.colors).toEqual({
        primary: '#fb0',
        secondary: THEME_DEFAULTS.colors.secondary,
        light: { primary: '#1D3557', secondary: THEME_DEFAULTS.colors.secondary },
      });
      expect(problems).toEqual([]);
      const both = { colors: { light: { primary: '#004D40', secondary: '#FFF4C2' } } };
      expect(resolveTheme(both, 'en', 'en').theme.colors.light).toEqual(both.colors.light);
    });

    it('reports invalid light values and a non-object light group, keeping the derived defaults', () => {
      const invalid = resolveTheme({ colors: { light: { primary: 'green' } } }, 'en', 'en');
      expect(invalid.theme).toEqual(THEME_DEFAULTS);
      expect(paths(invalid.problems)).toEqual(['colors.light.primary']);
      const notObject = resolveTheme({ colors: { light: '#fff' } }, 'en', 'en');
      expect(notObject.theme).toEqual(THEME_DEFAULTS);
      expect(paths(notObject.problems)).toEqual(['colors.light']);
    });
  });

  describe('text fallback (Req 8.7)', () => {
    it('uses the default locale when the active locale has no entry', () => {
      expect(resolveTheme(VALID, 'fr', 'en').theme.texts.appTitle).toBe('My Portal');
    });

    it('uses the default locale when the active entry is invalid, and reports it', () => {
      const raw = { texts: { appTitle: { de: '', en: 'My Portal' } } };
      const { theme, problems } = resolveTheme(raw, 'de', 'en');
      expect(theme.texts.appTitle).toBe('My Portal');
      expect(paths(problems)).toEqual(['texts.appTitle.de']);
    });

    it('uses the documented default when neither locale has a valid entry', () => {
      const raw = { texts: { appTitle: { fr: 'Mon portail' } } };
      expect(resolveTheme(raw, 'de', 'en').theme.texts.appTitle).toBe(
        THEME_DEFAULTS.texts.appTitle,
      );
    });

    it('trims texts and limits their length', () => {
      const tooLong = 'x'.repeat(THEME_TEXT_MAX_LENGTH + 1);
      const raw = { texts: { appTitle: { en: '  Portal  ', de: tooLong } } };
      const { theme, problems } = resolveTheme(raw, 'en', 'en');
      expect(theme.texts.appTitle).toBe('Portal');
      expect(paths(problems)).toEqual(['texts.appTitle.de']);
    });
  });

  it.each(['logo.svg', '/assets/logo.png', 'https://cdn.example.org/a.svg'])(
    'accepts logo URL %s',
    (logoUrl) => {
      expect(resolveTheme({ logoUrl }, 'en', 'en').problems).toEqual([]);
    },
  );

  it.each([
    '',
    'http://cdn.example.org/a.svg',
    '//cdn.example.org/a.svg',
    'data:image/svg+xml,<svg/>',
    '/\\evil.example/a.svg',
    'logo .svg',
    'https://',
    `${'a'.repeat(2049)}.svg`,
  ])('rejects logo URL %j', (logoUrl) => {
    expect(paths(resolveTheme({ logoUrl }, 'en', 'en').problems)).toEqual(['logoUrl']);
  });

  it.each(['#abc', '#ABCDEF', '#12352b'])('accepts color %s', (primary) => {
    expect(resolveTheme({ colors: { primary } }, 'en', 'en').theme.colors.primary).toBe(primary);
  });

  it.each(['abc', '#abcd', '#ggg', 'rgb(0,0,0)', 0x123456])('rejects color %j', (primary) => {
    expect(paths(resolveTheme({ colors: { primary } }, 'en', 'en').problems)).toEqual([
      'colors.primary',
    ]);
  });
});

describe('applyThemeCss', () => {
  it('sets the brand custom properties of both palettes', () => {
    const calls: [string, string][] = [];
    applyThemeCss(
      { setProperty: (name, value) => void calls.push([name, value ?? '']) },
      {
        ...THEME_DEFAULTS,
        colors: {
          primary: '#000',
          secondary: '#fff',
          light: { primary: '#111', secondary: '#eee' },
        },
      },
    );
    expect(calls).toEqual([
      ['--brand-primary', '#000'],
      ['--brand-secondary', '#fff'],
      ['--brand-light-primary', '#111'],
      ['--brand-light-secondary', '#eee'],
    ]);
  });
});

describe('deriveLightPalette', () => {
  const hex = fc.stringMatching(/^#[0-9a-fA-F]{6}$/);

  it('keeps the defaults: the deep green already passes on the light page', () => {
    expect(deriveLightPalette(THEME_DEFAULTS.colors)).toEqual(THEME_DEFAULTS.colors.light);
    expect(contrastRatio('#12352B', LIGHT_PAGE_BACKGROUND)).toBeGreaterThan(10);
  });

  it('darkens a light brand colour and falls back to white text on it', () => {
    const light = deriveLightPalette({ primary: '#F1C40F', secondary: '#FFD54F' });
    expect(light.primary).not.toBe('#F1C40F');
    expect(contrastRatio(light.primary, LIGHT_PAGE_BACKGROUND)).toBeGreaterThanOrEqual(4.5);
    expect(light.secondary).toBe('#FFFFFF');
  });

  it('always reaches WCAG AA for derived values (text on the page, text on primary fills)', () => {
    fc.assert(
      fc.property(hex, hex, (primary, secondary) => {
        const light = deriveLightPalette({ primary, secondary });
        expect(contrastRatio(light.primary, LIGHT_PAGE_BACKGROUND)).toBeGreaterThanOrEqual(
          LIGHT_CONTRAST_MIN,
        );
        if (light.secondary === secondary) {
          expect(contrastRatio(secondary, light.primary)).toBeGreaterThanOrEqual(
            LIGHT_CONTRAST_MIN,
          );
        }
      }),
    );
  });
});

describe('createProblemReporter', () => {
  it('logs each path only once', () => {
    const logged: ThemeProblem[] = [];
    const report = createProblemReporter((problem) => logged.push(problem));
    const problem = { path: 'colors.primary', reason: 'r' };
    report([problem]);
    report([problem, { path: 'logoUrl', reason: 'r' }]);
    expect(paths(logged)).toEqual(['colors.primary', 'logoUrl']);
  });
});
