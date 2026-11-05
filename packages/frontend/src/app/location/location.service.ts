import { DOCUMENT } from '@angular/common';
import { computed, inject, Injectable, signal } from '@angular/core';
import type { LocationsDocument } from '@open-estate/shared';
import { ApiClientService } from '../api/api-client.service';
import { LocaleService } from '../locale/locale.service';
import type { StorageProvider } from '../locale/resolve-locale';
import {
  availableCountry,
  COUNTRY_QUERY_PARAM,
  countryOptions,
  initialCountry,
  readStoredCountry,
  writeStoredCountry,
} from './location-model';

/**
 * Countries and cities with public listings (`GET /locations`, loaded once on first use) and the
 * country selection of the header. The choice is remembered in `localStorage` like the language;
 * `?country=XX` in the start URL preselects one (deep link). A country without listings falls back
 * to "all countries", so the search never filters to an empty country.
 */
@Injectable({ providedIn: 'root' })
export class LocationService {
  private readonly api = inject(ApiClientService);
  private readonly locale = inject(LocaleService);
  private readonly document = inject(DOCUMENT);
  private readonly storage: StorageProvider = () => this.document.defaultView?.localStorage;

  private readonly documentState = signal<LocationsDocument | undefined>(undefined);
  private readonly selectedState = signal(
    initialCountry(
      new URLSearchParams(this.document.defaultView?.location.search ?? '').get(
        COUNTRY_QUERY_PARAM,
      ),
      readStoredCountry(this.storage),
    ),
  );
  private loading: Promise<void> | undefined;

  /** `/locations` once loaded; `undefined` while loading or after a failure. */
  readonly locations = this.documentState.asReadonly();
  /** Selected country code, `''` = all countries. */
  readonly country = computed(() => availableCountry(this.selectedState(), this.documentState()));
  /** Options of the country selector in the active language. */
  readonly countryOptions = computed(() =>
    countryOptions(this.documentState(), this.locale.active()),
  );

  /** Starts loading `/locations` (idempotent; a failure is retried on the next call). */
  load(): Promise<void> {
    this.loading ??= this.api.getLocations().then((result) => {
      if (result.ok) {
        this.documentState.set(result.value);
      } else {
        console.warn('[locations] /locations unavailable; country and city lists are empty', {
          kind: result.error.kind,
        });
        this.loading = undefined;
      }
    });
    return this.loading;
  }

  setCountry(country: string): void {
    this.selectedState.set(country);
    if (!writeStoredCountry(this.storage, country)) {
      console.warn('[locations] could not store country choice');
    }
  }
}
