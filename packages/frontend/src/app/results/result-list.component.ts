import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { ListingPage, type ListingStatus, type LocalizedListing } from '@open-estate/shared';
import type { SearchParams } from '../api/api-client';
import { ApiClientService } from '../api/api-client.service';
import { PortalPresence } from '../auth/portal-presence.service';
import { CurrencyService } from '../currency/currency.service';
import { manageRights, worthAsking } from '../listing/listing-manage-model';
import { ManagementApiClient } from '../management/management-api-client.service';
import {
  nextStatus,
  setListingStatus,
  statusChangedKey,
  toggleLabelKey,
  toggleNamedKey,
} from '../portal/shared/listing-status';
import { CodeLabelPipe } from '../locale/code-label.pipe';
import { LocaleService } from '../locale/locale.service';
import { ImageCarouselComponent } from '../ui/image-carousel/image-carousel.component';
import {
  createResultLoader,
  currentPage,
  hasNextPage,
  INITIAL_RESULT_STATE,
  isEmptyResult,
  resultErrorMessage,
  toResultRow,
} from './result-list-model';

/**
 * Search results (design: ResultListComponent; Req 7.3, 7.4, 7.6, 7.7). Every new `params` value
 * starts a search with pages of 20 listings. Errors are shown here only, so the search form keeps
 * all entered values (Req 7.7). Choosing a listing emits `select`; the detail view is separate.
 */
