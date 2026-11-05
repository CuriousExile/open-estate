import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import {
  isDevMode,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
  type ApplicationConfig,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import {
  provideTransloco,
  provideTranslocoFallbackStrategy,
  provideTranslocoMissingHandler,
} from '@jsverse/transloco';
import { routes } from './app.routes';
import { bearerInterceptor } from './auth/bearer.interceptor';
import { provideOidcAuth } from './auth/oidc-config';
import { DefaultLocaleFallbackStrategy, FallbackMissingHandler } from './locale/transloco-fallback';
import { runStartup } from './startup/run-startup';
import { StartupTranslationLoader } from './startup/startup-translation-loader';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideHttpClient(withFetch(), withInterceptors([bearerInterceptor])),
    provideRouter(routes, withComponentInputBinding()),
    // Portal login; configuration is read from runtime-config.json on the first check.
    provideOidcAuth(),
    provideTransloco({
      config: {
        // Real default/available locales come from i18n-config.json and are set by runStartup.
        // "und" (BCP 47: undetermined) is never loaded: nothing translates before startup finished.
        defaultLang: 'und',
        availableLangs: [],
        reRenderOnLangChange: true,
        prodMode: !isDevMode(),
        // Fallback chain active locale → default locale → key/code is done by FallbackMissingHandler
        // from the startup cache (default locale is only known after startup, Req 13.7, 13.8).
        missingHandler: { useFallbackTranslation: false, logMissingKey: false },
      },
      loader: StartupTranslationLoader,
    }),
    provideTranslocoMissingHandler(FallbackMissingHandler),
    provideTranslocoFallbackStrategy(DefaultLocaleFallbackStrategy),
    provideAppInitializer(runStartup),
  ],
};
