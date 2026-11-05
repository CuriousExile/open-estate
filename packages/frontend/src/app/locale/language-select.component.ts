import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { LocaleService } from './locale.service';

/**
 * Language selection (Req 13.4, 13.5): native `<select>` in the shared pill style of all
 * dropdowns (`.oe-select`, styles.scss; docs/design/README.md). Holds no form state; switching
 * never navigates or reloads.
 */
@Component({
  selector: 'oe-language-select',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="oe-select-field">
      <span class="visually-hidden">{{ 'locale.select.label' | transloco }}</span>
      <select class="oe-select" (change)="onChange($event)">
        @for (option of locales.options(); track option.locale) {
          <option
            [value]="option.locale"
            [selected]="option.locale === locales.active()"
            [attr.lang]="option.locale"
          >
            {{ option.label }}
          </option>
        }
      </select>
    </label>
  `,
})
export class LanguageSelectComponent {
  protected readonly locales = inject(LocaleService);

  protected onChange(event: Event): void {
    void this.locales.setLocale((event.target as HTMLSelectElement).value);
  }
}
