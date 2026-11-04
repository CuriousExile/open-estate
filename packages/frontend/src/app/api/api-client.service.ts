import { inject, Injectable, InjectionToken } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import type { LocalizedListing } from '@open-estate/shared';
import { StartupState } from '../startup/startup-state';
import {
  createApiClient,
  type ApiClient,
  type ApiResult,
  type RequestOptions,
  type SearchPage,
  type SearchParams,
} from './api-client';

/**
 * Provider of the active locale, read on every API call (Req 13.10). Defaults to Transloco's active
 * language (set by the startup/LocaleService); override to decouple from Transloco.
 */
export const ACTIVE_LOCALE = new InjectionToken<() => string>('ACTIVE_LOCALE', {
  providedIn: 'root',
  factory: () => {
    const transloco = inject(TranslocoService);
    return () => transloco.getActiveLang();
  },
});

/** Angular facade of {@link createApiClient}; base URL from `runtime-config.json`. */
@Injectable({ providedIn: 'root' })
export class ApiClientService {
  private readonly startup = inject(StartupState);
  private readonly getLocale = inject(ACTIVE_LOCALE);
  private client: ApiClient | undefined;

  searchListings(params: SearchParams, options?: RequestOptions): Promise<ApiResult<SearchPage>> {
    return this.withClient((client) => client.searchListings(params, options));
  }

  getListing(id: string, options?: RequestOptions): Promise<ApiResult<LocalizedListing>> {
    return this.withClient((client) => client.getListing(id, options));
  }

  getMeta(options?: RequestOptions): Promise<ApiResult<unknown>> {
    return this.withClient((client) => client.getMeta(options));
  }

  private async withClient<T>(
    call: (client: ApiClient) => Promise<ApiResult<T>>,
  ): Promise<ApiResult<T>> {
    const client = this.resolveClient();
    return client
      ? call(client)
      : { ok: false, error: { kind: 'network', message: 'API base URL unavailable' } };
  }

  /** Created lazily: the runtime config is only known after the app initializer ran. */
  private resolveClient(): ApiClient | undefined {
    if (this.client) return this.client;
    const runtimeConfig = this.startup.context()?.runtimeConfig;
    if (runtimeConfig?.status !== 'loaded') return undefined;
    this.client = createApiClient({
      baseUrl: runtimeConfig.value.apiBaseUrl,
      fetch: (url, init) => globalThis.fetch(url, init),
      getLocale: this.getLocale,
    });
    return this.client;
  }
}
