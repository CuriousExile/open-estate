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
import type { SearchParams } from './api/api-client';
import { ListingDetailComponent } from './listing/listing-detail.component';
import { LanguageSelectComponent } from './locale/language-select.component';
import { ResultListComponent } from './results/result-list.component';
import { SearchFormComponent } from './search/search-form.component';
import { StartupState } from './startup/startup-state';
import { ThemeService } from './theme/theme.service';

/** Root component: the app shell after a successful start, otherwise only the startup error page. */
@Component({
  selector: 'oe-root',
  imports: [
    LanguageSelectComponent,
    ListingDetailComponent,
    ResultListComponent,
    SearchFormComponent,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (errorMessage(); as error) {
      <main class="startup-error" role="alert">
        <h1>{{ error.title }}</h1>
        <p>{{ error.message }}</p>
      </main>
    } @else if (ready()) {
      <header class="site-header">
        <!-- Decorative: the brand name next to it carries the text. -->
        <img class="site-logo" [src]="logoUrl()" alt="" />
        <span class="site-name">{{ appTitle() }}</span>
        <oe-language-select class="site-language" />
      </header>
      <main class="shell">
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
      </main>
    }
  `,
})
export class App {
  private readonly injector = inject(Injector);
  private readonly resultList = viewChild(ResultListComponent);
  private readonly startup = inject(StartupState);
  private readonly theme = inject(ThemeService);

  protected readonly logoUrl = this.theme.logoUrl;
  protected readonly appTitle = this.theme.appTitle;

  protected readonly errorMessage = this.startup.errorMessage;
  protected readonly ready = computed(() => this.startup.context() !== undefined);

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
