import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DOCUMENT,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  carouselSlides,
  imagesToLoad,
  isHorizontalDrag,
  markFailed,
  MAX_DOTS,
  swipeStep,
  withIndex,
  wrapIndex,
} from './image-carousel-model';
import { ImagePlaceholderComponent } from './image-placeholder.component';

interface Gesture {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  dragging: boolean;
}

/**
 * Images of a listing, one at a time (WAI-ARIA APG carousel without autoplay; Req 16.10, 16.12).
 * Previous/next buttons (shown on hover/focus, always on touch screens), arrow keys while focus
 * is inside, swipe via pointer events, a counter and dots. Only the shown image is loaded; the
 * neighbours follow once the pointer or focus enters, so stepping shows a loaded image. Missing
 * media and images that fail to load show the themed placeholder in their slot.
 *
 * `activate` fires for a click (not a swipe) on the image — the result card opens the listing
 * with it; the buttons and dots never fire it. Styles: `.oe-carousel*` in styles.scss.
 */
@Component({
  selector: 'oe-image-carousel',
  imports: [ImagePlaceholderComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let count = slides().length;
    <div
      class="oe-carousel"
      role="region"
      [attr.aria-roledescription]="'media.carousel' | transloco"
      [attr.aria-label]="'media.carouselLabel' | transloco: { title: title() }"
      (keydown)="onKeydown($event)"
      (pointerenter)="prefetch()"
      (focusin)="prefetch()"
    >
      <div
        class="oe-carousel-viewport"
        [class.is-clickable]="clickable()"
        (pointerdown)="onPointerDown($event)"
        (pointermove)="onPointerMove($event)"
        (pointerup)="onPointerUp($event)"
        (pointercancel)="gesture = undefined; drag.set(0)"
        (click)="onClick()"
      >
        <div
          class="oe-carousel-track"
          [class.is-dragging]="drag() !== 0"
          [style.transform]="'translateX(calc(' + index() * -100 + '% + ' + drag() + 'px))'"
        >
          @for (slide of slides(); track slide.index) {
            <div
              class="oe-carousel-slide"
              role="group"
              [attr.aria-roledescription]="'media.slide' | transloco"
              [attr.aria-label]="'media.slideLabel' | transloco: slide"
              [inert]="slide.index !== index()"
            >
              @if (slide.failed) {
                <oe-image-placeholder [label]="'media.unavailable' | transloco: slide" />
              } @else if (loaded().has(slide.index)) {
                <img
                  [src]="slide.url"
                  [alt]="
                    'media.alt' | transloco: { title: title(), position: slide.position, count }
                  "
                  [attr.loading]="slide.index === 0 && !eager() ? 'lazy' : null"
                  [attr.fetchpriority]="slide.index === 0 && eager() ? 'high' : null"
                  decoding="async"
                  draggable="false"
                  referrerpolicy="no-referrer"
                  [class.is-ready]="ready().has(slide.index)"
                  (load)="ready.set(withIndex(ready(), slide.index))"
                  (error)="failed.set(markFailed(failed(), slide.index))"
                />
              }
            </div>
          } @empty {
            <div class="oe-carousel-slide">
              <oe-image-placeholder [label]="'media.none' | transloco" />
            </div>
          }
        </div>
      </div>

      @if (count > 1) {
        <button
          type="button"
          class="oe-carousel-nav oe-carousel-nav--prev"
          [attr.aria-label]="'media.previous' | transloco"
          (click)="step(-1)"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M15 5 8 12l7 7" />
          </svg>
        </button>
        <button
          type="button"
          class="oe-carousel-nav oe-carousel-nav--next"
          [attr.aria-label]="'media.next' | transloco"
          (click)="step(1)"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="m9 5 7 7-7 7" />
          </svg>
        </button>
        <p class="oe-carousel-counter" aria-hidden="true">{{ index() + 1 }} / {{ count }}</p>
        @if (count <= maxDots) {
          <!-- Pointer shortcut; keyboard and screen reader users have the buttons and keys. -->
          <div class="oe-carousel-dots" aria-hidden="true">
            @for (slide of slides(); track slide.index) {
              <button
                type="button"
                tabindex="-1"
                class="oe-carousel-dot"
                [class.is-active]="slide.index === index()"
                (click)="show(slide.index)"
              ></button>
            }
          </div>
        }
        <p class="visually-hidden" aria-live="polite" aria-atomic="true">
          @if (announce()) {
            {{ 'media.position' | transloco: { position: index() + 1, count } }}
          }
        </p>
      }
    </div>
  `,
})
export class ImageCarouselComponent {
  private readonly origin = inject(DOCUMENT).location?.origin;

  readonly media = input.required<readonly { readonly url: string }[]>();
  /** Listing title for the labels and alt texts (media carry no own description). */
  readonly title = input.required<string>();
  /** Load the first image right away (above the fold) instead of lazily. */
  readonly eager = input(false);
  /** Shows a pointer cursor; set when something listens to `activate`. */
  readonly clickable = input(false);
  /** Click (not a swipe) on the image. */
  readonly activate = output();

  protected readonly maxDots = MAX_DOTS;
  protected readonly withIndex = withIndex;
  protected readonly markFailed = markFailed;

  /** State per media list; a new listing starts over at its first image. */
  protected readonly index = linkedSignal({ source: this.media, computation: () => 0 });
  protected readonly failed = linkedSignal<unknown, ReadonlySet<number>>({
    source: this.media,
    computation: () => new Set<number>(),
  });
  protected readonly loaded = linkedSignal<unknown, ReadonlySet<number>>({
    source: this.media,
    computation: () => new Set([0]),
  });
  protected readonly ready = linkedSignal<unknown, ReadonlySet<number>>({
    source: this.media,
    computation: () => new Set<number>(),
  });
  /** The position is announced only after the user changed it (not on first render). */
  protected readonly announce = linkedSignal({ source: this.media, computation: () => false });
  /** Neighbours are loaded once the user shows intent (pointer or focus inside). */
  private readonly intent = linkedSignal({ source: this.media, computation: () => false });

  protected readonly slides = computed(() =>
    carouselSlides(this.media(), this.failed(), this.origin),
  );
  /** Horizontal offset (px) of a running drag. */
  protected readonly drag = signal(0);
  protected gesture: Gesture | undefined;
  private suppressClick = false;

  protected prefetch(): void {
    this.intent.set(true);
    this.loaded.set(imagesToLoad(this.loaded(), this.index(), this.slides().length, true));
  }

  protected show(index: number): void {
    const count = this.slides().length;
    const next = wrapIndex(index, count);
    this.index.set(next);
    this.loaded.set(imagesToLoad(this.loaded(), next, count, this.intent()));
    this.announce.set(true);
  }

  protected step(delta: -1 | 1): void {
    this.show(this.index() + delta);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (this.slides().length < 2) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      this.step(event.key === 'ArrowLeft' ? -1 : 1);
    }
  }

  protected onPointerDown(event: PointerEvent): void {
    this.suppressClick = false;
    if (this.slides().length < 2 || !event.isPrimary || event.button !== 0) return;
    this.gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
  }

  protected onPointerMove(event: PointerEvent): void {
    const gesture = this.gesture;
    if (gesture?.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    if (!gesture.dragging && isHorizontalDrag(dx, event.clientY - gesture.y)) {
      gesture.dragging = true;
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
      this.prefetch();
    }
    if (gesture.dragging) this.drag.set(dx);
  }

  protected onPointerUp(event: PointerEvent): void {
    const gesture = this.gesture;
    this.gesture = undefined;
    if (gesture?.id !== event.pointerId || !gesture.dragging) return;
    this.suppressClick = true;
    const width = (event.currentTarget as Element).clientWidth;
    const delta = swipeStep(event.clientX - gesture.x, event.clientY - gesture.y, width);
    this.drag.set(0);
    if (delta !== 0) this.step(delta);
  }

  protected onClick(): void {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    this.activate.emit();
  }
}
