import { DOCUMENT } from '@angular/common';
import { computed, inject, Injectable } from '@angular/core';
import { StartupState } from '../startup/startup-state';
import { resolvePortalConfig, type PortalConfigState } from './portal-auth-model';

/** `portal` block of `runtime-config.json`, validated once after the start. */
@Injectable({ providedIn: 'root' })
export class PortalConfigService {
  private readonly startup = inject(StartupState);
  private readonly document = inject(DOCUMENT);

  readonly state = computed<PortalConfigState>(() =>
    resolvePortalConfig(this.startup.context()?.runtimeConfig),
  );

  /** Origin of the SPA (OIDC redirect and logout URLs, relative Management_API URL). */
  origin(): string {
    return this.document.location.origin;
  }
}
