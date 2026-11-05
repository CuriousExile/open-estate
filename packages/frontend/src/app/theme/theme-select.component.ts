import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { LocaleService } from '../locale/locale.service';
import { SelectComponent, type SelectOption } from '../ui/select/select.component';
import { ColorThemeService } from './color-theme.service';
import { parseThemePreference, THEME_PREFERENCES } from './theme-preference';

/**
 * Light/dark switch of the header (System, Light, Dark) in the shared dropdown `oe-select`. The
 * icon shows the applied theme (sun or moon; half disc for "System").
 */
@Component({
  selector: 'oe-theme-select',
  imports: [SelectComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <oe-select
      fieldName="theme"
      align="end"
      [label]="'theme.label' | transloco"
      [options]="options()"
      [value]="themes.preference()"
      (valueChange)="themes.setPreference(parse($event))"
    >
      <svg
        oeSelectIcon
        class="oe-select-icon"
        viewBox="0 0 24 24"
        width="18"
        height="18"
        aria-hidden="true"
      >
        @switch (themes.preference()) {
          @case ('light') {
            <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.6" />
            <path
              d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            />
          }
          @case ('dark') {
            <path
              d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linejoin="round"
            />
          }
          @default {
            <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.6" />
            <path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" />
          }
        }
      </svg>
    </oe-select>
  `,
})
export class ThemeSelectComponent {
  protected readonly themes = inject(ColorThemeService);
  private readonly locale = inject(LocaleService);
  private readonly transloco = inject(TranslocoService);

  protected readonly parse = parseThemePreference;

  protected readonly options = computed<SelectOption[]>(() => {
    this.locale.active(); // re-translate on a language switch
    return THEME_PREFERENCES.map((value) => ({
      value,
      label: this.transloco.translate(`theme.option.${value}`),
    }));
  });
}
