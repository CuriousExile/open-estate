// Framework-free logic of the image carousel (oe-image-carousel; Req 16.10, 16.12): which slide is
// shown, which images are loaded, swipe detection and the placeholder fallback. Kept free of
// Angular imports so it can be unit-tested with plain Jest.

export interface CarouselSlide {
  /** Position in the stored order (0-based); also the identity for `track`. */
  readonly index: number;
  readonly url: string;
  /** 1-based position and total, for alt text and slide label ("2 of 5"). */
  readonly position: number;
  readonly count: number;
  /** `true` → the placeholder replaces the image in its slot (Req 16.12). */
  readonly failed: boolean;
}

/**
 * Whether the browser may show `url` as listing image: https (the CSP allows `img-src https:`)
 * or the page's own origin (`'self'`, e.g. images proxied by the local demo). Anything else —
 * plain http elsewhere, `javascript:`, relative junk — would be blocked or unsafe.
 */
export function isDisplayableImageUrl(url: string, pageOrigin: string | undefined): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' || (pageOrigin !== undefined && parsed.origin === pageOrigin)
    );
  } catch {
    return false;
  }
}

/**
 * Slides of a listing's media in stored order (Req 16.10). Images that failed to load and URLs
 * that cannot be shown become placeholders in their own slot; the rest stays (Req 16.12).
 */
export function carouselSlides(
  media: readonly { readonly url: string }[],
  failed: ReadonlySet<number>,
  pageOrigin: string | undefined,
): CarouselSlide[] {
  return media.map(({ url }, index) => ({
    index,
    url,
    position: index + 1,
    count: media.length,
    failed: failed.has(index) || !isDisplayableImageUrl(url, pageOrigin),
  }));
}

/** `index` wrapped into `0 … count-1` (previous of the first is the last, and vice versa). */
export function wrapIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}

/**
 * Images to render after showing `current`: the ones already loaded plus `current`. With
 * `neighbours` (pointer over / focus in the carousel, i.e. the user may navigate) the previous
 * and next image are added, so a step shows a loaded image; nothing else is fetched up front.
 */
export function imagesToLoad(
  loaded: ReadonlySet<number>,
  current: number,
  count: number,
  neighbours = false,
): ReadonlySet<number> {
  if (count === 0) return loaded;
  const wanted = neighbours
    ? [current, wrapIndex(current + 1, count), wrapIndex(current - 1, count)]
    : [current];
  if (wanted.every((index) => loaded.has(index))) return loaded;
  return new Set([...loaded, ...wanted]);
}

/** `set` plus `index`; the same set if it already contains it (signals then see no change). */
export function withIndex(set: ReadonlySet<number>, index: number): ReadonlySet<number> {
  return set.has(index) ? set : new Set(set).add(index);
}

/** Failed set after the image at `index` raised `(error)`; unchanged if already failed. */
export const markFailed = withIndex;

/** Minimum horizontal travel (px) of a swipe; shorter moves are taps or jitter. */
export const SWIPE_MIN_PX = 40;
/** Horizontal movement (px) after which a pointer gesture counts as a drag, not a click. */
export const DRAG_START_PX = 8;

/**
 * Step of a finished pointer gesture: `1` (next) for a swipe to the left, `-1` (previous) to the
 * right, `0` if it was too short or mostly vertical (a scroll). The threshold is 15 % of the
 * slide width, at least {@link SWIPE_MIN_PX}.
 */
export function swipeStep(dx: number, dy: number, width: number): -1 | 0 | 1 {
  const threshold = Math.max(SWIPE_MIN_PX, width * 0.15);
  if (Math.abs(dx) < threshold || Math.abs(dx) <= Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}

/** Whether a pointer move is a horizontal drag of the slides (and no longer a click). */
export function isHorizontalDrag(dx: number, dy: number): boolean {
  return Math.abs(dx) > DRAG_START_PX && Math.abs(dx) > Math.abs(dy);
}

/** Up to this many images the carousel shows one dot per image; above it only the counter. */
export const MAX_DOTS = 10;
