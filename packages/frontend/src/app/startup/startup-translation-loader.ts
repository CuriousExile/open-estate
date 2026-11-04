import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Translation, TranslocoLoader } from '@jsverse/transloco';
import { of, type Observable } from 'rxjs';
import { TranslationCache } from '../locale/translation-cache';
import { translationUrl } from './initialize';

/**
 * Transloco HTTP loader for `i18n/{locale}.json` (runtime files, not bundled — Req 13.3).
 * Files of available locales were loaded and validated during startup and are served from the cache.
 */
@Injectable({ providedIn: 'root' })
export class StartupTranslationLoader implements TranslocoLoader {
  private readonly http = inject(HttpClient);
  private readonly cache = inject(TranslationCache);

  getTranslation(lang: string): Observable<Translation> {
    const cached = this.cache.get(lang);
    return cached ? of(cached) : this.http.get<Translation>(translationUrl(lang));
  }
}
