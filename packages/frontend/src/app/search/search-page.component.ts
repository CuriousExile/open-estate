import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { LocalizedListing } from '@open-estate/shared';
import type { SearchParams } from '../api/api-client';
import { ListingDetailComponent } from '../listing/listing-detail.component';
import { LocationService } from '../location/location.service';
import { withCountry } from '../location/location-model';
import { ResultListComponent } from '../results/result-list.component';
import { SearchFormComponent } from './search-form.component';

/** Route `/`: the public search with result list and in-place detail view. */
@Component({
  selector: 'oe-search-page',
  imports: [ListingDetailComponent, ResultListComponent, SearchFormComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Hidden, not removed, while a detail is open: form values and loaded pages survive. -->
    <div [hidden]="selectedListing() !== undefined">
      <h1 class="display">{{ 'home.title' | transloco }}</h1>
      <p class="lead">{{ 'home.subtitle' | transloco }}</p>
      <oe-search-form class="shell-search" (search)="formParams.set($event)" />
      <oe-result-list
        class="shell-results"
        [params]="searchParams()"
        (select)="selectedListing.set($event)"
      />
    </div>
    @if (selectedListing(); as listing) {
      <oe-listing-detail [listing]="listing" (close)="closeDetail(listing.id)" />
    }
  `,
})
export class SearchPageComponent {
  private readonly injector = inject(Injector);
  private readonly resultList = viewChild(ResultListComponent);
  private readonly locations = inject(LocationService);

  /** Last valid search from the form. */
  protected readonly formParams = signal<SearchParams | undefined>(undefined);
  /**
   * What the result list sends to Search_API: the form's search plus the country of the header.
   * Changing the country re-runs the last search; before the first search nothing is sent.
   */
  protected readonly searchParams = computed(() =>
    withCountry(this.formParams(), this.locations.country()),
  );
  /** Listing chosen in the result list; shown by the detail view instead of search and results. */
  protected readonly selectedListing = signal<LocalizedListing | undefined>(undefined);

  /** Back to the results; focus returns to the entry of the listing once the list is visible. */
  protected closeDetail(id: string): void {
    this.selectedListing.set(undefined);
    afterNextRender(() => this.resultList()?.focusListing(id), { injector: this.injector });
  }
}
