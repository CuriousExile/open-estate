import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { LocalizedListing } from '@open-estate/shared';
import type { SearchParams } from '../api/api-client';
import { ListingDetailComponent } from '../listing/listing-detail.component';
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
      <oe-search-form class="shell-search" (search)="searchParams.set($event)" />
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

  /** Last valid search from the form; the result list sends it to Search_API. */
  protected readonly searchParams = signal<SearchParams | undefined>(undefined);
  /** Listing chosen in the result list; shown by the detail view instead of search and results. */
  protected readonly selectedListing = signal<LocalizedListing | undefined>(undefined);

  /** Back to the results; focus returns to the entry of the listing once the list is visible. */
  protected closeDetail(id: string): void {
    this.selectedListing.set(undefined);
    afterNextRender(() => this.resultList()?.focusListing(id), { injector: this.injector });
  }
}
