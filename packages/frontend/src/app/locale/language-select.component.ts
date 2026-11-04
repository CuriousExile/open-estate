import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { LocaleService } from './locale.service';

/**
 * Language selection (Req 13.4, 13.5): native `<select>` styled as an outlined pill dropdown
 * (docs/design/README.md). Holds no form state; switching never navigates or reloads.
 */
@Component({
  selector: 'oe-language-select',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="language-select">
      <span class="visually-hidden">{{ 'locale.select.label' | transloco }}</span>
      <select (change)="onChange($event)">
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
  styles: `
    .language-select {
      display: inline-flex;
    }

    select {
      appearance: none;
      padding: 0.5rem 2.25rem 0.5rem 1rem;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-pill);
      background:
        linear-gradient(45deg, transparent 50%, currentcolor 50%) right 1.1rem center / 0.35rem
          0.35rem no-repeat,
        linear-gradient(135deg, currentcolor 50%, transparent 50%) right 0.75rem center / 0.35rem
          0.35rem no-repeat,
        transparent;
      color: var(--color-text);
      font: inherit;
      font-size: 0.875rem;
      cursor: pointer;
    }

    select:hover {
      border-color: var(--brand-secondary);
    }

    option {
      color: var(--color-on-accent);
    }

    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `,
})
export class LanguageSelectComponent {
  protected readonly locales = inject(LocaleService);

  protected onChange(event: Event): void {
    void this.locales.setLocale((event.target as HTMLSelectElement).value);
  }
}
