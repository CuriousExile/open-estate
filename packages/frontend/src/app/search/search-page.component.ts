import { Location } from '@angular/common';
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
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import type { LocalizedListing } from '@open-estate/shared';
import type { SearchParams } from '../api/api-client';
import { ApiClientService } from '../api/api-client.service';
import { withPriceCurrency } from '../currency/currency-model';
import { CurrencyService } from '../currency/currency.service';
import { ListingDetailComponent } from '../listing/listing-detail.component';
import { convertPriceInput } from '../listing/listing-format';
import { LocationService } from '../location/location.service';
import { withCountry } from '../location/location-model';
import { ResultListComponent } from '../results/result-list.component';
import { ShellLayout } from '../shell/shell-layout.service';
import { StartupState } from '../startup/startup-state';
import { EXTRA_FILTERS } from './filters/extra-filters';
import { validateWithFilters } from './filters/filter-registry';
import { SearchFormComponent, type SearchFormState } from './search-form.component';
import {
  CURRENCY_QUERY_PARAM,
  currencyFromQuery,
  formValuesFromQuery,
  LISTING_QUERY_PARAM,
  listingIdFromQuery,
  sameFormValues,
  searchQueryParams,
} from './search-url';

/**
 * Route `/`: the public search. Without search parameters it is the start page (hero image, search
 * card in the middle); a search — submitted or opened from a deep link — lives in the URL
 * (`/?offerType=SALE&city=…`) and switches the shell to the "searched" layout: darker background,
 * the search card as compact sticky header, results below. A listing opened from the results is
 * in the URL too (`&listing=<id>`), so reload and back/forward keep or close it. The card is
 * handed to the app header as a template, so it is not re-created when the layout changes.
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
      <!-- Hidden, not removed, while a detail is open: loaded pages survive. The result list
           (with the image carousel) is a lazy chunk, so the start page stays small. -->
      <div [hidden]="selectedId() !== undefined">
        @defer {
          <oe-result-list
            #results
            class="shell-results"
            [params]="searchParams()"
            (select)="open($event)"
          />
        }
      </div>
      @if (selectedListing(); as listing) {
        @defer {
          <oe-listing-detail [listing]="listing" (close)="closeDetail()" />
        }
      } @else if (loadingListing()) {
        <p class="notice glass" role="status">{{ 'listingPage.loading' | transloco }}</p>
      }
    }
  `,
  styles: `
    .notice {
      margin: 0;
      padding: 1.25rem 1.5rem;
    }
  `,
})
export class SearchPageComponent {
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly api = inject(ApiClientService);
  private readonly route = inject(ActivatedRoute);
  private readonly layout = inject(ShellLayout);
  private readonly locations = inject(LocationService);
  private readonly currency = inject(CurrencyService);
  private readonly meta = inject(StartupState).meta();
  private readonly resultList = viewChild<ResultListComponent>('results');
  private readonly headerContent = viewChild.required<TemplateRef<unknown>>('headerContent');

  private readonly query = toSignal(this.route.queryParams, { initialValue: {} });
  /**
   * Form values of the search in the URL; `undefined` = start page. Compared by value, so adding
   * or removing `listing=` (opening/closing a detail) does not start the search again.
   */
  private readonly urlValues = computed(() => formValuesFromQuery(this.query()), {
    equal: sameFormValues,
  });
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
  /** Currency of the price bounds in the URL; the price filter currency if the URL has none. */
  private readonly urlCurrency = computed(() => currencyFromQuery(this.query()));
  /**
   * What the result list sends to Search_API: the URL's search plus the country of the header and
   * the price currency (with conversion, if rates are configured). Changing the country re-runs the
   * search; an invalid URL search sends nothing.
   */
  protected readonly searchParams = computed(() => {
    this.rerun();
    const result = this.urlSearch()?.result;
    const params = result !== undefined && 'params' in result ? { ...result.params } : undefined;
    return withPriceCurrency(
      withCountry(params, this.locations.country()),
      this.urlCurrency() ?? this.currency.priceCurrency(),
      this.currency.rates(),
    );
  });
  /** Id of the listing opened from the results (`listing=` in the URL). */
  protected readonly selectedId = computed(() => listingIdFromQuery(this.query()));
  /** The listing as clicked in the results; saves a request when it is opened from there. */
  private readonly clicked = signal<LocalizedListing | undefined>(undefined);
  /** Listing loaded for a `listing=` URL that was not opened by a click (reload, deep link). */
  private readonly fetched = signal<LocalizedListing | undefined>(undefined);
  /** Shown by the detail view instead of the results; follows the URL. */
  protected readonly selectedListing = computed(() => {
    const id = this.selectedId();
    if (id === undefined) return undefined;
    return [this.clicked(), this.fetched()].find((listing) => listing?.id === id);
  });
  /** `true` while the listing of a reloaded or shared URL is fetched. */
  protected readonly loadingListing = computed(
    () => this.selectedId() !== undefined && this.selectedListing() === undefined,
  );
  /** Whether this page pushed the current detail entry, so closing can go back in history. */
  private openedHere = false;

  constructor() {
    effect(() => this.layout.mode.set(this.searched() ? 'searched' : 'hero'));
    // Load the listing of a `listing=` URL that was not opened by a click.
    effect((onCleanup) => {
      const id = this.selectedId();
      if (id === undefined || untracked(this.selectedListing) !== undefined) return;
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      void this.api.getListing(id, { signal: controller.signal }).then((result) => {
        if (controller.signal.aborted) return;
        if (result.ok) this.fetched.set(result.value);
        // Unknown, no longer public or unreachable: drop the parameter and show the results.
        else if (result.error.kind !== 'aborted') this.setListingParam(undefined, true);
      });
    });
    // Focus the entry of a listing whose detail was closed (button, Escape or browser back).
    let previousId: string | undefined;
    effect(() => {
      const id = this.selectedId();
      const closed = previousId;
      previousId = id;
      if (id !== undefined || closed === undefined) return;
      this.openedHere = false;
      afterNextRender(() => this.resultList()?.focusListing(closed), { injector: this.injector });
    });
    afterNextRender(() => this.layout.headerContent.set(this.headerContent()));
    // Price bounds in another currency than the price fields (display currency switched, shared
    // link): convert them into the current one, so fields, URL and filter agree.
    effect(() => {
      const target = this.currency.priceCurrency();
      const from = this.urlCurrency();
      const values = this.urlValues();
      if (from === undefined || from === target || values === undefined) return;
      const rates = untracked(this.currency.rates);
      const convert = (value: string) => convertPriceInput(value, from, target, rates);
      untracked(() =>
        this.router.navigate([], {
          relativeTo: this.route,
          queryParams: {
            priceMin: convert(values.priceMin) || null,
            priceMax: convert(values.priceMax) || null,
            [CURRENCY_QUERY_PARAM]: target,
          },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        }),
      );
    });
    inject(DestroyRef).onDestroy(() => {
      this.layout.headerContent.set(undefined);
      this.layout.mode.set('page');
    });
  }

  /** A valid submit: put the search into the URL (the URL drives the results). */
  protected onSearch(params: SearchParams): void {
    const queryParams = searchQueryParams(params, this.currency.priceCurrency());
    const target = this.router.createUrlTree([], { relativeTo: this.route, queryParams });
    if (this.router.serializeUrl(target) === this.router.url) {
      this.rerun.update((n) => n + 1);
      return;
    }
    void this.router.navigateByUrl(target);
  }

  /** A listing chosen in the results: open it via the URL (new history entry). */
  protected open(listing: LocalizedListing): void {
    this.clicked.set(listing);
    this.openedHere = true;
    this.setListingParam(listing.id, false);
  }

  /**
   * Back to the results. If this page opened the detail, go back in history (so the browser's
   * forward button reopens it); otherwise (reload, shared link) replace the entry.
   */
  protected closeDetail(): void {
    if (this.openedHere) {
      this.location.back();
      return;
    }
    this.setListingParam(undefined, true);
  }

  private setListingParam(id: string | undefined, replaceUrl: boolean): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { [LISTING_QUERY_PARAM]: id ?? null },
      queryParamsHandling: 'merge',
      replaceUrl,
    });
  }
}
