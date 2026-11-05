import {
  carouselSlides,
  imagesToLoad,
  isDisplayableImageUrl,
  isHorizontalDrag,
  markFailed,
  swipeStep,
  SWIPE_MIN_PX,
  withIndex,
  wrapIndex,
} from '../src/app/ui/image-carousel/image-carousel-model';

const ORIGIN = 'http://127.0.0.1:4200';

describe('carouselSlides and the placeholder fallback (Req 16.10, 16.12)', () => {
  const media = [
    { url: 'https://img.example.com/c.jpg' },
    { url: 'https://img.example.com/a.jpg' },
    { url: 'https://img.example.com/b.jpg' },
  ];

  it('keeps the stored order with position and count', () => {
    expect(carouselSlides(media, new Set(), ORIGIN)).toEqual([
      { index: 0, url: media[0]?.url, position: 1, count: 3, failed: false },
      { index: 1, url: media[1]?.url, position: 2, count: 3, failed: false },
      { index: 2, url: media[2]?.url, position: 3, count: 3, failed: false },
    ]);
  });

  it('has no slides without media (the carousel then shows one placeholder)', () => {
    expect(carouselSlides([], new Set(), ORIGIN)).toEqual([]);
  });

  it('replaces only images that failed to load by a placeholder in their slot', () => {
    const failed = markFailed(new Set(), 1);
    expect(carouselSlides(media, failed, ORIGIN).map((slide) => slide.failed)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('shows URLs the page cannot load as placeholder', () => {
    const slides = carouselSlides(
      [
        { url: 'http://img.example.com/a.jpg' },
        { url: 'x' },
        { url: 'javascript:alert(1)' },
        { url: `${ORIGIN}/demo-media/art/house-day-sand.svg` },
      ],
      new Set(),
      ORIGIN,
    );
    expect(slides.map((slide) => slide.failed)).toEqual([true, true, true, false]);
  });

  it('accepts https anywhere and plain http only on the page origin', () => {
    expect(isDisplayableImageUrl('https://cdn.agency.example/1.jpg', undefined)).toBe(true);
    expect(isDisplayableImageUrl(`${ORIGIN}/a.svg`, ORIGIN)).toBe(true);
    expect(isDisplayableImageUrl('http://127.0.0.1:4310/a.svg', ORIGIN)).toBe(false);
    expect(isDisplayableImageUrl(`${ORIGIN}/a.svg`, undefined)).toBe(false);
    expect(isDisplayableImageUrl('data:image/png;base64,AAAA', ORIGIN)).toBe(false);
  });

  it('withIndex/markFailed return a new set and keep a set that has the index', () => {
    const empty: ReadonlySet<number> = new Set();
    const once = markFailed(empty, 2);
    expect(empty.size).toBe(0);
    expect([...once]).toEqual([2]);
    expect(markFailed(once, 2)).toBe(once);
    expect(withIndex(once, 2)).toBe(once);
  });
});

describe('wrapIndex', () => {
  it('wraps past both ends', () => {
    expect(wrapIndex(5, 5)).toBe(0);
    expect(wrapIndex(-1, 5)).toBe(4);
    expect(wrapIndex(-6, 5)).toBe(4);
    expect(wrapIndex(12, 5)).toBe(2);
    expect(wrapIndex(3, 5)).toBe(3);
  });

  it('is 0 for an empty or single-image carousel', () => {
    expect(wrapIndex(1, 0)).toBe(0);
    expect(wrapIndex(-1, 1)).toBe(0);
  });
});

describe('imagesToLoad', () => {
  it('loads only the shown image without user intent', () => {
    expect([...imagesToLoad(new Set([0]), 2, 5)].sort()).toEqual([0, 2]);
  });

  it('adds the previous and next image (wrapped) on intent', () => {
    expect([...imagesToLoad(new Set([0]), 0, 5, true)].sort()).toEqual([0, 1, 4]);
    expect([...imagesToLoad(new Set([0]), 4, 5, true)].sort()).toEqual([0, 3, 4]);
  });

  it('keeps the same set when nothing new is needed, and handles tiny carousels', () => {
    const loaded = new Set([0, 1]);
    expect(imagesToLoad(loaded, 1, 2, true)).toBe(loaded);
    expect(imagesToLoad(new Set([0]), 0, 1, true)).toEqual(new Set([0]));
    const none: ReadonlySet<number> = new Set();
    expect(imagesToLoad(none, 0, 0, true)).toBe(none);
  });

  it('never loads more than shown image plus neighbours per step', () => {
    let loaded: ReadonlySet<number> = new Set([0]);
    for (let current = 1; current <= 3; current++) loaded = imagesToLoad(loaded, current, 20);
    expect([...loaded]).toEqual([0, 1, 2, 3]);
  });
});

describe('swipe detection', () => {
  it('steps to the next image for a swipe to the left and back for one to the right', () => {
    expect(swipeStep(-60, 5, 300)).toBe(1);
    expect(swipeStep(60, -5, 300)).toBe(-1);
  });

  it('ignores short moves below the threshold (≥ 40 px, 15 % of the width)', () => {
    expect(swipeStep(-(SWIPE_MIN_PX - 1), 0, 200)).toBe(0);
    expect(swipeStep(-100, 0, 1000)).toBe(0); // 15 % of 1000 = 150
    expect(swipeStep(-151, 0, 1000)).toBe(1);
  });

  it('ignores mostly vertical gestures (page scroll)', () => {
    expect(swipeStep(-80, 120, 300)).toBe(0);
    expect(isHorizontalDrag(6, 0)).toBe(false);
    expect(isHorizontalDrag(12, 20)).toBe(false);
    expect(isHorizontalDrag(-12, 4)).toBe(true);
  });
});
