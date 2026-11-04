import { DOCUMENT } from '@angular/common';
import { inject, Injectable, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import type { I18nConfig } from '../startup/config-schemas';
import { ThemeService } from '../theme/theme.service';
import type { LocaleCatalog, LocaleOption } from './locale-catalog';
import {
  readStoredLocale,
  removeStoredLocale,
  resolveLocale,
  writeStoredLocale,
  type StorageProvider,
} from './resolve-locale';
import { TranslationCache } from './translation-cache';

/**
 * Active locale and language switching (design: LocaleService; Req 13.4–13.6, 13.11, 13.12).
 * Switching only changes the Transloco language — no navigation or reload, so form state survives.
 */
@Injectable({ providedIn: 'root' })
export class LocaleService {
  private readonly transloco = inject(TranslocoService);
  private readonly theme = inject(ThemeService);
  private readonly document = inject(DOCUMENT);
  private readonly cache = inject(TranslationCache);
  private readonly storage: StorageProvider = () => this.document.defaultView?.localStorage;

  private readonly optionsState = signal<readonly LocaleOption[]>([]);
  private readonly activeState = signal('');

  /** Locales of the language selection: enabled and with a readable file (Req 13.4, 13.12). */
  readonly options = this.optionsState.asReadonly();
  /** Active BCP 47 locale (e.g. for the API `lang` parameter, Req 13.10). */
  readonly active = this.activeState.asReadonly();

  /** Called once by the app initializer after a successful start. */
  async init(config: I18nConfig, catalog: LocaleCatalog): Promise<void> {
    this.cache.set(catalog.translations);
    this.optionsState.set(catalog.options);
    this.transloco.setAvailableLangs(
      catalog.options.map(({ locale, label }) => ({ id: locale, label })),
    );
    this.transloco.setDefaultLang(config.defaultLocale);

    const stored = readStoredLocale(this.storage);
    // A stored choice that is no longer enabled ends; the locale is then determined anew (Req 13.11).
    if (stored !== undefined && !isListed(stored, config.enabled)) removeStoredLocale(this.storage);
    const locale = resolveLocale(
      stored,
      this.document.defaultView?.navigator.languages ?? [],
      catalog.options.map((option) => option.locale),
      config.defaultLocale,
    );
    await this.activate(locale);
  }

  /** User choice from the language selection: switches without reload and remembers it (Req 13.5, 13.11). */
  async setLocale(locale: string): Promise<void> {
    const option = this.optionsState().find((o) => o.locale === locale);
    if (!option) {
      console.warn('[locale] locale not available', { locale });
      return;
    }
    await this.activate(option.locale);
    if (!writeStoredLocale(this.storage, option.locale)) {
      console.warn('[locale] could not store language choice', { locale: option.locale });
    }
  }

  private async activate(locale: string): Promise<void> {
    // Served from the startup cache, so the switch is immediate (Req 13.5: ≤ 1 s).
    await firstValueFrom(this.transloco.load(locale));
    this.transloco.setActiveLang(locale);
    this.document.documentElement.lang = locale;
    this.theme.setLocale(locale);
    this.activeState.set(locale);
  }
}

function isListed(locale: string, entries: readonly { locale: string }[]): boolean {
  const wanted = locale.toLowerCase();
  return entries.some((entry) => entry.locale.toLowerCase() === wanted);
}
