import { Injectable } from '@angular/core';
import type { Translation } from '../startup/config-schemas';

/**
 * Translations validated during startup. Separate from the LocaleService so the Transloco loader
 * can read it without a circular dependency (LocaleService → TranslocoService → loader).
 */
@Injectable({ providedIn: 'root' })
export class TranslationCache {
  private translations: Readonly<Record<string, Translation>> = {};

  set(translations: Readonly<Record<string, Translation>>): void {
    this.translations = translations;
  }

  get(locale: string): Translation | undefined {
    return Object.hasOwn(this.translations, locale) ? this.translations[locale] : undefined;
  }

  /** All cached translations by locale (input of the text fallback chain). */
  all(): Readonly<Record<string, Translation>> {
    return this.translations;
  }
}
