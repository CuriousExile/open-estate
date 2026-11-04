import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { THEME_DEFAULTS } from '../src/app/theme/resolve-theme';

/**
 * docs/configuration.md documents every theme-config value with format and default (Req 8.6);
 * the table must match `THEME_DEFAULTS`, the source of the defaults (task 20.5).
 *
 * **Validates: Requirements 8.6**
 */
describe('theme documentation', () => {
  const doc = readFileSync(resolve(__dirname, '../../../docs/configuration.md'), 'utf8');
  const rows = new Map(
    [...doc.matchAll(/^\| `([\w.<>]+)` +\| ([^|]+?) +\| `([^`]+)` +\|/gm)].map(
      ([, key, format, value]) => [key, { format, value }],
    ),
  );

  it('documents every theme value with format and its default', () => {
    expect(Object.fromEntries([...rows].map(([key, row]) => [key, row.value]))).toEqual({
      logoUrl: THEME_DEFAULTS.logoUrl,
      'colors.primary': THEME_DEFAULTS.colors.primary,
      'colors.secondary': THEME_DEFAULTS.colors.secondary,
      'texts.appTitle.<locale>': THEME_DEFAULTS.texts.appTitle,
    });
    for (const row of rows.values()) expect(row.format?.length).toBeGreaterThan(0);
  });
});
