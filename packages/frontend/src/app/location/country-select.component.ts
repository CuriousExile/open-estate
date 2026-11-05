import { ChangeDetectionStrategy, Component, inject, type OnInit } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { LocationService } from './location.service';

/**
 * Country filter of the header, next to the language selection: "All countries" plus the
 * countries that have public listings, with localized names and listing counts. Native `<select>`
 * in the shared pill style (`.oe-select`, styles.scss); the choice is remembered like the language.
 */
@Component({
  selector: 'oe-country-select',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="oe-select-field">
      <span class="visually-hidden">{{ 'location.country.label' | transloco }}</span>
      <select class="oe-select" data-field="country" (change)="onChange($event)">
        <option value="" [selected]="locations.country() === ''">
          {{ 'location.country.all' | transloco }}
        </option>
        @for (option of locations.countryOptions(); track option.code) {
          <option [value]="option.code" [selected]="option.code === locations.country()">
            {{ 'location.country.option' | transloco: { name: option.label, count: option.count } }}
          </option>
        }
      </select>
    </label>
  `,
})
export class CountrySelectComponent implements OnInit {
  protected readonly locations = inject(LocationService);

  ngOnInit(): void {
    void this.locations.load();
  }

  protected onChange(event: Event): void {
    this.locations.setCountry((event.target as HTMLSelectElement).value);
  }
}
