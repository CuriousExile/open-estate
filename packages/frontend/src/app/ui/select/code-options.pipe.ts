import { inject, Pipe, type PipeTransform } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import type { SelectOption } from './select.component';

/**
 * Options of `oe-select` for a list of codes labelled by translation keys:
 * `statuses | codeOptions: 'portal.listings.status.' : locale.active() : 'portal.listings.filter.any'`
 * → an optional "any" entry (value `''`) plus one option per code (`<prefix><code>`). The locale
 * argument only makes the pure pipe re-run on a language switch.
 */
@Pipe({ name: 'codeOptions' })
export class CodeOptionsPipe implements PipeTransform {
  private readonly transloco = inject(TranslocoService);

  transform(
    codes: readonly string[],
    keyPrefix: string,
    _locale: string,
    anyKey?: string,
  ): SelectOption[] {
    return [
      ...(anyKey === undefined ? [] : [{ value: '', label: this.transloco.translate(anyKey) }]),
      ...codes.map((code) => ({ value: code, label: this.transloco.translate(keyPrefix + code) })),
    ];
  }
}
