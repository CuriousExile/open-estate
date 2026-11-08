import { LISTINGS, titlesFor } from '../../support/demo-listings';
import { expect, test } from '../../support/fixtures';

// Regression tests for two timing bugs the other browser tests hit at random. Each one makes the
// race deterministic, so it fails every time if the bug comes back.

test('results and the listing detail render although the browser never reports idle time', async ({
  page,
  search,
}) => {
  // Chromium runs requestIdleCallback only in idle periods, and on a busy machine it can skip
  // them for seconds (observed: > 5 s, until the next input event). Content the user asked for
  // must not wait for them; `@defer` without a trigger means `on idle`. Here the browser is
  // never idle at all.
  await page.addInitScript(() => {
    window.requestIdleCallback = () => 0;
    window.cancelIdleCallback = () => undefined;
  });
  await search.goto({ offerType: 'SALE' });
  await search.expectTitles(titlesFor('SALE'));

  await search.openListing(LISTINGS.berlinMitte.title);
  await search.backToResults.click();
  // Again, with the detail's code already loaded.
  await search.openListing(LISTINGS.luebeck.title);
});

test('image carousels tolerate events that arrive before their first render', async ({
  page,
  search,
}) => {
  // A carousel's DOM exists before Angular binds its inputs (creation pass, then update pass;
  // zoneless change detection runs in a later task). A pointer resting where a carousel appears
  // gets `pointerenter` in that gap; reading the required inputs then threw NG0950. A mutation
  // observer (a microtask, so before change detection) delivers such events to every carousel
  // the moment it is inserted; the fixture fails the test on any browser error.
  await page.addInitScript(() => {
    const poke = (carousel: Element) => {
      const at = { bubbles: true, isPrimary: true, pointerId: 1, clientX: 10, clientY: 10 };
      carousel.dispatchEvent(new PointerEvent('pointerenter', { ...at, bubbles: false }));
      carousel.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      carousel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      const viewport = carousel.querySelector('.oe-carousel-viewport') ?? carousel;
      viewport.dispatchEvent(new PointerEvent('pointerdown', { ...at, button: 0 }));
      viewport.dispatchEvent(new PointerEvent('pointermove', { ...at, clientX: 200 }));
      viewport.dispatchEvent(new PointerEvent('pointerup', { ...at, clientX: 200 }));
    };
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const found = node.matches('.oe-carousel')
            ? [node]
            : node.querySelectorAll('.oe-carousel');
          for (const carousel of found) poke(carousel);
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });

  await search.goto({ offerType: 'SALE' });
  await search.expectTitles(titlesFor('SALE'));
  const title = LISTINGS.berlinMitte.title;
  await search.openListing(title);
  // The carousel works normally afterwards.
  const carousel = search.detail.getByRole('region', { name: `Images of ${title}` });
  await expect(carousel.getByRole('img', { name: `${title} – image 1 of 4` })).toBeVisible();
  await carousel.getByRole('button', { name: 'Next image' }).click();
  await expect(carousel.getByRole('img', { name: `${title} – image 2 of 4` })).toBeInViewport();
});
