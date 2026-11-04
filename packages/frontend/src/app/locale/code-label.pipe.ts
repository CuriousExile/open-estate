import { Pipe, type PipeTransform } from '@angular/core';
import { codeLabelKey, type CodeLabelKind } from './text-fallback';

/**
 * Translation key of a language-neutral code (Req 13.1):
 * `{{ offer.offerType | codeLabel: 'offerType' | transloco }}` → label of `offerType.SALE`.
 * Without any translation the code itself is shown (Req 13.8, see `FallbackMissingHandler`).
 */
@Pipe({ name: 'codeLabel' })
export class CodeLabelPipe implements PipeTransform {
  transform(code: string, kind: CodeLabelKind): string {
    return codeLabelKey(kind, code);
  }
}
