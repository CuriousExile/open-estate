import { LISTINGS, titlesFor } from '../../support/demo-listings';
import { expect, test } from '../../support/fixtures';
import type { SearchPage } from '../../support/search-page';

// Result cards, the listing detail opened from them (in the URL as `&listing=<id>`), the public
// detail route `/listings/<id>`, the image carousel and the pager.

const MITTE = LISTINGS.berlinMitte;

async function searchSale(search: SearchPage): Promise<void> {
  await search.goto({ offerType: 'SALE' });
  await search.expectTitles(titlesFor('SALE'));
}

test.describe('listing detail from the results', () => {
  test('opens with offers, key facts and location, and puts the listing into the URL @mobile', async ({
    search,
    searchApi,
  }) => {
    await searchSale(search);
    await search.openListing(MITTE.title);

    await expect
      .poll(() => search.query().get('listing'))
      .toBe(await searchApi.listingId(MITTE.title));
    await expect.poll(() => search.query().get('offerType')).toBe('SALE');
    // Focus moves to the title so screen readers announce the listing.
    await expect(search.detailHeading).toBeFocused();
    await expect(search.results).toBeHidden();

    const detail = search.detail;
    await expect(detail.getByRole('region', { name: 'Offers' })).toContainText('Purchase price');
    await expect(detail.getByRole('region', { name: 'Offers' })).toContainText('€469,000');
    const facts = detail.getByRole('region', { name: 'Key facts' });
    await expect(facts).toContainText('Rooms');
    await expect(facts).toContainText('3');
    await expect(facts).toContainText('82.5 m²');
    const location = detail.getByRole('region', { name: 'Location' });
    await expect(location).toContainText(MITTE.postalCode);
    await expect(location).toContainText('Berlin');
    await expect(location).toContainText('Germany');
    // Technical rows stay hidden on the public page.
    await expect(detail).not.toContainText('Listing ID');
    await expect(detail).not.toContainText('Import run');
  });

  test('"Back to results" closes it and focuses the listing in the results @mobile', async ({
    search,
  }) => {
    await searchSale(search);
    await search.openListing(MITTE.title);
    await search.backToResults.click();

    await expect(search.detail).toHaveCount(0);
    await expect(search.results).toBeVisible();
    await expect.poll(() => search.query().has('listing')).toBe(false);
    await expect(search.results.getByRole('button', { name: MITTE.title })).toBeFocused();
    // Loaded results survive the detail view: still the full list.
    await search.expectTitles(titlesFor('SALE'));
  });

  test('Escape closes it', async ({ page, search }) => {
    await searchSale(search);
    await search.openListing(MITTE.title);
    await page.keyboard.press('Escape');
    await expect(search.detail).toHaveCount(0);
    await expect(search.results).toBeVisible();
  });

  test('browser back closes it, forward opens it again', async ({ page, search }) => {
    await searchSale(search);
    await search.openListing(MITTE.title);
    await page.goBack();
    await expect(search.detail).toHaveCount(0);
    await expect(search.results).toBeVisible();
    await page.goForward();
    await expect(search.detailHeading).toHaveText(MITTE.title);
  });

  test('a reload keeps the opened listing (loaded from the Search API)', async ({
    page,
    search,
    searchApi,
  }) => {
    await searchSale(search);
    await search.openListing(MITTE.title);
    const id = await searchApi.listingId(MITTE.title);

    const detailRequest = page.waitForResponse(
      (r) => new URL(r.url()).pathname === `/api/listings/${id}`,
    );
    await page.reload();
    expect((await detailRequest).status()).toBe(200);
    await expect(search.detailHeading).toHaveText(MITTE.title);
    // Closing a detail that was not opened here replaces the history entry.
    await search.backToResults.click();
    await expect(search.results).toBeVisible();
    await expect.poll(() => search.query().has('listing')).toBe(false);
  });

  test('an unknown listing in the URL is dropped and the results show', async ({
    consoleGuard,
    search,
  }) => {
    consoleGuard.allow(/404 .*\/api\/listings\/does-not-exist/);
    await search.goto({ offerType: 'SALE', listing: 'does-not-exist' });
    await search.expectTitles(titlesFor('SALE'));
    await expect.poll(() => search.query().has('listing')).toBe(false);
    await expect(search.detail).toHaveCount(0);
  });

  test('a listing for sale and for rent shows both offers', async ({ search }) => {
    await searchSale(search);
    await search.openListing(LISTINGS.hamburgHafencity.title);
    const offers = search.detail.getByRole('region', { name: 'Offers' });
    await expect(offers).toContainText('Purchase price');
    await expect(offers).toContainText('€615,000');
    await expect(offers).toContainText('Cold rent per month');
    await expect(offers).toContainText('€1,950');
  });

  test('"View original listing" opens the source in a new tab', async ({ search, searchApi }) => {
    await searchSale(search);
    // Imported from the CRM: the source is the agency's exposé.
    await search.openListing(LISTINGS.rostock.title);
    const crmLink = search.detail.getByRole('link', { name: /View original listing/ });
    await expect(crmLink).toHaveAttribute('href', 'https://crm.example.org/nordlicht/expose/4713');
    await expect(crmLink).toHaveAttribute('target', '_blank');
    await expect(crmLink).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(crmLink).toHaveAccessibleName(/opens in a new tab/);

    // Created in the portal: the source is its own public detail page on this SPA origin.
    await search.backToResults.click();
    await search.openListing(LISTINGS.luebeck.title);
    const id = await searchApi.listingId(LISTINGS.luebeck.title);
    const origin = new URL(search.page.url()).origin;
    await expect(
      search.detail.getByRole('link', { name: /View original listing/ }),
    ).toHaveAttribute('href', `${origin}/listings/${id}`);
  });
});

