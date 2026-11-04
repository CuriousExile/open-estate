import { computed, Injectable, signal } from '@angular/core';
import { FALLBACK_SEARCH_META, parseSearchMeta, type SearchMeta } from '../search/search-meta';
import type { StartupContext, StartupResult } from './initialize';
import { startupErrorMessage, type StartupErrorMessage } from './startup-error-message';

/** Holds the startup result; set once by the app initializer before the root component renders. */
@Injectable({ providedIn: 'root' })
export class StartupState {
  private readonly state = signal<StartupResult | undefined>(undefined);

  readonly result = this.state.asReadonly();

  /** Loaded configuration (theme, i18n, runtime config, `/meta`) — only after a successful start. */
  readonly context = computed<StartupContext | undefined>(() => {
    const result = this.state();
    return result?.ok ? result.context : undefined;
  });

  /**
   * Validated `/meta` (taxonomy, currency, tour providers), parsed once for all consumers;
   * {@link FALLBACK_SEARCH_META} if it could not be loaded.
   */
  readonly meta = computed<SearchMeta>(() => {
    const meta = this.context()?.meta;
    return meta?.status === 'loaded' ? parseSearchMeta(meta.value) : FALLBACK_SEARCH_META;
  });

  /** Error page texts if the start was aborted (Req 13.9). */
  readonly errorMessage = computed<StartupErrorMessage | undefined>(() => {
    const result = this.state();
    return result && !result.ok ? startupErrorMessage(result.error, result.errorPage) : undefined;
  });

  set(result: StartupResult): void {
    this.state.set(result);
  }
}
