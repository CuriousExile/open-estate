import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { LocalizedListing } from '@open-estate/shared';
import { CodeLabelPipe } from '../locale/code-label.pipe';
import { CurrencyService } from '../currency/currency.service';
import { LocaleService } from '../locale/locale.service';
import { ImageCarouselComponent } from '../ui/image-carousel/image-carousel.component';
import { toListingDetail } from './listing-detail-model';
import { TourEmbedComponent } from './tour-embed.component';

/**
 * Full details of a listing chosen in the result list (design: ListingDetailComponent; Req 7.5,
 * 12.13): all public fields, every offer with all stored amounts, images via the shared image
 * carousel (placeholder if there are none), 3D tours of allowlisted hosts via TourEmbedComponent
 * (Req 16.6, 16.7). `close` (button or Escape) asks the parent to return to the result list.
 *
 * Layout: images and a summary (title, address, offers, key facts, links) side by side when the
 * view is at least 60rem wide (container query, so the portal preview behaves the same), stacked
 * below; description, tours and the remaining details follow in full width. The image height cap
 * (`.oe-detail-media`) lives in styles.scss, next to the carousel styles.
 */
@Component({
  selector: 'oe-listing-detail',
  imports: [CodeLabelPipe, ImageCarouselComponent, TourEmbedComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'close.emit()' },
  template: `
    @let d = detail();
    <article aria-labelledby="detail-heading">
      <button type="button" class="back" (click)="close.emit()">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" stroke-width="2" />
        </svg>
        {{ 'detail.back' | transloco }}
      </button>

      <div class="top">
        <!-- The carousel is a labelled region of its own. -->
        <oe-image-carousel
          class="media oe-detail-media"
          [media]="d.media"
          [title]="d.title"
          [eager]="true"
        />

        <div class="summary glass">
          <header>
            <p class="label tags">
              @for (offer of d.offers; track offer.offerType) {
                <span>{{ offer.offerType | codeLabel: 'offerType' | transloco }}</span>
              }
              <span>{{ d.listingType | codeLabel: 'taxonomy.type' | transloco }}</span>
            </p>
            <h2
              #heading
              id="detail-heading"
              class="display"
              tabindex="-1"
              [attr.lang]="d.contentLocale"
            >
              {{ d.title }}
            </h2>
            <p class="muted">{{ d.address }}</p>
          </header>

          <section aria-labelledby="detail-offers">
            <h3 id="detail-offers" class="visually-hidden">{{ 'detail.offers' | transloco }}</h3>
            @for (offer of d.offers; track offer.offerType) {
              <dl class="offer">
                @for (amount of offer.amounts; track amount.key) {
                  <div [class.is-main]="$first">
                    <dt class="label">{{ amount.key | transloco }}</dt>
                    <dd>
                      {{ amount.value }}
                      @if (amount.original; as original) {
                        <span
                          class="oe-price-original"
                          [title]="'currency.convertedHint' | transloco: convertedHint()"
                          >{{ 'currency.originalAmount' | transloco: { amount: original } }}</span
                        >
                      }
                    </dd>
                  </div>
                }
              </dl>
            }
          </section>

          <section aria-labelledby="detail-facts">
            <h3 id="detail-facts" class="visually-hidden">{{ 'detail.facts' | transloco }}</h3>
            <dl class="facts">
              @for (row of d.facts; track row.key) {
                <div>
                  <dt class="label">{{ row.key | transloco }}</dt>
                  <dd>{{ row.textKey ? (row.textKey | transloco: row.params) : row.text }}</dd>
                </div>
              }
            </dl>
          </section>

          @if (d.actions.length > 0) {
            <p class="actions">
              @for (action of d.actions; track action.key) {
                <a
                  [class.is-primary]="$first"
                  [href]="action.href"
                  [attr.target]="action.external ? '_blank' : null"
                  [attr.rel]="action.external ? 'noopener noreferrer' : null"
                >
                  {{ action.key | transloco }}
                  @if (action.external) {
                    <span class="visually-hidden">{{ 'detail.newTab' | transloco }}</span>
                  }
                </a>
              }
            </p>
          }
        </div>
      </div>

      @if (d.description) {
        <section class="glass panel" aria-labelledby="detail-description">
          <h3 id="detail-description" class="label">{{ 'detail.description' | transloco }}</h3>
          <p class="description" [attr.lang]="d.contentLocale">{{ d.description }}</p>
        </section>
      }

      @if (d.tours.length > 0) {
        <oe-tour-embed [listingId]="d.listing.id" [tours]="d.tours" [title]="d.title" />
      }

      @if (d.sections.length > 0) {
        <div class="sections">
          @for (section of d.sections; track section.id) {
            <section class="glass panel" [attr.aria-labelledby]="section.id">
              <h3 class="label" [id]="section.id">{{ section.key | transloco }}</h3>
              <dl>
                @for (row of section.rows; track row.key) {
                  <dt class="label">{{ row.key | transloco }}</dt>
                  <dd>
                    @let text = row.textKey ? (row.textKey | transloco: row.params) : row.text;
                    @if (row.href) {
                      <a
                        [href]="row.href"
                        [attr.target]="row.external ? '_blank' : null"
                        [attr.rel]="row.external ? 'noopener noreferrer' : null"
                      >
                        {{ text }}
                        @if (row.external) {
                          <span class="visually-hidden">{{ 'detail.newTab' | transloco }}</span>
                        }
                      </a>
                    } @else {
                      {{ text }}
                    }
                  </dd>
                }
              </dl>
            </section>
          }
        </div>
      }
    </article>
  `,
  styles: `
    :host {
      display: block;
      container-type: inline-size;
    }
    article,
    .top,
    .sections {
      display: grid;
      gap: 1rem;
      align-items: start;
    }
    .top > * {
      min-width: 0;
    }
    @container (min-width: 60rem) {
      .top {
        grid-template-columns: minmax(0, 3fr) minmax(20rem, 2fr);
      }
    }
    .sections {
      grid-template-columns: repeat(auto-fit, minmax(min(18rem, 100%), 1fr));
    }
    h2,
    h3,
    p,
    dl,
    dd {
      margin: 0;
    }
    h2 {
      font-size: clamp(1.6rem, 2.4vw, 2.25rem);
      line-height: 1.15;
      overflow-wrap: anywhere;
    }
    h2:focus {
      outline: none;
    }
    header,
    section,
    .summary,
    .offer div,
    .facts div {
      display: grid;
      gap: 0.75rem;
    }
    header {
      gap: 0.5rem;
    }
    .media {
      overflow: hidden;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-card);
    }
    .summary {
      align-content: start;
      gap: 1.25rem;
      padding: 1.5rem;
    }
    .panel {
      padding: 1.25rem 1.5rem;
    }
    .back,
    .actions a {
      padding: 0.4rem 1.1rem;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-pill);
      font: inherit;
      color: inherit;
    }
    .back {
      justify-self: start;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      background: transparent;
      cursor: pointer;
    }
    .tags,
    .offer,
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 1rem;
    }
    .offer {
      align-items: baseline;
      gap: 0.5rem 1.5rem;
    }
    .offer div,
    .facts div {
      gap: 0.2rem;
    }
    .offer dd,
    .facts dd {
      font-size: 1.0625rem;
    }
    .offer .is-main dd {
      font-size: 1.75rem;
      line-height: 1.15;
      color: var(--color-accent);
    }
    .offer + .offer {
      padding-top: 1rem;
      border-top: 1px solid var(--color-surface-border);
    }
    .facts {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.5rem;
    }
    .facts div {
      padding: 0.65rem 0.85rem;
      border: 1px solid var(--color-surface-border);
      border-radius: 0.85rem;
    }
    .actions {
      gap: 0.5rem;
    }
    .actions a {
      padding: 0.5rem 1.15rem;
      text-decoration: none;
    }
    .actions a:hover {
      border-color: var(--color-accent);
    }
    .actions .is-primary {
      border-color: var(--color-accent);
      background: var(--color-accent);
      color: var(--color-on-accent);
      font-weight: 600;
    }
    .muted {
      color: var(--color-text-muted);
    }
    .panel dl {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: 0.5rem 1.5rem;
      align-items: baseline;
      overflow-wrap: anywhere;
    }
    .description {
      max-width: 48rem;
      white-space: pre-line;
    }
    .panel a {
      color: var(--color-accent);
    }
  `,
})
export class ListingDetailComponent {
  private readonly locale = inject(LocaleService);
  private readonly currency = inject(CurrencyService);
  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');

  readonly listing = input.required<LocalizedListing>();
  /** Back to the result list; the parent restores focus there. */
  readonly close = output();

  /** Formatted for the active locale and display currency; follows a switch of either. */
  protected readonly detail = computed(() =>
    toListingDetail(this.listing(), this.locale.active(), { display: this.currency.display() }),
  );
  /** Tooltip of converted amounts: approximate, with the date of the static rates. */
  protected readonly convertedHint = computed(() => ({ date: this.currency.ratesDate() }));

  constructor() {
    // Move focus to the title whenever a listing is shown, so screen readers announce it.
    afterRenderEffect(() => {
      this.listing();
      this.heading().nativeElement.focus();
    });
  }
}
