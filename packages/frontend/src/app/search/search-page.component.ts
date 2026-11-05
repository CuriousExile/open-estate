import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  signal,
  type TemplateRef,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import type { LocalizedListing } from '@open-estate/shared';
import type { SearchParams } from '../api/api-client';
import { ListingDetailComponent } from '../listing/listing-detail.component';
import { LocationService } from '../location/location.service';
import { withCountry } from '../location/location-model';
import { ResultListComponent } from '../results/result-list.component';
import { ShellLayout } from '../shell/shell-layout.service';
import { StartupState } from '../startup/startup-state';
import { EXTRA_FILTERS } from './filters/extra-filters';
import { validateWithFilters } from './filters/filter-registry';
import { SearchFormComponent, type SearchFormState } from './search-form.component';
import { formValuesFromQuery, searchQueryParams } from './search-url';

/**
 * Route `/`: the public search. Without search parameters it is the start page (hero image, search
 * card in the middle); a search — submitted or opened from a deep link — lives in the URL
 * (`/?offerType=SALE&city=…`) and switches the shell to the "searched" layout: darker background,
 * the search card as compact sticky header, results below. The card is handed to the app header
 * as a template, so it is not re-created when the layout changes.
 */
@Component({
  selector: 'oe-search-page',
  imports: [ListingDetailComponent, ResultListComponent, SearchFormComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #headerContent>
      <div class="hero-intro" [class.visually-hidden]="searched()">
        <h1 class="display">{{ 'home.title' | transloco }}</h1>
        <p class="lead">{{ 'home.subtitle' | transloco }}</p>
      </div>
      <oe-search-form
        class="site-search"
        [compact]="searched()"
        [state]="formState()"
        (search)="onSearch($event)"
      />
    </ng-template>

    @if (searched()) {
      <!-- Hidden, not removed, while a detail is open: loaded pages survive. -->
      <div [hidden]="selectedListing() !== undefined">
        <oe-result-list
          class="shell-results"
          [params]="searchParams()"
          (select)="selectedListing.set($event)"
        />
      </div>
      @if (selectedListing(); as listing) {
        @defer {
          <oe-listing-detail [listing]="listing" (close)="closeDetail(listing.id)" />
        }
      }
    }
  `,
})
export class SearchPageComponent {
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly layout = inject(ShellLayout);
  private readonly locations = inject(LocationService);
  private readonly meta = inject(StartupState).meta();
  private readonly resultList = viewChild(ResultListComponent);
  private readonly headerContent = viewChild.required<TemplateRef<unknown>>('headerContent');

  private readonly query = toSignal(this.route.queryParams, { initialValue: {} });
  /** Form values of the search in the URL; `undefined` = start page. */
  private readonly urlValues = computed(() => formValuesFromQuery(this.query()));
  protected readonly searched = computed(() => this.urlValues() !== undefined);

  /** URL search, validated like a submit (a hand-edited link may be invalid). */
  private readonly urlSearch = computed(() => {
    const values = this.urlValues();
    if (values === undefined) return undefined;
    return { values, result: validateWithFilters(EXTRA_FILTERS, values, this.meta) };
  });
  protected readonly formState = computed<SearchFormState | undefined>(() => {
    const search = this.urlSearch();
    if (search === undefined) return undefined;
    return {
      values: search.values,
      errors: 'errors' in search.result ? search.result.errors : [],
    };
  });

  /** Bumped when the same search is submitted again, so it runs again. */
  private readonly rerun = signal(0);
  /**
   * What the result list sends to Search_API: the URL's search plus the country of the header.
   * Changing the country re-runs the search; an invalid URL search sends nothing.
   */
  protected readonly searchParams = computed(() => {
    this.rerun();
    const result = this.urlSearch()?.result;
    const params = result !== undefined && 'params' in result ? { ...result.params } : undefined;
    return withCountry(params, this.locations.country());
  });
  /** Listing chosen in the result list; shown by the detail view instead of the results. */
  protected readonly selectedListing = signal<LocalizedListing | undefined>(undefined);

  constructor() {
    effect(() => this.layout.mode.set(this.searched() ? 'searched' : 'hero'));
    // A new URL search (submit, back/forward) closes an open detail view.
    effect(() => {
      this.urlSearch();
      this.selectedListing.set(undefined);
    });
    afterNextRender(() => this.layout.headerContent.set(this.headerContent()));
    inject(DestroyRef).onDestroy(() => {
      this.layout.headerContent.set(undefined);
      this.layout.mode.set('page');
    });
  }

  /** A valid submit: put the search into the URL (the URL drives the results). */
  protected onSearch(params: SearchParams): void {
    const queryParams = searchQueryParams(params);
    const target = this.router.createUrlTree([], { relativeTo: this.route, queryParams });
    if (this.router.serializeUrl(target) === this.router.url) {
      this.selectedListing.set(undefined);
      this.rerun.update((n) => n + 1);
      return;
    }
    void this.router.navigateByUrl(target);
  }

  /** Back to the results; focus returns to the entry of the listing once the list is visible. */
  protected closeDetail(id: string): void {
    this.selectedListing.set(undefined);
    afterNextRender(() => this.resultList()?.focusListing(id), { injector: this.injector });
  }
}
