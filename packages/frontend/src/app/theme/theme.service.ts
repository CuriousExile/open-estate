import { DOCUMENT } from '@angular/common';
import { computed, inject, Injectable, signal } from '@angular/core';
import {
  applyThemeCss,
  createProblemReporter,
  resolveTheme,
  THEME_DEFAULTS,
  type ThemeModel,
} from './resolve-theme';

/**
 * Applies the white-label theme (design: ThemeService; Req 8.1, 8.3–8.5, 8.7): CSS custom
 * properties on `<html>`, logo and branding texts as signals. Invalid values are logged once per path.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly state = signal<ThemeModel>(THEME_DEFAULTS);
  private readonly report = createProblemReporter(({ path, reason }) =>
    console.warn('[theme] invalid value, using default', { path, reason }),
  );
  private raw: unknown;
  private defaultLocale = '';

  readonly theme = this.state.asReadonly();
  readonly logoUrl = computed(() => this.state().logoUrl);
  readonly appTitle = computed(() => this.state().texts.appTitle);

  /** Called once after a successful start; `raw` is `undefined` if theme-config.json was unavailable. */
  init(raw: unknown, defaultLocale: string, activeLocale: string = defaultLocale): void {
    this.raw = raw;
    this.defaultLocale = defaultLocale;
    this.apply(activeLocale);
  }

  /** Re-resolves the localized texts for a new active locale (called by the LocaleService). */
  setLocale(locale: string): void {
    this.apply(locale);
  }

  private apply(activeLocale: string): void {
    const { theme, problems } = resolveTheme(this.raw, activeLocale, this.defaultLocale);
    this.report(problems);
    applyThemeCss(this.document.documentElement.style, theme);
    this.document.title = theme.texts.appTitle;
    this.state.set(theme);
  }
}
