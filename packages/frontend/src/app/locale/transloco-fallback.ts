import { inject, Injectable, Injector, type ProviderToken } from '@angular/core';
import {
  TRANSLOCO_TRANSPILER,
  TranslocoService,
  type TranslocoFallbackStrategy,
  type TranslocoMissingHandler,
  type TranslocoMissingHandlerData,
  type TranslocoTranspiler,
} from '@jsverse/transloco';
import {
  createMissingTranslationReporter,
  resolveText,
  untranslatedDisplay,
} from './text-fallback';
import { TranslationCache } from './translation-cache';

/**
 * Transloco integration of the text fallback chain (Req 13.7, 13.8).
 *
 * The default locale is only known after `i18n-config.json` was loaded, so it cannot be put into the
 * static Transloco config (`fallbackLang`). Instead both hooks read it at call time from
 * `TranslocoService.getDefaultLang()`, which `LocaleService.init` sets to the configured default.
 * Texts come from the startup `TranslationCache` — no additional HTTP request.
 */

/**
 * Called by Transloco when the active locale has no entry for a key: default-locale text, else the
 * key or code, logging `{locale, key}` once per combination.
 */
@Injectable()
export class FallbackMissingHandler implements TranslocoMissingHandler {
  private readonly cache = inject(TranslationCache);
  // Cast: Transloco's typings resolve another @angular/core version (InjectionToken is nominal).
  private readonly transpiler = inject(
    TRANSLOCO_TRANSPILER as unknown as ProviderToken<TranslocoTranspiler>,
  );
  private readonly report = createMissingTranslationReporter((missing) =>
    console.warn('[i18n] missing translation', missing),
  );

  handle(key: string, data: TranslocoMissingHandlerData, params?: Record<string, unknown>): string {
    const translations = this.cache.all();
    const result = resolveText(key, data.activeLang, translations, data.defaultLang);
    if (result.missing) {
      this.report(result.missing);
      return untranslatedDisplay(key);
    }
    return this.transpiler.transpile({
      value: result.text,
      params: params ?? {},
      translation: translations[data.defaultLang] ?? {},
      key,
    }) as string;
  }
}

/**
 * `fallbackLang` = default locale: if a translation file fails to load, Transloco continues with the
 * default locale (whose file is guaranteed readable after startup, Req 13.9).
 */
@Injectable()
export class DefaultLocaleFallbackStrategy implements TranslocoFallbackStrategy {
  // Resolved lazily: TranslocoService itself depends on this strategy.
  private readonly injector = inject(Injector);

  getNextLangs(): string[] {
    return [this.injector.get(TranslocoService).getDefaultLang()];
  }
}