test.describe('public detail page /listings/:id', () => {
  test('shows the listing and leads back to the search', async ({ page, search, searchApi }) => {
    const id = await searchApi.listingId(LISTINGS.kiel.title);
    await page.goto(`/listings/${id}`);
    await expect(search.detailHeading).toHaveText(LISTINGS.kiel.title);
    await expect(search.detail.getByRole('region', { name: 'Offers' })).toContainText(
      'Cold rent per month',
    );

    await search.backToResults.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(search.form).toBeVisible();
  });

  test('an unknown id shows "Listing not found" with a way back', async ({
    consoleGuard,
    page,
    search,
  }) => {
    consoleGuard.allow(/404 .*\/api\/listings\/does-not-exist/);
    await page.goto('/listings/does-not-exist');
    const notFound = page.getByRole('alert');
    await expect(notFound.getByRole('heading', { name: 'Listing not found' })).toBeVisible();
    await expect(notFound).toContainText('This listing does not exist or is no longer public.');
    await notFound.getByRole('link', { name: 'Go to search' }).click();
    await expect(search.form).toBeVisible();
  });
});

test.describe('images', () => {
  test('a listing without images shows the placeholder', async ({ search }) => {
    await searchSale(search);
    const card = search.card(LISTINGS.rostock.title);
    await expect(card.getByRole('img', { name: 'No image available' })).toBeVisible();
  });

  test('the carousel steps with the buttons and the arrow keys', async ({ search }) => {
    await searchSale(search);
    const carousel = search
      .card(MITTE.title)
      .getByRole('region', { name: `Images of ${MITTE.title}` });
    const image = (n: number) =>
      carousel.getByRole('img', { name: `${MITTE.title} – image ${n} of ${MITTE.media}` });
    await carousel.scrollIntoViewIfNeeded();
    await expect(image(1)).toBeInViewport();

    await carousel.hover();
    await carousel.getByRole('button', { name: 'Next image' }).click();
    await expect(image(2)).toBeInViewport();
    await expect(image(1)).not.toBeInViewport();
    await expect(carousel).toContainText(`Image 2 of ${MITTE.media}`);

    await carousel.getByRole('button', { name: 'Previous image' }).focus();
    await search.page.keyboard.press('ArrowLeft');
    await expect(image(1)).toBeInViewport();
    // Wraps around: left of the first image is the last one.
    await search.page.keyboard.press('ArrowLeft');
    await expect(image(MITTE.media)).toBeInViewport();
    // Stepping does not open the listing.
    await expect(search.detail).toHaveCount(0);
  });

  test('dragging swipes to the next image without opening the listing', async ({
    page,
    search,
  }) => {
    await searchSale(search);
    const carousel = search
      .card(MITTE.title)
      .getByRole('region', { name: `Images of ${MITTE.title}` });
    await carousel.scrollIntoViewIfNeeded();
    const box = await carousel.boundingBox();
    if (box === null) throw new Error('carousel has no box');
    const y = box.y + box.height / 2;
    const drag = async (from: number, to: number, dy = 0) => {
      await page.mouse.move(from, y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++)
        await page.mouse.move(from + ((to - from) * i) / 8, y + (dy * i) / 8);
      await page.mouse.up();
    };
    const image = (n: number) =>
      carousel.getByRole('img', { name: `${MITTE.title} – image ${n} of ${MITTE.media}` });

    // Too short (below the 15 % / 40 px threshold): stays, and does not count as a click.
    await drag(box.x + box.width * 0.6, box.x + box.width * 0.6 - 20);
    await expect(image(1)).toBeInViewport();
    // A real swipe to the left shows the next image.
    await drag(box.x + box.width * 0.8, box.x + box.width * 0.2);
    await expect(image(2)).toBeInViewport();
    // Mostly vertical movement is a scroll, not a swipe.
    await drag(box.x + box.width * 0.5, box.x + box.width * 0.5 - 30, 120);
    await expect(image(2)).toBeInViewport();
    await expect(search.detail).toHaveCount(0);
  });

  test('swiping with a finger on a phone @touch', async ({ page, search }) => {
    await searchSale(search);
    const carousel = search
      .card(MITTE.title)
      .getByRole('region', { name: `Images of ${MITTE.title}` });
    await carousel.scrollIntoViewIfNeeded();
    const box = await carousel.boundingBox();
    if (box === null) throw new Error('carousel has no box');
    const cdp = await page.context().newCDPSession(page);
    const y = box.y + box.height / 2;
    const point = (x: number) => [{ x, y, id: 1 }];
    const from = box.x + box.width * 0.85;
    const to = box.x + box.width * 0.15;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from) });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: point(from + ((to - from) * i) / 8),
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await expect(
      carousel.getByRole('img', { name: `${MITTE.title} – image 2 of ${MITTE.media}` }),
    ).toBeInViewport();
    await expect(search.detail).toHaveCount(0);
  });

  test('clicking the image opens the listing', async ({ search }) => {
    await searchSale(search);
    await search
      .card(MITTE.title)
      .getByRole('img', { name: `${MITTE.title} – image 1 of ${MITTE.media}` })
      .click();
    await expect(search.detailHeading).toHaveText(MITTE.title);
  });

  test('an image that fails to load is replaced by a placeholder', async ({
    consoleGuard,
    page,
    request,
    search,
  }) => {
    const body = (await (
      await request.get('/api/listings?offerType=SALE&pageSize=50', {
        headers: { 'Accept-Language': 'en' },
      })
    ).json()) as { items: { title: string; media: { url: string }[] }[] };
    const first = body.items.find((item) => item.title === MITTE.title)?.media[0]?.url;
    expect(first).toBeDefined();
    await page.route(first ?? '', (route) => route.fulfill({ status: 404 }));
    consoleGuard.allow(/Failed to load resource: .* 404 .*\/demo-media\//);

    await searchSale(search);
    await expect(
      search
        .card(MITTE.title)
        .getByRole('img', { name: `Image 1 of ${MITTE.media} could not be loaded` }),
    ).toBeVisible();
  });
});