@Component({
  selector: 'oe-result-list',
  imports: [CodeLabelPipe, ImageCarouselComponent, RouterLink, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (state().searched) {
      <section [attr.aria-busy]="state().loading" aria-labelledby="results-heading">
        <h2 #heading id="results-heading" class="label" tabindex="-1">
          {{ 'results.heading' | transloco }}
        </h2>
        <p class="manage-notice" role="status">
          @if (manageNotice(); as n) {
            {{ n.key | transloco: n.params }}
          }
        </p>
        @if (manageError(); as message) {
          <p class="manage-error" role="alert">{{ message }}</p>
        }

        @if (errorMessage(); as error) {
          <div class="notice glass" role="alert">
            <p>{{ error.key | transloco: error.params }}</p>
            <button type="button" class="pill" (click)="loader.retry()">
              {{ 'results.retry' | transloco }}
            </button>
          </div>
        } @else if (state().loading && rows().length === 0) {
          <p class="notice glass" role="status">{{ 'results.loading' | transloco }}</p>
        } @else if (empty()) {
          <p class="notice glass" role="status">{{ 'results.empty' | transloco }}</p>
        }

        @if (rows().length > 0) {
          <ol class="grid">
            @for (row of rows(); track row.id) {
              @let m = managed().get(row.id);
              <li class="card glass" [class.inactive]="m?.status === 'INACTIVE'">
                <oe-image-carousel
                  class="media"
                  [media]="row.listing.media"
                  [title]="row.title"
                  [clickable]="true"
                  (activate)="select.emit(row.listing)"
                />
                <p class="label tags">
                  @if (row.offerType; as offerType) {
                    <span>{{ offerType | codeLabel: 'offerType' | transloco }}</span>
                  }
                  <span>{{ row.listingType | codeLabel: 'taxonomy.type' | transloco }}</span>
                </p>
                <h3 [attr.lang]="row.titleLocale">
                  <button
                    #listingButton
                    type="button"
                    [attr.data-listing-id]="row.id"
                    (click)="select.emit(row.listing)"
                  >
                    {{ row.title }}
                  </button>
                </h3>
                <p class="muted">{{ row.city }}</p>
                @if (row.price; as price) {
                  <p class="price">
                    <span class="label">{{ 'results.price.' + row.offerType | transloco }}</span>
                    {{ price }}
                    @if (row.priceOriginal; as original) {
                      <span
                        class="oe-price-original"
                        [title]="'currency.convertedHint' | transloco: convertedHint()"
                        >{{ 'currency.originalAmount' | transloco: { amount: original } }}</span
                      >
                    }
                  </p>
                }
                <dl>
                  <div>
                    <dt class="label">{{ 'results.rooms' | transloco }}</dt>
                    <dd>{{ row.rooms }}</dd>
                  </div>
                  <div>
                    <dt class="label">{{ 'results.area' | transloco }}</dt>
                    <dd>{{ 'results.areaValue' | transloco: { value: row.area } }}</dd>
                  </div>
                </dl>
                @if (m) {
                  <!-- Signed-in agency users and admins: manage right from the card. -->
                  <div class="manage">
                    @if (m.status === 'INACTIVE') {
                      <p class="label">{{ 'listingManage.state.INACTIVE' | transloco }}</p>
                    }
                    @if (rights().status) {
                      <button
                        type="button"
                        class="pill"
                        [disabled]="manageBusy() === row.id"
                        [attr.aria-label]="
                          toggleNamedKey(m.status) | transloco: { title: row.title }
                        "
                        (click)="toggleStatus(m, row.title)"
                      >
                        {{ toggleLabelKey(m.status) | transloco }}
                      </button>
                    }
                    @if (rights().edit) {
                      <a
                        class="pill"
                        [routerLink]="['/portal/listings', row.id, 'edit']"
                        [attr.aria-label]="
                          'portal.listings.editNamed' | transloco: { title: row.title }
                        "
                        >{{ 'portal.listings.editAction' | transloco }}</a
                      >
                    }
                  </div>
                }
                <svg class="arrow" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                  <path d="M7 17 17 7M9 7h8v8" fill="none" stroke="currentColor" stroke-width="2" />
                </svg>
              </li>
            }
          </ol>
        }

        @if (state().pageIndex > 0 || hasNext()) {
          <nav class="pager" [attr.aria-label]="'results.pagination' | transloco">
            <button
              type="button"
              class="pill"
              [disabled]="state().pageIndex === 0 || state().loading"
              (click)="go('previous')"
            >
              {{ 'results.previous' | transloco }}
            </button>
            <span>{{ 'results.page' | transloco: { page: state().pageIndex + 1 } }}</span>
            <button
              type="button"
              class="pill"
              [disabled]="!hasNext() || state().loading"
              (click)="go('next')"
            >
              {{ 'results.next' | transloco }}
            </button>
          </nav>
        }
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    section,
    .notice,
    .card {
      display: grid;
      gap: 1rem;
    }
    h2,
    h3,
    p,
    dl,
    dd {
      margin: 0;
    }
    h2:focus {
      outline: none;
    }
    button {
      font: inherit;
      color: inherit;
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.45;
      cursor: default;
    }
    .notice {
      justify-items: start;
      padding: 1.25rem 1.5rem;
    }
    [role='alert'] p {
      color: var(--color-error);
    }
    .pill {
      padding: 0.4rem 1.1rem;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-pill);
      background: transparent;
    }
    .grid {
      display: grid;
      /* min(): a single column on phones never exceeds the screen. */
      grid-template-columns: repeat(auto-fill, minmax(min(17rem, 100%), 1fr));
      gap: 1rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    /* overflow clips the image to the rounded top; minmax(0, 1fr) and min-width keep the
       carousel from widening the card or the grid column. */
    .card {
      position: relative;
      grid-template-columns: minmax(0, 1fr);
      align-content: start;
      gap: 0.5rem;
      min-width: 0;
      padding: 0 1.5rem 1.5rem;
      overflow: hidden;
    }
    /* Image flush with the card's top and sides (inside the border). */
    .media {
      margin: 0 -1.5rem 0.5rem;
    }
    .card:hover,
    .card:focus-within {
      border-color: var(--color-accent);
    }
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 1rem;
    }
    h3 {
      font-family: var(--font-display);
      font-weight: 500;
      font-size: 1.375rem;
      line-height: 1.2;
    }
    h3 button {
      padding: 0;
      border: 0;
      background: none;
      text-align: start;
    }
    /* The whole card selects the listing. */
    h3 button::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: var(--radius-card);
    }
    .muted {
      color: var(--color-text-muted);
    }
    .price {
      display: grid;
      font-size: 1.25rem;
      color: var(--color-accent);
    }
    dl {
      display: flex;
      gap: 1.5rem;
    }
    .arrow {
      position: absolute;
      right: 1.25rem;
      bottom: 1.25rem;
      padding: 0.5rem;
      box-sizing: content-box;
      border-radius: 50%;
      background: var(--color-accent);
      color: var(--color-on-accent);
    }
    /* Above the card-wide link of the title button. */
    .manage {
      position: relative;
      z-index: 1;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      margin-right: 3rem;
    }
    .manage a {
      color: inherit;
      text-decoration: none;
    }
    .card.inactive {
      opacity: 0.7;
    }
    .manage-notice:empty {
      display: none;
    }
    .manage-error {
      color: var(--color-error);
    }
    .pager {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 1rem;
    }
  `,
})
export class ResultListComponent {
  private readonly api = inject(ApiClientService);
  private readonly locale = inject(LocaleService);
  private readonly currency = inject(CurrencyService);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly listingButtons = viewChildren<ElementRef<HTMLElement>>('listingButton');

  /** Validated parameters from the search form; each new value starts a new search (Req 7.3). */
  readonly params = input<SearchParams | undefined>();
  /** Listing chosen for the detail view (Req 7.5, implemented by ListingDetailComponent). */
  readonly select = output<LocalizedListing>();

  protected readonly state = signal(INITIAL_RESULT_STATE);
  protected readonly loader = createResultLoader(
    (params, options) => this.api.searchListings(params, options),
    (state) => this.state.set(state),
  );

  /** Rows are formatted for the active locale and display currency and follow a switch. */
  protected readonly rows = computed(() => {
    const { offerType } = this.state();
    const locale = this.locale.active();
    const display = this.currency.display();
    return (currentPage(this.state())?.items ?? []).map((listing) =>
      toResultRow(listing, offerType, locale, display),
    );
  });
  /** Tooltip of converted prices: approximate, with the date of the static rates. */
  protected readonly convertedHint = computed(() => ({ date: this.currency.ratesDate() }));

  private readonly presence = inject(PortalPresence);
  private readonly management = inject(ManagementApiClient);
  /**
   * Listings shown here that the user signed in to the portal in this tab may manage (own
   * agency; Plattform_Admins: all), by id — from one `GET /listings?ids=` per result page.
   */
  protected readonly managed = signal<ReadonlyMap<string, ManagedState>>(new Map());
  protected readonly rights = computed(() => manageRights(this.presence.me()));
  /** Id of the listing whose status is being changed. */
  protected readonly manageBusy = signal<string | undefined>(undefined);
  protected readonly manageNotice = signal<
    { key: string; params: Readonly<Record<string, string>> } | undefined
  >(undefined);
  protected readonly manageError = signal<string | undefined>(undefined);
  protected readonly toggleLabelKey = toggleLabelKey;
  protected readonly toggleNamedKey = toggleNamedKey;
  /** The shown page; changes only when another page is shown (pages are cached). */
  private readonly page = computed(() => currentPage(this.state()));
  protected readonly empty = computed(() => isEmptyResult(this.state()));
  protected readonly hasNext = computed(() => hasNextPage(this.state()));
  protected readonly errorMessage = computed(() => {
    const { error } = this.state();
    return error && resultErrorMessage(error);
  });

  constructor() {
    effect(() => {
      const params = this.params();
      if (params === undefined) return;
      untracked(() => {
        this.managed.set(new Map());
        this.manageNotice.set(undefined);
        this.manageError.set(undefined);
        this.loader.search(params);
      });
    });
    effect((onCleanup) => {
      const items = this.page()?.items;
      if (items === undefined || items.length === 0) return;
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      untracked(() => void this.loadManaged(items, controller.signal));
    });
    inject(DestroyRef).onDestroy(() => this.loader.cancel());
  }

  /** Focuses the entry of listing `id`, e.g. when returning from its detail view (Req 7.5). */
  focusListing(id: string): void {
    const button = this.listingButtons().find(
      (ref) => ref.nativeElement.dataset['listingId'] === id,
    );
    (button ?? this.heading())?.nativeElement.focus();
  }

  /**
   * A listing was (de)activated elsewhere (its detail view): its card follows. It stays in the
   * list until the next search, so the change can be undone here.
   */
  markManaged(listing: ManagedState): void {
    this.managed.update((map) => new Map(map).set(listing.id, pickState(listing)));
  }

  /** Deactivates or activates the listing of a card (Req 6.2). */
  protected async toggleStatus(current: ManagedState, title: string): Promise<void> {
    if (this.manageBusy() !== undefined) return;
    this.manageBusy.set(current.id);
    this.manageError.set(undefined);
    const result = await setListingStatus(
      this.management,
      current.id,
      nextStatus(current.status),
      current.version,
    );
    this.manageBusy.set(undefined);
    if (!result.ok) {
      this.manageError.set(this.management.errorMessage(result.error));
      return;
    }
    this.markManaged(result.value);
    this.manageNotice.set({ key: statusChangedKey(result.value.status), params: { title } });
  }

  /** One lookup per page, only for signed-in users with manage rights (none for visitors). */
  private async loadManaged(
    items: readonly LocalizedListing[],
    signal: AbortSignal,
  ): Promise<void> {
    if (!(await this.presence.signedIn()) || signal.aborted) return;
    const me = this.presence.me();
    const ids = items.filter((listing) => worthAsking(me, listing)).map((l) => l.id);
    if (ids.length === 0) return;
    const result = await this.management.get('/listings', {
      signal,
      query: { ids: ids.join(',') },
      parse: (value) => ListingPage.parse(value),
    });
    if (signal.aborted || !result.ok) return;
    this.managed.update((map) => {
      const next = new Map(map);
      for (const summary of result.value.items) next.set(summary.id, pickState(summary));
      return next;
    });
  }

  /** Changes the page and moves focus to the list start, so keyboard users continue there. */
  protected go(direction: 'previous' | 'next'): void {
    this.loader[direction]();
    this.heading()?.nativeElement.focus();
  }
}

/** What a card needs to manage a listing. */
export interface ManagedState {
  readonly id: string;
  readonly status: ListingStatus;
  readonly version: number;
}

const pickState = ({ id, status, version }: ManagedState): ManagedState => ({
  id,
  status,
  version,
});
