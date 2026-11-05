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
import { LocaleService } from '../locale/locale.service';
import { ImageCarouselComponent } from '../ui/image-carousel/image-carousel.component';
import { toListingDetail } from './listing-detail-model';
import { TourEmbedComponent } from './tour-embed.component';

/**
 * Full details of a listing chosen in the result list (design: ListingDetailComponent; Req 7.5,
 * 12.13): all public fields, every offer with all stored amounts, images via the shared image
 * carousel (placeholder if there are none), 3D tours of allowlisted hosts via TourEmbedComponent
 * (Req 16.6, 16.7). `close` (button or Escape) asks the parent to return to the result list.
 */
@Component({
  selector: 'oe-listing-detail',
  imports: [CodeLabelPipe, ImageCarouselComponent, TourEmbedComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'close.emit()' },
  template: `
    @let d = detail();
    <article aria-labelledby="detail-heading">
      <button type="button" class="pill back" (click)="close.emit()">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" stroke-width="2" />
        </svg>
        {{ 'detail.back' | transloco }}
      </button>

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
        <p class="muted">{{ d.postalCode }} {{ d.city }}</p>
      </header>

      <section aria-labelledby="detail-media">
        <h3 id="detail-media" class="visually-hidden">{{ 'detail.media.heading' | transloco }}</h3>
        <oe-image-carousel
          class="media"
          [media]="d.media"
          [title]="d.title"
          [wide]="true"
          [eager]="true"
        />
      </section>

      <section class="glass" aria-labelledby="detail-offers">
        <h3 id="detail-offers" class="label">{{ 'detail.offers' | transloco }}</h3>
        @for (offer of d.offers; track offer.offerType) {
          <dl class="offer">
            <dt class="label">{{ 'detail.offerType' | transloco }}</dt>
            <dd>{{ offer.offerType | codeLabel: 'offerType' | transloco }}</dd>
            @for (amount of offer.amounts; track amount.key) {
              <dt class="label">{{ amount.key | transloco }}</dt>
              <dd class="price">{{ amount.value }}</dd>
            }
          </dl>
        }
      </section>

      @if (d.description) {
        <section aria-labelledby="detail-description">
          <h3 id="detail-description" class="label">{{ 'detail.description' | transloco }}</h3>
          <p class="description" [attr.lang]="d.contentLocale">{{ d.description }}</p>
        </section>
      }

      @if (d.tours.length > 0) {
        <oe-tour-embed [listingId]="d.listing.id" [tours]="d.tours" [title]="d.title" />
      }

      @for (section of d.sections; track section.id) {
        <section class="glass" [attr.aria-labelledby]="section.id">
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
    </article>
  `,
  styles: `
    :host {
      display: block;
    }
    article {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
      gap: 1rem;
      align-items: start;
    }
    article > :not(.glass) {
      grid-column: 1 / -1;
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
    header,
    section {
      display: grid;
      gap: 0.75rem;
    }
    .glass {
      padding: 1.25rem 1.5rem;
    }
    .back {
      justify-self: start;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.4rem 1.1rem;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-pill);
      background: transparent;
      font: inherit;
      color: inherit;
      cursor: pointer;
    }
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 1rem;
    }
    .media {
      max-width: 50rem;
      border-radius: var(--radius-card);
      border: 1px solid var(--color-surface-border);
      overflow: hidden;
    }
    .muted {
      color: var(--color-text-muted);
    }
    dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 0.5rem 1.5rem;
      align-items: baseline;
    }
    .offer + .offer {
      padding-top: 0.75rem;
      border-top: 1px solid var(--color-surface-border);
    }
    .price {
      font-size: 1.25rem;
      color: var(--brand-secondary);
    }
    .description {
      max-width: 48rem;
      white-space: pre-line;
    }
    a {
      color: var(--brand-secondary);
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
export class ListingDetailComponent {
  private readonly locale = inject(LocaleService);
  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');

  readonly listing = input.required<LocalizedListing>();
  /** Back to the result list; the parent restores focus there. */
  readonly close = output();

  /** Formatted for the active locale; follows a language switch. */
  protected readonly detail = computed(() => toListingDetail(this.listing(), this.locale.active()));

  constructor() {
    // Move focus to the title whenever a listing is shown, so screen readers announce it.
    afterRenderEffect(() => {
      this.listing();
      this.heading().nativeElement.focus();
    });
  }
}
