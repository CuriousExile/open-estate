import { Injectable, signal, type TemplateRef } from '@angular/core';

/**
 * Layout of the app shell: `hero` = start page with the full background image and the search
 * card in the middle, `searched` = darker background and the search bar as compact sticky header,
 * `page` = any other route. The search page sets it and contributes its search card to the header
 * (`headerContent`), so the card can move into the header without being re-created.
 */
export type ShellMode = 'hero' | 'searched' | 'page';

@Injectable({ providedIn: 'root' })
export class ShellLayout {
  readonly mode = signal<ShellMode>('page');
  /** Rendered between brand and header controls; `undefined` = nothing. */
  readonly headerContent = signal<TemplateRef<unknown> | undefined>(undefined);
}
