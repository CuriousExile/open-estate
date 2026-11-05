import { ChangeDetectionStrategy, Component, computed, inject, type OnInit } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { LocaleService } from '../locale/locale.service';
import { SelectComponent, type SelectOption } from '../ui/select/select.component';
import { LocationService } from './location.service';

/**
 * Country filter of the header, next to the language selection: "All countries" plus the
 * countries that have public listings, with localized names, code badges and listing counts, in the
 * shared dropdown `oe-select`. The choice is remembered like the language.
 */
@Component({
  selector: 'oe-country-select',
  imports: [SelectComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <oe-select
      fieldName="country"
      align="end"
      [label]="'location.country.label' | transloco"
      [options]="options()"
      [value]="locations.country()"
      (valueChange)="locations.setCountry($event)"
    >
      <svg
        oeSelectIcon
        class="oe-select-icon"
        viewBox="0 0 24 24"
        width="18"
        height="18"
        aria-hidden="true"
      >
        <path
          d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
        />
        <circle cx="12" cy="10" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6" />
      </svg>
    </oe-select>
  `,
})
export class CountrySelectComponent implements OnInit {
  protected readonly locations = inject(LocationService);
  private readonly locale = inject(LocaleService);
  private readonly transloco = inject(TranslocoService);

  protected readonly options = computed<SelectOption[]>(() => {
    const locale = this.locale.active(); // re-translate on a language switch
    const count = new Intl.NumberFormat(locale || undefined);
    return [
      { value: '', label: this.transloco.translate('location.country.all') },
      ...this.locations.countryOptions().map((option) => ({
        value: option.code,
        label: option.label,
        icon: option.code,
        meta: count.format(option.count),
      })),
    ];
  });

  ngOnInit(): void {
    void this.locations.load();
  }
}
