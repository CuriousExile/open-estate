import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { loadLocaleCatalog } from '../locale/locale-catalog';
import { LocaleService } from '../locale/locale.service';
import { ThemeService } from '../theme/theme.service';
import { initialize, type JsonFetcher } from './initialize';
import { StartupState } from './startup-state';

/**
 * App initializer (design: AppInitializer). Never rejects: an aborted start is stored in
 * `StartupState` and the root component renders the error page instead of the app (Req 13.9).
 */
export async function runStartup(): Promise<void> {
  // All injections before the first `await` (injection context ends there).
  const http = inject(HttpClient);
  const startup = inject(StartupState);
  const document = inject(DOCUMENT);
  const themeService = inject(ThemeService);
  const localeService = inject(LocaleService);
  const fetchJson: JsonFetcher = (url) => firstValueFrom(http.get<unknown>(url));

  const result = await initialize(fetchJson, (message, fields) =>
    console.error(`[startup] ${message}`, fields),
  );
  startup.set(result);

  if (!result.ok) {
    document.documentElement.lang = startup.errorMessage()?.lang ?? '';
    return;
  }
  const { i18nConfig, defaultTranslation, theme } = result.context;
  themeService.init(theme.status === 'loaded' ? theme.value : undefined, i18nConfig.defaultLocale);
  // Hides locales with unreadable files (Req 13.12), then resolves the active locale (Req 13.6, 13.11).
  const catalog = await loadLocaleCatalog(
    fetchJson,
    i18nConfig,
    defaultTranslation,
    (message, fields) => console.warn(`[locale] ${message}`, fields),
  );
  await localeService.init(i18nConfig, catalog);
}
