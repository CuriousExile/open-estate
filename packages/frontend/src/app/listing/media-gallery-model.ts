// Framework-free logic of the image gallery (design: MediaGalleryComponent; Req 16.10, 16.12).
// Kept free of Angular imports so it can be unit-tested with plain Jest.
import type { LocalizedListing } from '@open-estate/shared';

export interface GalleryImage {
  /** Position in the stored order (0-based); also the identity for `track`. */
  readonly index: number;
  readonly url: string;
  /** 1-based position and total, for the alt text ("image 2 of 5"). */
  readonly position: number;
  readonly count: number;
  /** `true` → render the placeholder instead of the image (Req 16.12). */
  readonly failed: boolean;
}

const isHttps = (url: string): boolean => {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * All media of a listing as images in stored order (Req 16.10). Images that failed to load — and
 * URLs that are not https, which the CSP (`img-src https:`) would block anyway — become
 * placeholders in their own slot; all other images stay (Req 16.12).
 */
export function galleryImages(
  media: LocalizedListing['media'],
  failed: ReadonlySet<number>,
): GalleryImage[] {
  return media.map(({ url }, index) => ({
    index,
    url,
    position: index + 1,
    count: media.length,
    failed: failed.has(index) || !isHttps(url),
  }));
}

/** Failed set after the image at `index` raised `(error)`; unchanged if already failed. */
export function markFailed(failed: ReadonlySet<number>, index: number): ReadonlySet<number> {
  return failed.has(index) ? failed : new Set(failed).add(index);
}