test.describe('pager', () => {
  interface Item {
    id: string;
    title: string;
  }

  test('pages through more than 20 results (Search API responses mocked)', async ({
    page,
    search,
  }) => {
    const requests: URL[] = [];
    await page.route(
      (url) => url.pathname === '/api/listings',
      async (route) => {
        const url = new URL(route.request().url());
        requests.push(url);
        // The real API does not know the fake token: fetch the first page and reshape it.
        const upstream = new URL(url);
        upstream.searchParams.delete('pageToken');
        const real = await route.fetch({ url: upstream.toString() });
        const body = (await real.json()) as { items: Item[]; nextPageToken?: string };
        const template = body.items[0];
        if (template === undefined) throw new Error('demo search returned nothing');
        const page2 = url.searchParams.get('pageToken') === 'page-2';
        const count = page2 ? 3 : 20;
        const items = Array.from({ length: count }, (_, i) => ({
          ...template,
          id: `mock-${page2 ? 2 : 1}-${i + 1}`,
          title: `Mock listing ${page2 ? 21 + i : 1 + i}`,
        }));
        await route.fulfill({
          response: real,
          json: { ...body, items, ...(page2 ? {} : { nextPageToken: 'page-2' }) },
        });
      },
    );
    await search.goto({ offerType: 'SALE' });
    await expect(search.resultCards).toHaveCount(20);

    const pager = search.results.getByRole('navigation', { name: 'Result pages' });
    await expect(pager).toContainText('Page 1');
    await expect(pager.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await pager.getByRole('button', { name: 'Next page' }).click();

    await expect(pager).toContainText('Page 2');
    await expect(search.resultCards).toHaveCount(3);
    await expect(search.resultTitles.first()).toHaveText('Mock listing 21');
    await expect(pager.getByRole('button', { name: 'Next page' })).toBeDisabled();
    // Focus moves to the start of the list for keyboard users.
    await expect(search.results.getByRole('heading', { name: 'Search results' })).toBeFocused();
    expect(requests.at(-1)?.searchParams.get('pageToken')).toBe('page-2');
    expect(requests.at(-1)?.searchParams.get('pageSize')).toBe('20');

    await pager.getByRole('button', { name: 'Previous page' }).click();
    await expect(pager).toContainText('Page 1');
    await expect(search.resultTitles.first()).toHaveText('Mock listing 1');
  });
});
