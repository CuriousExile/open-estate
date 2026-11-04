import { ChangeDetectionStrategy, Component, computed, input, linkedSignal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { LocalizedListing } from '@open-estate/shared';
import { galleryImages, markFailed } from './media-gallery-model';

/**
 * Images of a listing in stored order (design: MediaGalleryComponent; Req 16.10). An image that
 * cannot be loaded is replaced in its slot by a placeholder; the rest stays visible (Req 16.12).
 */
@Component({
  selector: 'oe-media-gallery',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul>
      @for (image of images(); track image.index) {
        <li>
          @if (image.failed) {
            <div
              class="placeholder"
              role="img"
              [attr.aria-label]="'detail.media.unavailable' | transloco: image"
            >
              <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
                <path
                  d="M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M3 3l18 18"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                />
              </svg>
            </div>
          } @else {
            <img
              [src]="image.url"
              [alt]="
                'detail.media.alt'
                  | transloco: { title: title(), position: image.position, count: image.count }
              "
              [attr.loading]="image.index === 0 ? null : 'lazy'"
              decoding="async"
              referrerpolicy="no-referrer"
              (error)="failed.set(markFailed(failed(), image.index))"
            />
          }
        </li>
      }
    </ul>
  `,
  styles: `
    ul {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
      gap: 0.75rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li:first-child {
      grid-column: 1 / -1;
    }
    img,
    .placeholder {
      display: block;
      width: 100%;
      aspect-ratio: 4 / 3;
      border-radius: var(--radius-card);
      object-fit: cover;
    }
    li:first-child :is(img, .placeholder) {
      aspect-ratio: 16 / 9;
    }
    .placeholder {
      display: grid;
      place-items: center;
      background: var(--color-surface);
      border: 1px dashed var(--color-surface-border);
      color: var(--color-text-muted);
    }
  `,
})
export class MediaGalleryComponent {
  readonly media = input.required<LocalizedListing['media']>();
  /** Listing title for the alt texts (media carry no own description). */
  readonly title = input.required<string>();

  /** Indexes of images that raised `(error)`; reset when another listing's media come in. */
  protected readonly failed = linkedSignal<LocalizedListing['media'], ReadonlySet<number>>({
    source: this.media,
    computation: () => new Set<number>(),
  });
  protected readonly images = computed(() => galleryImages(this.media(), this.failed()));
  protected readonly markFailed = markFailed;
}
