import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { SelectComponent, type SelectOption } from '../ui/select/select.component';
import { LocaleService } from './locale.service';

/**
 * Language selection (Req 13.4, 13.5) in the shared dropdown `oe-select` (docs/design/README.md).
 * Each language is named in itself (`lang` per option). Holds no form state; switching never
 * navigates or reloads.
 */
@Component({
  selector: 'oe-language-select',
  imports: [SelectComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <oe-select
      fieldName="locale"
      align="end"
      [label]="'locale.select.label' | transloco"
      [options]="options()"
      [value]="locales.active()"
      (valueChange)="select($event)"
    >
      <svg
        oeSelectIcon
        class="oe-select-icon"
        viewBox="0 0 24 24"
        width="18"
        height="18"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6" />
        <path
          d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
        />
      </svg>
    </oe-select>
  `,
})
export class LanguageSelectComponent {
  protected readonly locales = inject(LocaleService);

  protected readonly options = computed<SelectOption[]>(() =>
    this.locales.options().map(({ locale, label }) => ({ value: locale, label, lang: locale })),
  );

  protected select(locale: string): void {
    void this.locales.setLocale(locale);
  }
}
