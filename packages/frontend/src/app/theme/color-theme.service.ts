import { DOCUMENT } from '@angular/common';
import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import type { StorageProvider } from '../locale/resolve-locale';
import {
  DARK_SCHEME_QUERY,
  readStoredThemePreference,
  resolveColorTheme,
  writeStoredThemePreference,
  type ThemePreference,
} from './theme-preference';

/**
 * Light/dark theme of the header switch. The inline script in `index.html` sets `data-theme` and
 * `color-scheme` before the first paint; this service takes over afterwards: it follows a change
 * of the system setting while the choice is `system` and stores explicit choices.
 */
@Injectable({ providedIn: 'root' })
export class ColorThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly storage: StorageProvider = () => this.document.defaultView?.localStorage;
  private readonly media = this.document.defaultView?.matchMedia?.(DARK_SCHEME_QUERY);
  private readonly systemDark = signal(this.media?.matches ?? false);
  private readonly preferenceState = signal(readStoredThemePreference(this.storage));

  readonly preference = this.preferenceState.asReadonly();
  readonly theme = computed(() => resolveColorTheme(this.preferenceState(), this.systemDark()));

  constructor() {
    const onChange = (event: MediaQueryListEvent) => {
      this.systemDark.set(event.matches);
      this.apply();
    };
    this.media?.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() => this.media?.removeEventListener('change', onChange));
    this.apply();
  }

  setPreference(preference: ThemePreference): void {
    this.preferenceState.set(preference);
    if (!writeStoredThemePreference(this.storage, preference)) {
      console.warn('[theme] could not store theme choice');
    }
    this.apply();
  }

  private apply(): void {
    const root = this.document.documentElement;
    const theme = this.theme();
    root.dataset['theme'] = theme;
    root.style.colorScheme = theme;
  }
}
